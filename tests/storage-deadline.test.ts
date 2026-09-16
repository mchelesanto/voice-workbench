import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../src/server/api";
import { Store } from "../src/server/store";
import {
  createRemoteStore,
  withStorageOperation,
} from "../src/server/storage-operation";
import { createClient } from "@libsql/client";
import { request as clientRequest } from "../src/client/api";
import { z } from "zod";
import { migrate } from "../scripts/migrations.mjs";
import { classifyEditConflict } from "../src/shared/responses";

const config = {
  origin: "http://localhost:3210",
  databaseUrl: "https://fixture.invalid",
  databaseToken: "fixture",
  googleKey: "",
  mistralKey: "",
  fireworksKey: "",
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("bounds an uncooperative storage operation and closes its resources", async () => {
  vi.useFakeTimers();
  let finish!: (value: string) => void;
  const release = vi.fn();
  const store = new Store({} as never, release);
  const pending = withStorageOperation(
    new AbortController().signal,
    () => store,
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(12001);
  expect(await pending).toMatchObject({ code: "storage_timeout", status: 504 });
  expect(release).toHaveBeenCalledTimes(1);
  finish("Late success");
  await vi.advanceTimersByTimeAsync(0);
});

it("does not open storage for a request canceled before dispatch", async () => {
  const controller = new AbortController();
  controller.abort();
  const factory = vi.fn();
  await expect(
    withStorageOperation(controller.signal, factory, vi.fn()),
  ).rejects.toMatchObject({ code: "request_aborted" });
  expect(factory).not.toHaveBeenCalled();
});

it("keeps a committed write replayable after its response deadline", async () => {
  vi.useFakeTimers();
  const db = createClient({ url: ":memory:" });
  try {
    await migrate(db, "db/migrations");
    const store = new Store(db);
    const id = "11111111-1111-4111-8111-111111111111";
    await store.create(id, {
      title: "Before",
      body: "Before",
      originalText: "Before",
      provider: "google",
      model: "gemini-3.5-transcribe",
      mode: "verbatim",
      durationMs: 1000,
    });
    const update = store.update.bind(store);
    let committed = false;
    let release!: () => void;
    vi.spyOn(store, "update").mockImplementationOnce(async (...args) => {
      const note = await update(...args);
      committed = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return note;
    });
    const api = createApi({
      getConfig: () => config,
      getStore: () => store,
      getModels: vi.fn(),
    });
    const body = { title: "After", body: "After", expectedRevision: 1 };
    const request = () =>
      new Request(config.origin + "/api/notes/" + id, {
        method: "PATCH",
        headers: {
          host: "localhost:3210",
          origin: config.origin,
          "x-voice-workbench": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const first = api(request());
    await vi.waitFor(() => expect(committed).toBe(true));
    await vi.advanceTimersByTimeAsync(12001);
    const timeout = await first;
    expect(timeout.status).toBe(504);
    expect((await timeout.json()).error.code).toBe("storage_timeout");
    const replay = await api(request());
    expect(replay.status).toBe(409);
    const current = (await replay.json()).current;
    expect(classifyEditConflict(body, current)).toBe("confirmed");
    expect((await store.get(id)).revision).toBe(2);
    release();
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    db.close();
  }
});

it("diagnoses an unprepared database without exposing SQL errors", async () => {
  const db = createClient({ url: ":memory:" });
  try {
    const store = new Store(db);
    await expect(store.settings()).rejects.toMatchObject({
      code: "schema_unavailable",
      message: "Prepare the database by running npm run db:migrate.",
    });
  } finally {
    db.close();
  }
});

it("stops a canceled API storage request even when the store ignores cancellation", async () => {
  const client = new AbortController();
  let received!: AbortSignal;
  let finish!: () => void;
  const db = createClient({ url: ":memory:" });
  const store = new Store(db, () => db.close());
  vi.spyOn(store, "list").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ items: [], nextCursor: null });
      }),
  );
  const api = createApi({
    getConfig: () => config,
    getModels: vi.fn(),
    getStore: (signal) => {
      received = signal;
      return store;
    },
  });
  const pending = api(
    new Request(config.origin + "/api/notes", {
      headers: { host: "localhost:3210" },
      signal: client.signal,
    }),
  );
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  client.abort();
  const response = await pending;
  expect(response.status).toBe(408);
  expect((await response.json()).error.code).toBe("request_aborted");
  expect(received.aborted).toBe(true);
  expect(db.closed).toBe(true);
  finish();
});

function settingsResponse(request: Request) {
  return request.json().then((body) =>
    Response.json({
      baton: null,
      base_url: null,
      results: body.requests.map((entry: { type: string }) => ({
        type: "ok",
        response:
          entry.type === "close"
            ? { type: "close" }
            : {
                type: "execute",
                result: {
                  cols: [
                    { name: "vocabulary_json", decltype: "TEXT" },
                    { name: "revision", decltype: "INTEGER" },
                  ],
                  rows: [
                    [
                      { type: "text", value: "[]" },
                      { type: "integer", value: "1" },
                    ],
                  ],
                  affected_row_count: 0,
                  last_insert_rowid: null,
                },
              },
      })),
    }),
  );
}

it("cancels only its own real LibSQL HTTP transport, leaving another request usable", async () => {
  const controls: Array<{
    request: Request;
    signal: AbortSignal;
    resolve: (response: Response) => void;
  }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (request: Request, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init.signal!;
          controls.push({ request, signal, resolve });
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    ),
  );
  const first = new AbortController(),
    second = new AbortController();
  const run = (signal: AbortSignal) =>
    withStorageOperation(
      signal,
      (scoped) => createRemoteStore(config, scoped),
      (store) => store.settings(),
    );
  const a = run(first.signal).catch((e) => e),
    b = run(second.signal);
  await vi.waitFor(() => expect(controls).toHaveLength(2));
  first.abort();
  expect(await a).toMatchObject({ code: "request_aborted" });
  expect(controls[0].signal.aborted).toBe(true);
  expect(controls[1].signal.aborted).toBe(false);
  controls[1].resolve(await settingsResponse(controls[1].request));
  expect(await b).toEqual({ vocabulary: [], revision: 1 });
});

it("bounds a stalled HTTP response body through the installed LibSQL client", async () => {
  vi.useFakeTimers();
  let transportSignal!: AbortSignal;
  let body!: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal(
    "fetch",
    vi.fn((_request: Request, init: RequestInit) => {
      transportSignal = init.signal!;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    }),
  );
  const result = withStorageOperation(
    new AbortController().signal,
    (signal) => createRemoteStore(config, signal),
    (store) => store.settings(),
  ).catch((e) => e);
  await vi.advanceTimersByTimeAsync(12001);
  expect(await result).toMatchObject({ code: "storage_timeout" });
  expect(transportSignal.aborted).toBe(true);
  body.error(new Error("Late body failure"));
  await vi.advanceTimersByTimeAsync(0);
});

it.each([502, 503])(
  "retries an unreadable data %s once with exactly the same payload",
  async (status) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("gateway failure", { status }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      clientRequest("/notes/fixture", z.object({ ok: z.boolean() }), {
        method: "PATCH",
        body: { body: "Keep", expectedRevision: 3 },
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
  },
);

it.each([408, 504])(
  "never automatically replays a data timeout (%s)",
  async (status) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("timeout", { status }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      clientRequest("/notes/fixture", z.object({ ok: z.boolean() }), {
        method: "PATCH",
        body: { body: "Keep", expectedRevision: 3 },
      }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
