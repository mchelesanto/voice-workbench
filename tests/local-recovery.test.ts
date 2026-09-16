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
  const {
    retireRecovered,
    confirmRecording,
    beginRecordingAttempt,
    completeRecordingAttempt,
    secureRecordingCopy,
    removeRecordingSnapshot,
  } = await import("../src/client/local-store");
  return {
    rows,
    modes,
    retireRecovered,
    confirmRecording,
    beginRecordingAttempt,
    completeRecordingAttempt,
    secureRecordingCopy,
    removeRecordingSnapshot,
  };
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

it("keeps a live RAM recording and transcript ahead of a stale stored attempt", () => {
  const live = {
    ...audio,
    durable: false,
    result: { ...source.input, body: "Completed only in RAM" },
  };
  const merged = mergeLocalRecords(
    [{ ...audio, state: "transcribing", result: undefined }],
    [live],
  );
  expect(merged).toEqual([live]);
  expect(needsLocalAttention(live)).toBe(true);
});
it("atomically rejects stale starts and completions across recording attempts", async () => {
  const initial: Recording = { ...audio, state: "recorded", result: undefined };
  const {
    rows,
    beginRecordingAttempt,
    completeRecordingAttempt,
    confirmRecording,
    secureRecordingCopy,
  } = await storage(initial);
  const first = (await beginRecordingAttempt(initial))!;
  expect(first.attemptId).toBeTruthy();
  expect(await beginRecordingAttempt(initial)).toBeUndefined();
  const second = (await beginRecordingAttempt(first))!;
  expect(second.attemptId).not.toBe(first.attemptId);
  const done = {
    ...second,
    state: "transcribed" as const,
    result: source.input,
  };
  expect((await completeRecordingAttempt(second, done))?.state).toBe(
    "transcribed",
  );
  await confirmRecording(cloud);
  expect(
    await completeRecordingAttempt(first, {
      ...first,
      state: "error",
      error: "Older request failed",
    }),
  ).toBeUndefined();
  expect(
    await secureRecordingCopy(
      {
        ...first,
        state: "transcribed",
        result: { ...source.input, body: "Old result" },
      },
      true,
    ),
  ).toBeUndefined();
  expect(rows.get(audio.id)).toMatchObject({
    state: "cloud_confirmed",
    attemptId: second.attemptId,
    result: source.input,
  });
});
it("does not recreate a recording deleted while its model request was pending", async () => {
  const initial: Recording = { ...audio, state: "recorded", result: undefined };
  const { rows, beginRecordingAttempt, completeRecordingAttempt } =
    await storage(initial);
  const pending = (await beginRecordingAttempt(initial))!;
  rows.delete(audio.id);
  expect(
    await completeRecordingAttempt(pending, {
      ...pending,
      state: "transcribed",
      result: source.input,
    }),
  ).toBeUndefined();
  expect(rows.has(audio.id)).toBe(false);
});
it("allows an explicit RAM result to finish only its own pending storage attempt", async () => {
  const initial: Recording = { ...audio, state: "recorded", result: undefined };
  const { beginRecordingAttempt, secureRecordingCopy } = await storage(initial);
  const pending = (await beginRecordingAttempt(initial))!;
  expect(
    (
      await secureRecordingCopy({
        ...pending,
        state: "transcribed",
        result: source.input,
      })
    )?.state,
  ).toBe("transcribed");
});

it("does not revive a deleted attempt through the explicit local-copy retry", async () => {
  const initial: Recording = { ...audio, state: "recorded", result: undefined };
  const { rows, beginRecordingAttempt, secureRecordingCopy } =
    await storage(initial);
  const pending = (await beginRecordingAttempt(initial))!;
  rows.delete(initial.id);
  expect(
    await secureRecordingCopy(
      { ...pending, state: "transcribed", result: source.input },
      true,
    ),
  ).toBeUndefined();
  expect(rows.size).toBe(0);
});
it("deletes only the displayed recording snapshot, preserving a newer attempt", async () => {
  const initial: Recording = { ...audio, state: "recorded", result: undefined };
  const { rows, beginRecordingAttempt, removeRecordingSnapshot } =
    await storage(initial);
  const newer = (await beginRecordingAttempt(initial))!;
  expect(await removeRecordingSnapshot(initial)).toBe(false);
  expect(rows.get(initial.id)).toMatchObject({ attemptId: newer.attemptId });
  expect(await removeRecordingSnapshot(newer)).toBe(true);
  expect(rows.size).toBe(0);
});
it("can save a never-persisted RAM recording but cannot recreate an already durable one", async () => {
  const initial: Recording = { ...audio, state: "recorded", result: undefined };
  const { rows, secureRecordingCopy } = await storage(initial);
  rows.delete(initial.id);
  expect(
    await secureRecordingCopy({ ...initial, durable: true }, true),
  ).toBeUndefined();
  expect((await secureRecordingCopy(initial, true))?.durable).toBe(true);
});

it.each(["transcribed", "cloud_confirmed"] as const)(
  "never claims a new model attempt for a completed %s recording",
  async (state) => {
    const completed: Recording = { ...audio, state };
    const { rows, beginRecordingAttempt } = await storage(completed);
    expect(await beginRecordingAttempt(completed)).toBeUndefined();
    expect(rows.get(audio.id)).toEqual(completed);
  },
);
