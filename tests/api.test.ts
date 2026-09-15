import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { createApi } from "../src/server/api";
import { Store } from "../src/server/store";
import { migrate } from "../scripts/migrations.mjs";
import { randomUUID } from "node:crypto";
import { readBody } from "../src/server/http";
const config = {
  origin: "http://localhost:3210",
  databaseUrl: "libsql://example.turso.io",
  databaseToken: "private-db-value",
  googleKey: "private-google-value",
  mistralKey: "",
};
const model = { transcribe: vi.fn(), enhance: vi.fn() };
let db: Client;
let api: ReturnType<typeof createApi>;
const storeCalls = vi.fn();
function request(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request("http://localhost:3210/api" + path, {
    method,
    headers: {
      host: "localhost:3210",
      origin: config.origin,
      "x-voice-workbench": "1",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
beforeEach(async () => {
  db = createClient({ url: ":memory:" });
  await migrate(db, "db/migrations");
  const store = new Store(db);
  storeCalls.mockClear();
  model.transcribe.mockReset();
  model.enhance.mockReset();
  api = createApi({
    getConfig: () => config,
    getStore: () => {
      storeCalls();
      return store;
    },
    getModels: () => model,
    log: () => {},
  });
});
afterEach(() => db.close());
describe("Local API", () => {
  it("guards every declared route before body, model, or storage access", async () => {
    const routes = [
      ["/config", "GET"],
      ["/notes", "GET"],
      ["/notes/" + randomUUID(), "PUT"],
      ["/settings", "PUT"],
      ["/transcribe", "POST"],
      ["/enhance", "POST"],
      ["/missing", "GET"],
    ];
    for (const [path, method] of routes) {
      const response = await api(
        request(path, method, undefined, {
          origin: "http://untrusted.invalid",
        }),
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("forbidden_origin");
    }
    expect(storeCalls).not.toHaveBeenCalled();
  });
  it("requires Origin and the application header for writes", async () => {
    for (const key of ["origin", "x-voice-workbench"]) {
      const r = request("/settings", "PUT", {});
      r.headers.delete(key);
      expect((await api(r)).status).toBe(403);
    }
  });
  it("returns public availability without configuration values", async () => {
    const r = await api(request("/config"));
    const text = await r.text();
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(text).not.toContain("private-");
    expect(text).not.toContain("turso.io");
    expect(
      JSON.parse(text).providers.find((p: { id: string }) => p.id === "mistral")
        .available,
    ).toBe(false);
  });
  it("uses consistent routing, method, type, and field errors", async () => {
    for (const [r, status, code] of [
      [request("/missing"), 404, "api_not_found"],
      [request("/config", "POST", {}), 405, "method_not_allowed"],
      [request("/notes?unknown=1"), 400, "invalid_input"],
      [
        request("/settings", "PUT", {
          vocabulary: [],
          expectedRevision: 1,
          extra: true,
        }),
        400,
        "invalid_input",
      ],
      [
        request("/settings", "PUT", {}, { "content-type": "text/plain" }),
        415,
        "unsupported_content_type",
      ],
    ] as const) {
      const res = await api(r);
      expect(res.status).toBe(status);
      expect((await res.json()).error.code).toBe(code);
    }
  });
  it("supports create, read, conditional edit, conflict, and delete through one contract", async () => {
    const id = randomUUID();
    const body = {
      title: "Gedanke",
      originalText: "Noch nicht veröffentlichen.",
      body: "Noch nicht veröffentlichen.",
      provider: "google",
      model: "gemini-3.5-transcribe",
      mode: "verbatim",
      durationMs: 3000,
    };
    expect((await api(request("/notes/" + id, "PUT", body))).status).toBe(200);
    const edit = {
      title: "Fassung",
      body: "Zuerst prüfen.",
      expectedRevision: 1,
    };
    expect((await api(request("/notes/" + id, "PATCH", edit))).status).toBe(
      200,
    );
    const conflict = await api(request("/notes/" + id, "PATCH", edit));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).current.revision).toBe(2);
    const read = await api(request("/notes/" + id));
    expect((await read.json()).originalText).toBe(body.originalText);
    expect(
      (await api(request("/notes/" + id, "DELETE", { expectedRevision: 2 })))
        .status,
    ).toBe(204);
    expect((await api(request("/notes/" + id, "PUT", body))).status).toBe(410);
  });
  it("limits actual bytes without Content-Length", async () => {
    const r = new Request("http://localhost:3210", {
      method: "POST",
      body: "abcdef",
    });
    await expect(readBody(r, 5)).rejects.toMatchObject({
      code: "request_too_large",
    });
  });
  it("stops stalled bodies and releases the reader", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    const r = new Request("http://localhost:3210", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expect(readBody(r, 10, 10)).rejects.toMatchObject({
      code: "request_timeout",
    });
    expect(cancel).toHaveBeenCalled();
  });
});

function audioRequest(extra = false, invalid = false) {
  const bytes = new Uint8Array(44);
  if (!invalid) {
    bytes.set(new TextEncoder().encode("RIFF"));
    bytes.set(new TextEncoder().encode("WAVE"), 8);
  }
  const form = new FormData();
  form.set("audio", new Blob([bytes], { type: "audio/wav" }), "sample.wav");
  form.set("provider", "google");
  form.set("mode", "verbatim");
  form.set("vocabulary", JSON.stringify(["Begriff"]));
  if (extra) form.append("mode", "smart");
  return new Request("http://localhost:3210/api/transcribe", {
    method: "POST",
    headers: {
      host: "localhost:3210",
      origin: config.origin,
      "x-voice-workbench": "1",
    },
    body: form,
  });
}
describe("HTTP audio and resource handling", () => {
  it("normalizes a complete multipart request for the model adapter", async () => {
    model.transcribe.mockResolvedValue({
      text: "Test",
      provider: "google",
      model: "gemini-3.5-transcribe",
      mode: "verbatim",
    });
    const response = await api(audioRequest());
    expect(response.status).toBe(200);
    expect(model.transcribe.mock.calls[0][0]).toMatchObject({
      provider: "google",
      mode: "verbatim",
      vocabulary: ["Begriff"],
    });
    expect(model.transcribe.mock.calls[0][0].audio).toBeInstanceOf(Uint8Array);
  });
  it("rejects duplicate fields and unknown audio before calling the model", async () => {
    expect((await api(audioRequest(true))).status).toBe(400);
    expect((await api(audioRequest(false, true))).status).toBe(415);
    expect(model.transcribe).not.toHaveBeenCalled();
  });
  it("limits concurrency and releases slots after errors", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    model.enhance.mockImplementation(async () => {
      await wait;
      throw new Error("Not returned to user");
    });
    const first = api(
      request("/enhance", "POST", { text: "A", preset: "clean" }),
    );
    const second = api(
      request("/enhance", "POST", { text: "B", preset: "clean" }),
    );
    const third = await api(
      request("/enhance", "POST", { text: "C", preset: "clean" }),
    );
    expect(third.status).toBe(429);
    expect((await third.json()).error.code).toBe("busy");
    release();
    const done = await Promise.all([first, second]);
    expect(done.map((r) => r.status)).toEqual([500, 500]);
    model.enhance.mockResolvedValue({
      text: "Fertig",
      provider: "mistral",
      model: "mistral-small-latest",
      preset: "clean",
    });
    expect(
      (await api(request("/enhance", "POST", { text: "D", preset: "clean" })))
        .status,
    ).toBe(200);
  });
  it("preserves successful responses when diagnostics fail", async () => {
    const handle = createApi({
      getConfig: () => config,
      getStore: () => new Store(db),
      getModels: () => model,
      log: () => {
        throw new Error("logger unavailable");
      },
    });
    expect((await handle(request("/settings"))).status).toBe(200);
  });
});
