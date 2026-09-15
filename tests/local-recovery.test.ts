import { afterEach, expect, it, vi } from "vitest";
import type { Draft } from "../src/client/editor";

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
async function storage(row: Draft) {
  vi.resetModules();
  const rows = new Map([[row.draftId, row]]);
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
  const { retireRecovered } = await import("../src/client/local-store");
  return { rows, modes, retireRecovered };
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
  expect(rows.get(source.draftId)?.input.body).toBe("A newer thought");
});
it("retires the exact source using one readwrite transaction", async () => {
  const { rows, modes, retireRecovered } = await storage(draft);
  await retireRecovered(source);
  expect(rows.has(source.draftId)).toBe(false);
  expect(modes).toEqual(["readwrite"]);
});
