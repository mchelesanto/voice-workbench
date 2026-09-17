import { z } from "zod";
import {
  createNoteSchema,
  idSchema,
  isoSchema,
  modeSchema,
  noteSchema,
  providerSchema,
  revisionSchema,
  resetInputSchema,
  resetReceiptSchema,
  resetResolutionSchema,
  type ResetInput,
  type ResetReceipt,
  type ResetResolution,
} from "../shared/contracts";
import type { Draft } from "./editor";
import type { Recording, LegacyRecording } from "./recording";
export type { Recording, LegacyRecording } from "./recording";
export type LocalRecord = Draft | LegacyRecording;
export type VisibleRecord = Draft | Recording | LegacyRecording;
export type TabFence = { generation: number; localResetId: string | null };
export class LocalStateError extends Error {
  constructor(
    public code: "reset_pending" | "library_reset" | "local_unavailable",
    message: string,
  ) {
    super(message);
  }
}
const sourceSchema = z.strictObject({
  draftId: idSchema,
  updatedAt: isoSchema,
  input: createNoteSchema,
});
export const draftSchema = z.strictObject({
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
    "archived",
  ]),
  current: noteSchema.optional(),
  error: z.string().optional(),
  durable: z.boolean(),
  readOnly: z.boolean().optional(),
  archiveToken: idSchema.optional(),
  localIssue: z
    .strictObject({
      kind: z.enum(["persist", "cleanup", "discard"]),
      message: z.string().max(1000),
    })
    .optional(),
  restoredFrom: sourceSchema.optional(),
  recoveryAncestors: z.array(sourceSchema).optional(),
  refinement: z
    .strictObject({
      before: z.string().max(100000),
      applied: z.string().max(100000),
    })
    .optional(),
});
const pendingSchema = z
  .discriminatedUnion("phase", [
    resetInputSchema.extend({ phase: z.literal("prepared") }),
    resetInputSchema.extend({
      phase: z.literal("acknowledged"),
      receipt: resetReceiptSchema,
    }),
  ])
  .refine(
    (p) =>
      p.phase === "prepared" ||
      (p.operationId === p.receipt.operationId &&
        p.expectedGeneration === p.receipt.fromGeneration),
  );
const metadataSchema = z.strictObject({
  profileId: idSchema,
  observedGeneration: revisionSchema,
  initialized: z.boolean(),
  pendingReset: pendingSchema.nullable(),
  completedLocalResetId: idSchema.nullable(),
  legacyAudioTransition: z.enum(["pending", "complete"]),
});
export type LocalMetadata = z.infer<typeof metadataSchema>;
export type PendingReset = NonNullable<LocalMetadata["pendingReset"]>;
export type UnknownRecord = {
  key: IDBValidKey;
  snapshotToken: string;
};
const unavailable = () =>
  new LocalStateError(
    "local_unavailable",
    "Local storage could not complete the operation. Your data has not been confirmed saved.",
  );
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function audioRow(value: unknown) {
  return (
    isObject(value) && typeof Blob !== "undefined" && value.blob instanceof Blob
  );
}
function keyString(key: IDBValidKey) {
  return JSON.stringify(key, (_k, v) =>
    v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)) : v,
  );
}
function versionKey(key: IDBValidKey) {
  return `record-version:${keyString(key)}`;
}
function draftKey(d: Draft) {
  return d.archiveToken ? `archive:${d.archiveToken}` : d.draftId;
}
function legacyInput(value: unknown) {
  return isObject(value) ? { ...value, generation: 1, areaId: null } : value;
}
function upgradeDraft(value: unknown) {
  if (!isObject(value) || value.kind !== "draft") return;
  const source = (x: unknown) =>
    isObject(x) ? { ...x, input: legacyInput(x.input) } : x;
  const candidate = {
    ...value,
    input: legacyInput(value.input),
    ...(value.current ? { current: legacyInput(value.current) } : {}),
    ...(value.restoredFrom ? { restoredFrom: source(value.restoredFrom) } : {}),
    ...(Array.isArray(value.recoveryAncestors)
      ? { recoveryAncestors: value.recoveryAncestors.map(source) }
      : {}),
  };
  const parsed = draftSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}
let database: Promise<IDBDatabase> | undefined;
function open() {
  if (!database) {
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let rejected = false;
      const req = indexedDB.open("voice-workbench", 2);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const tx = req.transaction!;
        const records =
          event.oldVersion === 0
            ? db.createObjectStore("records")
            : tx.objectStore("records");
        const metadata = db.createObjectStore("metadata");
        const state: LocalMetadata = {
          profileId: crypto.randomUUID(),
          observedGeneration: 1,
          initialized: false,
          pendingReset: null,
          completedLocalResetId: null,
          legacyAudioTransition: "complete",
        };
        metadata.put(state, "state");
        const cursor = records.openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          const migrated = upgradeDraft(row.value);
          if (migrated) row.update(migrated);
          else {
            metadata.put(crypto.randomUUID(), versionKey(row.primaryKey));
            if (audioRow(row.value)) {
              state.legacyAudioTransition = "pending";
              metadata.put(state, "state");
            }
          }
          row.continue();
        };
      };
      req.onerror = () => {
        if (database === opening) database = undefined;
        reject(req.error ?? unavailable());
      };
      req.onblocked = () => {
        rejected = true;
        if (database === opening) database = undefined;
        reject(
          new LocalStateError(
            "local_unavailable",
            "Close older Voice Workbench tabs to finish the local storage upgrade.",
          ),
        );
      };
      req.onsuccess = () => {
        if (rejected) {
          req.result.close();
          return;
        }
        req.result.onversionchange = () => {
          req.result.close();
          if (database === opening) database = undefined;
        };
        resolve(req.result);
      };
    });
    database = opening;
  }
  return database;
}
type Context<T> = {
  records: IDBObjectStore;
  metadata: IDBObjectStore;
  state: LocalMetadata;
  setState: (next: LocalMetadata) => void;
  done: (value: T) => void;
  on: <V>(req: IDBRequest<V>, run: (value: V) => void) => void;
};
async function transaction<T>(
  mode: IDBTransactionMode,
  run: (ctx: Context<T>) => void,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["records", "metadata"], mode);
    let result: T;
    let failure: unknown;
    const abort = (error: unknown) => {
      failure = error;
      try {
        tx.abort();
      } catch {
        reject(error);
      }
    };
    const on = <V>(req: IDBRequest<V>, next: (value: V) => void) => {
      req.onsuccess = () => {
        try {
          next(req.result);
        } catch (error) {
          abort(error);
        }
      };
    };
    const records = tx.objectStore("records"),
      metadata = tx.objectStore("metadata");
    on(metadata.get("state"), (raw) => {
      const state = metadataSchema.parse(raw);
      run({
        records,
        metadata,
        state,
        on,
        setState: (next) => {
          metadata.put(metadataSchema.parse(next), "state");
        },
        done: (value) => {
          result = value;
        },
      });
    });
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () =>
      reject(failure ?? tx.error ?? unavailable());
  });
}
function unlocked(state: LocalMetadata) {
  if (state.pendingReset)
    throw new LocalStateError(
      "reset_pending",
      "Library cleanup is pending. Resolve it before changing content.",
    );
}
function current(state: LocalMetadata, generation: number) {
  unlocked(state);
  if (!state.initialized || state.observedGeneration !== generation)
    throw new LocalStateError(
      "library_reset",
      "This content belongs to an earlier library and is read-only.",
    );
}
function sameClaim(a: ResetInput | undefined | null, b: ResetInput) {
  return (
    a?.operationId === b.operationId &&
    a.expectedGeneration === b.expectedGeneration
  );
}
export function readMetadata() {
  return transaction<LocalMetadata>("readonly", (c) => c.done(c.state));
}
export function authorizeLocal(fence: TabFence) {
  return transaction<LocalMetadata>("readonly", (c) => {
    current(c.state, fence.generation);
    if (c.state.completedLocalResetId !== fence.localResetId)
      throw new LocalStateError(
        "library_reset",
        "This browser profile was cleared.",
      );
    c.done(c.state);
  });
}
export function putLocal(record: Draft) {
  const safe = draftSchema.parse(record);
  if (safe.readOnly || safe.archiveToken)
    throw new LocalStateError(
      "library_reset",
      "Read-only copies cannot be promoted to the current library.",
    );
  return transaction<void>("readwrite", (c) => {
    current(c.state, safe.input.generation);
    c.on(c.records.get(safe.draftId), (old) => {
      if (old !== undefined) {
        const existing = draftSchema.parse(old);
        if (
          existing.readOnly ||
          existing.archiveToken ||
          existing.input.generation !== safe.input.generation
        )
          throw unavailable();
      }
      c.records.put(safe, safe.draftId);
      c.done(undefined);
    });
  });
}
export function removeLocal(id: string, generation: number) {
  return transaction<void>("readwrite", (c) => {
    current(c.state, generation);
    c.on(c.records.get(id), (raw) => {
      if (raw === undefined) {
        c.done(undefined);
        return;
      }
      const row = draftSchema.parse(raw);
      if (row.input.generation !== generation) throw unavailable();
      c.records.delete(id);
      c.done(undefined);
    });
  });
}
export function retireRecovered(source: NonNullable<Draft["restoredFrom"]>) {
  return transaction<void>("readwrite", (c) => {
    current(c.state, source.input.generation);
    c.on(c.records.get(source.draftId), (raw) => {
      const parsed = draftSchema.safeParse(raw);
      if (
        parsed.success &&
        parsed.data.updatedAt === source.updatedAt &&
        JSON.stringify(parsed.data.input) ===
          JSON.stringify(createNoteSchema.parse(source.input))
      )
        c.records.delete(source.draftId);
      c.done(undefined);
    });
  });
}
export function prepareReset(operationId: string, expectedGeneration: number) {
  return transaction<PendingReset>("readwrite", (c) => {
    if (c.state.pendingReset) {
      c.done(c.state.pendingReset);
      return;
    }
    current(c.state, expectedGeneration);
    const pending: PendingReset = {
      ...resetInputSchema.parse({ operationId, expectedGeneration }),
      phase: "prepared",
    };
    c.setState({ ...c.state, pendingReset: pending });
    c.done(pending);
  });
}
export function acknowledgeReset(expected: ResetInput, receipt: ResetReceipt) {
  return transaction<boolean>("readwrite", (c) => {
    const safe = resetReceiptSchema.parse(receipt);
    if (
      safe.operationId !== expected.operationId ||
      safe.fromGeneration !== expected.expectedGeneration
    )
      throw unavailable();
    if (!sameClaim(c.state.pendingReset, expected)) {
      c.done(false);
      return;
    }
    c.setState({
      ...c.state,
      pendingReset: { ...expected, phase: "acknowledged", receipt: safe },
    });
    c.done(true);
  });
}
export function completeReset(expected: ResetInput) {
  return transaction<boolean>("readwrite", (c) => {
    const pending = c.state.pendingReset;
    if (!sameClaim(pending, expected) || pending?.phase !== "acknowledged") {
      c.done(false);
      return;
    }
    c.records.clear();
    c.metadata.clear();
    c.setState({
      ...c.state,
      observedGeneration: Math.max(
        c.state.observedGeneration,
        pending.receipt.generation,
      ),
      initialized: true,
      completedLocalResetId: pending.operationId,
      pendingReset: null,
      legacyAudioTransition: "complete",
    });
    c.done(true);
  });
}
export function releaseReset(
  expected: ResetInput,
  resolution: ResetResolution,
  repairConflict = false,
) {
  const safe = resetResolutionSchema.parse(resolution);
  const id =
    safe.state === "completed" ? safe.receipt.operationId : safe.operationId;
  const generation =
    safe.state === "completed"
      ? safe.receipt.fromGeneration
      : safe.expectedGeneration;
  if (
    id !== expected.operationId ||
    (!repairConflict &&
      (safe.state !== "cancelled" ||
        generation !== expected.expectedGeneration)) ||
    (repairConflict && generation === expected.expectedGeneration)
  )
    return Promise.reject(unavailable());
  return transaction<boolean>("readwrite", (c) => {
    if (
      !sameClaim(c.state.pendingReset, expected) ||
      c.state.pendingReset?.phase !== "prepared"
    ) {
      c.done(false);
      return;
    }
    c.setState({ ...c.state, pendingReset: null });
    c.done(true);
  });
}
export function reconcileLocal(
  generation: number,
  fence: TabFence,
  snapshots: Draft[] = [],
) {
  revisionSchema.parse(generation);
  return transaction<LocalMetadata>("readwrite", (c) => {
    unlocked(c.state);
    const target = Math.max(generation, c.state.observedGeneration);
    if (c.state.completedLocalResetId !== fence.localResetId) {
      c.done(c.state);
      return;
    }
    for (const raw of snapshots) {
      const row = draftSchema.parse(raw);
      if (
        !row.archiveToken ||
        !row.readOnly ||
        row.input.generation !== fence.generation ||
        row.input.generation >= target
      )
        throw unavailable();
      const key = draftKey(row);
      c.on(c.records.get(key), (existing) => {
        const copy = draftSchema.parse({ ...row, durable: true });
        if (existing === undefined) c.records.put(copy, key);
        else if (
          JSON.stringify(draftSchema.parse(existing)) !== JSON.stringify(copy)
        )
          throw unavailable();
      });
    }
    const next = { ...c.state, observedGeneration: target, initialized: true };
    if (!c.state.initialized || target !== c.state.observedGeneration)
      c.setState(next);
    c.done(next);
  });
}
export function removeArchived(expected: Draft) {
  return transaction<boolean>("readwrite", (c) => {
    unlocked(c.state);
    if (expected.input.generation >= c.state.observedGeneration)
      throw unavailable();
    const key = draftKey(expected);
    c.on(c.records.get(key), (raw) => {
      const parsed = draftSchema.safeParse(raw);
      if (!parsed.success) {
        c.done(false);
        return;
      }
      const displayed = draftSchema.parse({
        ...parsed.data,
        readOnly: true,
        status: "archived",
        durable: true,
      });
      if (
        JSON.stringify(displayed) !==
        JSON.stringify(draftSchema.parse({ ...expected, durable: true }))
      ) {
        c.done(false);
        return;
      }
      c.records.delete(key);
      c.done(true);
    });
  });
}
function legacyRecording(
  raw: unknown,
  key: IDBValidKey,
  token: string,
): LegacyRecording | undefined {
  if (
    !isObject(raw) ||
    raw.kind !== "recording" ||
    !(raw.blob instanceof Blob) ||
    typeof key !== "string"
  )
    return;
  const id = idSchema.safeParse(raw.id),
    stamp = isoSchema.safeParse(raw.createdAt),
    provider = providerSchema.safeParse(raw.provider),
    mode = modeSchema.safeParse(raw.mode);
  if (
    !id.success ||
    !stamp.success ||
    !provider.success ||
    !mode.success ||
    typeof raw.durationMs !== "number" ||
    !Number.isFinite(raw.durationMs)
  )
    return;
  const result = createNoteSchema.safeParse(legacyInput(raw.result));
  if (raw.result !== undefined && !result.success) return;
  return {
    kind: "recording",
    id: id.data,
    createdAt: stamp.data,
    provider: provider.data,
    mode: mode.data,
    blob: raw.blob,
    mime: raw.blob.type,
    durationMs: Math.max(0, raw.durationMs),
    state: result.success ? "transcribed" : "recorded",
    ...(result.success ? { result: result.data } : {}),
    generation: 1,
    areaId: null,
    areaLabel: "General",
    vocabulary: [],
    localResetId: null,
    legacy: true,
    readOnly: true,
    storageKey: key,
    snapshotToken: token,
  };
}
function transition<T>(c: Context<T>) {
  const cursor = c.records.openCursor();
  let audio = false;
  c.on(cursor, (row) => {
    if (row) {
      audio ||= audioRow(row.value);
      row.continue();
    } else
      c.setState({
        ...c.state,
        legacyAudioTransition: audio ? "pending" : "complete",
      });
  });
}
function extract<T>(c: Context<T>, row: LegacyRecording, done: () => void) {
  if (!row.result) {
    done();
    return;
  }
  const map = `legacy-result:${row.id}`;
  c.on(c.metadata.get(map), (existing) => {
    if (existing !== undefined) {
      idSchema.parse(existing);
      done();
      return;
    }
    const id = crypto.randomUUID();
    const draft: Draft = {
      kind: "draft",
      draftId: id,
      editorInstanceId: id,
      noteId: row.id,
      input: row.result!,
      baseRevision: null,
      updatedAt: row.createdAt,
      status: "archived",
      durable: true,
      readOnly: true,
    };
    c.records.add(draftSchema.parse(draft), id);
    c.metadata.put(id, map);
    done();
  });
}
export function extractLegacy(expected: LegacyRecording) {
  return transaction<void>("readwrite", (c) => {
    unlocked(c.state);
    c.on(c.metadata.get(versionKey(expected.storageKey)), (token) => {
      if (token !== expected.snapshotToken) throw unavailable();
      c.on(c.records.get(expected.storageKey), (raw) => {
        const row = legacyRecording(raw, expected.storageKey, token);
        if (!row) throw unavailable();
        extract(c, row, () => c.done(undefined));
      });
    });
  });
}
export function removeLegacy(expected: LegacyRecording) {
  return transaction<void>("readwrite", (c) => {
    unlocked(c.state);
    c.on(c.metadata.get(versionKey(expected.storageKey)), (token) => {
      if (token !== expected.snapshotToken) throw unavailable();
      c.on(c.records.get(expected.storageKey), (raw) => {
        const row = legacyRecording(raw, expected.storageKey, token);
        if (!row) throw unavailable();
        extract(c, row, () => {
          c.records.delete(expected.storageKey);
          c.metadata.delete(versionKey(expected.storageKey));
          transition(c);
          c.done(undefined);
        });
      });
    });
  });
}
export function removeUnknown(expected: UnknownRecord) {
  return transaction<void>("readwrite", (c) => {
    unlocked(c.state);
    c.on(c.metadata.get(versionKey(expected.key)), (token) => {
      if (token !== expected.snapshotToken) throw unavailable();
      c.on(c.records.get(expected.key), (raw) => {
        if (
          draftSchema.safeParse(raw).success ||
          legacyRecording(raw, expected.key, token)
        )
          throw unavailable();
        c.records.delete(expected.key);
        c.metadata.delete(versionKey(expected.key));
        transition(c);
        c.done(undefined);
      });
    });
  });
}
export function listLocal() {
  return transaction<{
    records: LocalRecord[];
    unknown: UnknownRecord[];
    metadata: LocalMetadata;
  }>("readwrite", (c) => {
    const records: LocalRecord[] = [],
      unknown: UnknownRecord[] = [];
    const cursor = c.records.openCursor();
    c.on(cursor, (row) => {
      if (!row) {
        c.done({
          records,
          unknown,
          metadata: c.state,
        });
        return;
      }
      const draft = draftSchema.safeParse(row.value);
      if (draft.success) {
        records.push(
          draft.data.input.generation < c.state.observedGeneration
            ? {
                ...draft.data,
                readOnly: true,
                status: "archived",
                durable: true,
              }
            : draft.data,
        );
        row.continue();
      } else
        c.on(c.metadata.get(versionKey(row.primaryKey)), (token) => {
          if (typeof token !== "string" && !c.state.pendingReset) {
            token = crypto.randomUUID();
            c.metadata.put(token, versionKey(row.primaryKey));
          }
          const legacy =
            typeof token === "string"
              ? legacyRecording(row.value, row.primaryKey, token)
              : undefined;
          if (legacy) records.push(legacy);
          else
            unknown.push({
              key: row.primaryKey,
              snapshotToken: typeof token === "string" ? token : "",
            });
          row.continue();
        });
    });
  });
}
export function mergeLocalRecords(
  stored: VisibleRecord[],
  live: VisibleRecord[],
): VisibleRecord[] {
  const key = (r: VisibleRecord) =>
    r.kind === "draft" ? `draft:${r.draftId}` : `recording:${r.id}`;
  return [...new Map([...stored, ...live].map((r) => [key(r), r])).values()];
}
export function needsLocalAttention(row: VisibleRecord) {
  return row.kind === "recording"
    ? !row.textDurable
    : row.status !== "saved" || !!row.localIssue;
}
export function warnBeforeLeaving(draft: Draft) {
  return draft.status !== "saved" && !draft.durable;
}
