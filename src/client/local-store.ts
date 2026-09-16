import { z } from "zod";
import {
  createNoteSchema,
  idSchema,
  isoSchema,
  modeSchema,
  noteSchema,
  providerSchema,
  revisionSchema,
  type Note,
} from "../shared/contracts";
import { errorCodeSchema, type ErrorCode } from "../shared/responses";
import {
  recordingConfirmation,
  sameRecordingSnapshot,
} from "./recording-recovery";
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
  errorCode?: ErrorCode;
  attemptId?: string;
  durable?: boolean;
  // RAM-only result that no longer owns the saved recording state.
  superseded?: boolean;
};
export type LocalRecord = Draft | Recording;
export function mergeLocalRecords(
  stored: LocalRecord[],
  live: LocalRecord[],
): LocalRecord[] {
  const key = (row: LocalRecord) =>
    row.kind === "draft" ? `draft:${row.draftId}` : `recording:${row.id}`;
  return [
    ...new Map(
      [...stored.map((row) => ({ ...row, durable: true })), ...live].map(
        (row) => [key(row), row],
      ),
    ).values(),
  ];
}
export function needsLocalAttention(row: LocalRecord) {
  return row.kind === "recording"
    ? row.state !== "cloud_confirmed" || row.durable === false
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
  errorCode: errorCodeSchema.optional(),
  attemptId: idSchema.optional(),
  durable: z.boolean().optional(),
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
async function changeRecording(
  id: string,
  update: (current: Recording | undefined) => Recording | null | undefined,
) {
  const db = await open();
  return new Promise<Recording | null | undefined>((resolve, reject) => {
    const tx = db.transaction("records", "readwrite");
    const store = tx.objectStore("records");
    const request = store.get(id);
    let next: Recording | null | undefined;
    request.onsuccess = () => {
      const parsed = recordingSchema.safeParse(request.result);
      if (request.result !== undefined && !parsed.success) return;
      const value = update(parsed.success ? parsed.data : undefined);
      if (value === null) {
        next = null;
        store.delete(id);
      } else if (value) {
        next = { ...value, durable: true };
        store.put(next, id);
      }
    };
    tx.oncomplete = () => resolve(next);
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? new Error("Recording storage failed"));
  });
}
export async function readRecording(id: string) {
  const value = await transaction("readonly", (store) => store.get(id));
  const parsed = recordingSchema.safeParse(value);
  return parsed.success ? { ...parsed.data, durable: true } : undefined;
}
export function secureRecordingCopy(record: Recording, allowCreate = false) {
  return changeRecording(record.id, (current) => {
    if (record.superseded) return;
    if (!current)
      return allowCreate && !record.attemptId && record.durable !== true
        ? record
        : undefined;
    if (sameRecordingSnapshot(current, record)) return record;
    // A successful result retained in RAM can finish its own pending attempt.
    if (
      current.attemptId === record.attemptId &&
      current.state === "transcribing" &&
      ["transcribed", "error", "unknown"].includes(record.state)
    )
      return record;
    return undefined;
  });
}
export function beginRecordingAttempt(expected: Recording) {
  return changeRecording(expected.id, (current) => {
    if (
      !current ||
      !sameRecordingSnapshot(current, expected) ||
      current.result ||
      current.state === "cloud_confirmed"
    )
      return;
    return {
      ...current,
      attemptId: crypto.randomUUID(),
      state: "transcribing",
      error: undefined,
      errorCode: undefined,
    };
  });
}
export async function removeRecordingSnapshot(expected: Recording) {
  return (
    (await changeRecording(expected.id, (current) =>
      !current || sameRecordingSnapshot(current, expected) ? null : undefined,
    )) === null
  );
}
export function completeRecordingAttempt(expected: Recording, next: Recording) {
  return changeRecording(expected.id, (current) =>
    current &&
    next.id === expected.id &&
    next.attemptId === expected.attemptId &&
    sameRecordingSnapshot(current, expected)
      ? next
      : undefined,
  );
}
// Read and confirm in one transaction: late cloud replies cannot overwrite
// a deleted recording or a newer local transcription attempt.
export async function confirmRecording(
  note: Note,
): Promise<Recording | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("records", "readwrite");
    const store = tx.objectStore("records");
    let confirmed: Recording | undefined;
    const request = store.get(note.id);
    request.onsuccess = () => {
      const parsed = recordingSchema.safeParse(request.result);
      if (parsed.success) confirmed = recordingConfirmation(parsed.data, note);
      if (confirmed) store.put(confirmed, note.id);
    };
    tx.oncomplete = () => resolve(confirmed);
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? new Error("Local recording confirmation failed"));
  });
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
