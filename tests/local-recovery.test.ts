import { afterEach, expect, it, vi } from "vitest";
import type { Draft } from "../src/client/editor";
import {
  mergeLocalRecords,
  needsLocalAttention,
  warnBeforeLeaving,
  type LocalRecord,
  type Recording,
} from "../src/client/local-store";

const source = {
  draftId: "22222222-2222-4222-8222-222222222222",
  updatedAt: "2026-09-15T10:00:00.000Z",
  input: {
    title: "Recovery",
    body: "Keep my work",
    originalText: "Keep my work",
    provider: "google" as const,
    model: "gemini-3.5-transcribe",
    mode: "verbatim" as const,
    durationMs: 1000,
  },
};
const draft: Draft = {
  ...source,
  kind: "draft",
  editorInstanceId: "33333333-3333-4333-8333-333333333333",
  noteId: "44444444-4444-4444-8444-444444444444",
  status: "error",
  baseRevision: 1,
  durable: true,
};

// Model the storage boundary's request/commit events, not its cleanup decision.
async function storage(row: LocalRecord) {
  vi.resetModules();
  const rows = new Map([[row.kind === "draft" ? row.draftId : row.id, row]]);
  const modes: IDBTransactionMode[] = [];
  const db = {
    close: vi.fn(),
    transaction(_name: string, mode: IDBTransactionMode) {
      modes.push(mode);
      const tx = {
        objectStore() {
          return {
            get(key: string) {
              const request = {} as IDBRequest;
              queueMicrotask(() => {
                Object.assign(request, { result: rows.get(key) });
                request.onsuccess?.call(request, new Event("success"));
                queueMicrotask(() =>
                  tx.oncomplete?.call(tx, new Event("complete")),
                );
              });
              return request;
            },
            delete(key: string) {
              rows.delete(key);
              return {} as IDBRequest;
            },
            put(value: LocalRecord, key: string) {
              if (mode !== "readwrite")
                throw new DOMException("Read only", "ReadOnlyError");
              rows.set(key, value);
              return {} as IDBRequest;
            },
          };
        },
      } as unknown as IDBTransaction;
      return tx;
    },
  };
  vi.stubGlobal("indexedDB", {
    open() {
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() => {
        Object.assign(request, { result: db });
        request.onsuccess?.call(request, new Event("success"));
      });
      return request;
    },
  });
  const { retireRecovered, confirmRecording } =
    await import("../src/client/local-store");
  return { rows, modes, retireRecovered, confirmRecording };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it("preserves a newer recovery source even if its text is unchanged", async () => {
  const { rows, retireRecovered } = await storage({
    ...draft,
    updatedAt: "2026-09-15T10:00:01.000Z",
  });
  await retireRecovered(source);
  expect(rows.has(source.draftId)).toBe(true);
});
it("preserves a changed source even when its timestamp is unchanged", async () => {
  const { rows, retireRecovered } = await storage({
    ...draft,
    input: { ...draft.input, body: "A newer thought" },
  });
  await retireRecovered(source);
  expect(rows.get(source.draftId)).toMatchObject({
    input: { body: "A newer thought" },
  });
});
it("retires the exact source using one readwrite transaction", async () => {
  const { rows, modes, retireRecovered } = await storage(draft);
  await retireRecovered(source);
  expect(rows.has(source.draftId)).toBe(false);
  expect(modes).toEqual(["readwrite"]);
});

it("shows the live unsaved version while retaining other tab drafts", () => {
  const other = { ...draft, draftId: "55555555-5555-4555-8555-555555555555" };
  const live = {
    ...draft,
    input: { ...draft.input, body: "Only in memory" },
    durable: false,
    localIssue: { kind: "persist" as const, message: "Local failure" },
  };
  const merged = mergeLocalRecords([draft, other], [live]);
  expect(merged).toHaveLength(2);
  expect(
    merged.find((row) => row.kind === "draft" && row.draftId === draft.draftId),
  ).toEqual(live);
  expect(merged).toContainEqual(other);
});

it("keeps local warnings visible without pretending confirmed cloud text is at risk", () => {
  const saved = {
    ...draft,
    status: "saved" as const,
    durable: false,
    localIssue: { kind: "persist" as const, message: "Local failure" },
  };
  expect(needsLocalAttention(saved)).toBe(true);
  expect(warnBeforeLeaving(saved)).toBe(false);
  expect(warnBeforeLeaving({ ...saved, status: "deleted" })).toBe(true);
  expect(
    warnBeforeLeaving({ ...saved, status: "deleted", durable: true }),
  ).toBe(false);
  expect(warnBeforeLeaving({ ...saved, status: "conflict" })).toBe(true);
});

const audio: Recording = {
  kind: "recording",
  id: draft.noteId,
  blob: new Blob(["audio"]),
  mime: "audio/webm",
  durationMs: 1000,
  createdAt: source.updatedAt,
  provider: "google",
  mode: "verbatim",
  state: "transcribed",
  result: source.input,
};
const cloud = {
  ...source.input,
  id: audio.id,
  title: "Edited title",
  body: "Edited body",
  revision: 2,
  createdAt: source.updatedAt,
  updatedAt: source.updatedAt,
};
it("confirms the current stored recording in one committed readwrite transaction", async () => {
  const { rows, modes, confirmRecording } = await storage(audio);
  expect((await confirmRecording(cloud))?.state).toBe("cloud_confirmed");
  expect(rows.get(audio.id)).toMatchObject({
    state: "cloud_confirmed",
    result: source.input,
  });
  expect(modes).toEqual(["readwrite"]);
});
it("does not resurrect a recording removed before its cloud acknowledgement", async () => {
  const { rows, confirmRecording } = await storage(audio);
  rows.delete(audio.id);
  expect(await confirmRecording(cloud)).toBeUndefined();
  expect(rows.size).toBe(0);
});
it("preserves newer processing state read from storage at acknowledgement time", async () => {
  const { rows, confirmRecording } = await storage(audio);
  rows.set(audio.id, { ...audio, state: "transcribing" });
  expect(await confirmRecording(cloud)).toBeUndefined();
  expect(rows.get(audio.id)).toMatchObject({ state: "transcribing" });
});
