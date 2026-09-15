import { z } from "zod";
import {
  createNoteSchema,
  idSchema,
  isoSchema,
  modeSchema,
  noteSchema,
  providerSchema,
  revisionSchema,
} from "../shared/contracts";
import type { Draft } from "./editor";
export type Recording = {
  kind: "recording";
  id: string;
  blob: Blob;
  mime: string;
  durationMs: number;
  createdAt: string;
  provider: "google" | "mistral";
  mode: "verbatim" | "smart";
  state:
    | "recorded"
    | "transcribing"
    | "unknown"
    | "error"
    | "transcribed"
    | "cloud_confirmed";
  result?: Draft["input"];
  error?: string;
};
export type LocalRecord = Draft | Recording;
export function mergeLocalRecords(
  stored: LocalRecord[],
  live: Draft[],
): LocalRecord[] {
  const key = (row: LocalRecord) =>
    row.kind === "draft" ? `draft:${row.draftId}` : `recording:${row.id}`;
  return [
    ...new Map(
      [
        ...stored.map((row) =>
          row.kind === "draft" ? { ...row, durable: true } : row,
        ),
        ...live,
      ].map((row) => [key(row), row]),
    ).values(),
  ];
}
export function needsLocalAttention(row: LocalRecord) {
  return row.kind === "recording"
    ? row.state !== "cloud_confirmed"
    : row.status !== "saved" || !!row.localIssue;
}
export function warnBeforeLeaving(draft: Draft) {
  return (
    draft.status !== "saved" && (draft.status !== "deleted" || !draft.durable)
  );
}
const draftSchema = z.object({
  kind: z.literal("draft"),
  draftId: idSchema,
  editorInstanceId: idSchema,
  noteId: idSchema,
  input: createNoteSchema,
  baseRevision: revisionSchema.nullable(),
  updatedAt: isoSchema,
  status: z.enum([
    "saved",
    "local",
    "saving",
    "local_error",
    "error",
    "conflict",
    "deleted",
    "deleting",
  ]),
  current: noteSchema.optional(),
  error: z.string().optional(),
  durable: z.boolean(),
  localIssue: z
    .object({
      kind: z.enum(["persist", "cleanup", "discard"]),
      message: z.string().max(1000),
    })
    .optional(),
  restoredFrom: z
    .object({
      draftId: idSchema,
      updatedAt: isoSchema,
      input: createNoteSchema,
    })
    .optional(),
  refinement: z
    .object({ before: z.string().max(100000), applied: z.string().max(100000) })
    .optional(),
  recoveryAncestors: z
    .array(
      z.object({
        draftId: idSchema,
        updatedAt: isoSchema,
        input: createNoteSchema,
      }),
    )
    .optional(),
});
const recordingSchema = z.object({
  kind: z.literal("recording"),
  id: idSchema,
  blob: z.custom<Blob>((x) => typeof Blob !== "undefined" && x instanceof Blob),
  mime: z.string(),
  durationMs: z.number().nonnegative(),
  createdAt: isoSchema,
  provider: providerSchema,
  mode: modeSchema,
  state: z.enum([
    "recorded",
    "transcribing",
    "unknown",
    "error",
    "transcribed",
    "cloud_confirmed",
  ]),
  result: createNoteSchema.optional(),
  error: z.string().max(1000).optional(),
});
let database: Promise<IDBDatabase> | undefined;
function open() {
  if (!database)
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("voice-workbench", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("records");
      };
      request.onerror = () => {
        database = undefined;
        reject(request.error);
      };
      request.onblocked = () => {
        database = undefined;
        reject(new Error("blocked"));
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          database = undefined;
        };
        resolve(request.result);
      };
    });
  return database;
}
async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("records", mode);
    const request = run(tx.objectStore("records"));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? new Error("local transaction failed"));
  });
}
export async function putLocal(record: LocalRecord) {
  await transaction("readwrite", (store) =>
    store.put(record, record.kind === "draft" ? record.draftId : record.id),
  );
}
export async function removeLocal(id: string) {
  await transaction("readwrite", (store) => store.delete(id));
}
// Delete only the exact recovered snapshot, never a newer edit from another tab.
export async function retireRecovered(
  source: NonNullable<Draft["restoredFrom"]>,
) {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("records", "readwrite");
    const store = tx.objectStore("records");
    const request = store.get(source.draftId);
    request.onsuccess = () => {
      const parsed = draftSchema.safeParse(request.result);
      if (
        parsed.success &&
        parsed.data.updatedAt === source.updatedAt &&
        Object.entries(source.input).every(
          ([key, value]) =>
            parsed.data.input[key as keyof Draft["input"]] === value,
        )
      )
        store.delete(source.draftId);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? new Error("Local recovery cleanup failed"));
  });
}
export async function listLocal(): Promise<{
  records: LocalRecord[];
  invalid: number;
}> {
  const rows: unknown[] = await transaction("readonly", (store) =>
    store.getAll(),
  );
  const records: LocalRecord[] = [];
  let invalid = 0;
  for (const row of rows) {
    const parsed = z.union([draftSchema, recordingSchema]).safeParse(row);
    if (parsed.success) records.push(parsed.data);
    else invalid++;
  }
  return { records, invalid };
}
