import { describe, expect, it } from "vitest";
import type { Draft } from "../src/client/editor";
import type { Recording } from "../src/client/recording";
import {
  draftSchema,
  putLocal,
  mergeLocalRecords,
  needsLocalAttention,
  warnBeforeLeaving,
} from "../src/client/local-store";
import {
  TemporaryAudio,
  AUDIO_MEMORY_BUDGET,
} from "../src/client/temporary-audio";
import { captureContext } from "./capture-context";
const input = {
  generation: 1,
  areaId: null,
  title: "Recovery",
  body: "Keep my work",
  originalText: "Keep my work",
  provider: "google" as const,
  model: "gemini-3.5-transcribe",
  mode: "verbatim" as const,
  durationMs: 1000,
};
const draft: Draft = {
  kind: "draft",
  draftId: "22222222-2222-4222-8222-222222222222",
  editorInstanceId: "33333333-3333-4333-8333-333333333333",
  noteId: "44444444-4444-4444-8444-444444444444",
  input,
  updatedAt: "2026-09-17T00:00:00.000Z",
  status: "error",
  baseRevision: 1,
  durable: true,
};
function recording(overrides: Partial<Recording> = {}): Recording {
  return {
    ...captureContext(),
    kind: "recording",
    blob: new Blob(["audio"]),
    mime: "audio/webm",
    durationMs: 1000,
    provider: "google",
    mode: "verbatim",
    state: "recorded",
    ...overrides,
  };
}
function retain(store: TemporaryAudio, row: Recording) {
  const token = store.reserve(row.blob.size);
  expect(store.retain(token, row)).toBe(true);
  return store.read(row.id)!;
}

describe("Text-only local boundary", () => {
  it("rejects audio and unknown nested fields before opening IndexedDB", () => {
    for (const candidate of [
      { ...draft, blob: new Blob(["audio"]) },
      { ...draft, input: { ...input, audio: "encoded bytes" } },
      {
        ...draft,
        refinement: { before: "A", applied: "B", blob: new Blob(["audio"]) },
      },
    ]) {
      expect(draftSchema.safeParse(candidate).success).toBe(false);
      expect(() => putLocal(candidate as Draft)).toThrow();
    }
    expect(draftSchema.parse(draft)).toEqual(draft);
  });
  it("shows live edits while retaining independent tab drafts", () => {
    const other = { ...draft, draftId: "55555555-5555-4555-8555-555555555555" };
    const live = {
      ...draft,
      input: { ...input, body: "Only in memory" },
      durable: false,
    };
    expect(mergeLocalRecords([draft, other], [live])).toEqual([live, other]);
  });
  it("warns only while text has no confirmed local or cloud copy", () => {
    const saved = {
      ...draft,
      status: "saved" as const,
      durable: false,
      localIssue: { kind: "persist" as const, message: "Local failure" },
    };
    expect(needsLocalAttention(saved)).toBe(true);
    expect(warnBeforeLeaving(saved)).toBe(false);
    expect(warnBeforeLeaving({ ...saved, status: "conflict" })).toBe(true);
    expect(
      warnBeforeLeaving({ ...saved, status: "conflict", durable: true }),
    ).toBe(false);
    expect(warnBeforeLeaving({ ...saved, status: "archived" })).toBe(true);
  });
});

describe("Temporary audio ownership", () => {
  it("retains multiple recordings without replacing an earlier unsaved capture", () => {
    const store = new TemporaryAudio();
    const a = retain(store, recording()),
      b = retain(store, recording());
    expect(store.snapshot().map((r) => r.id)).toEqual([a.id, b.id]);
    expect(store.bytes).toBe(a.blob.size + b.blob.size);
  });
  it("keeps removed audio absent after a late model result or cloud acknowledgement", () => {
    const store = new TemporaryAudio();
    const a = retain(store, recording());
    const pending = store.begin(a)!;
    expect(store.remove(pending)).toBe(true);
    expect(
      store.complete(pending, {
        ...pending,
        state: "transcribed",
        result: input,
      }),
    ).toBeUndefined();
    store.confirm({
      ...input,
      id: a.id,
      revision: 1,
      createdAt: a.createdAt,
      updatedAt: a.createdAt,
    });
    expect(store.snapshot()).toEqual([]);
  });
  it("rejects stale attempts and removal snapshots", () => {
    const store = new TemporaryAudio(),
      a = retain(store, recording());
    const first = store.begin(a)!;
    expect(store.begin(a)).toBeUndefined();
    const second = store.begin(first)!;
    expect(store.remove(first)).toBe(false);
    expect(
      store.complete(first, { ...first, state: "transcribed", result: input }),
    ).toBeUndefined();
    expect(
      store.complete(second, {
        ...second,
        state: "transcribed",
        result: input,
      }),
    ).toMatchObject({ result: input });
    store.confirm({
      ...input,
      id: a.id,
      revision: 2,
      body: "Later edited body",
      createdAt: a.createdAt,
      updatedAt: a.createdAt,
    });
    expect(store.read(a.id)).toMatchObject({
      state: "cloud_confirmed",
      textDurable: true,
      result: input,
    });
    expect(store.begin(store.read(a.id)!)).toBeUndefined();
  });
  it("preserves remote-reset audio read-only and discards it on local reset", () => {
    const store = new TemporaryAudio(),
      a = retain(store, recording());
    const pending = store.begin(a)!;
    store.quarantine();
    expect(store.read(a.id)?.readOnly).toBe(true);
    expect(store.begin(store.read(a.id)!)).toBeUndefined();
    expect(
      store.complete(pending, {
        ...pending,
        state: "transcribed",
        result: input,
      }),
    ).toBeUndefined();
    store.resume(2);
    expect(store.read(a.id)?.readOnly).toBe(true);
    store.clear();
    expect(store.bytes).toBe(0);
    expect(store.snapshot()).toEqual([]);
  });
  it("never releases another operation reservation from a late callback", () => {
    const store = new TemporaryAudio();
    const first = store.reserve(AUDIO_MEMORY_BUDGET);
    expect(() => store.reserve(1)).toThrow();
    store.release(first);
    const second = store.reserve(AUDIO_MEMORY_BUDGET);
    store.release(first);
    expect(() => store.reserve(1)).toThrow();
    store.release(second);
    expect(() => store.reserve(1)).not.toThrow();
  });
  it("retains late overshoot as salvage while blocking further work", () => {
    const store = new TemporaryAudio(),
      token = store.reserve(1);
    const blob = Object.defineProperty(new Blob(["salvage"]), "size", {
      value: AUDIO_MEMORY_BUDGET + 1,
    });
    const a = recording({ blob });
    expect(store.retain(token, a)).toBe(true);
    expect(() => store.reserve(1)).toThrow();
    expect(store.read(a.id)?.blob).toBe(blob);
    store.remove(store.read(a.id)!);
    expect(() => store.reserve(1)).not.toThrow();
  });
  it("rejects a capture completed after reset and freezes caller vocabulary", () => {
    const store = new TemporaryAudio(),
      token = store.reserve(100),
      words = ["Original"];
    const a = recording({ vocabulary: words });
    store.clear();
    expect(store.retain(token, a)).toBe(false);
    const b = retain(store, a);
    words.push("Changed");
    expect(b.vocabulary).toEqual(["Original"]);
  });
});
