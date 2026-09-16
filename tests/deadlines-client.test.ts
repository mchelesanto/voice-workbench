import { describe, it, expect, vi, afterEach } from "vitest";
import { createModels, type Transport } from "../src/server/models";
import { withModelSlot } from "../src/server/model-slots";
import { withBoundedBody } from "../src/server/http";
import { createApi } from "../src/server/api";
import { ApiError } from "../src/server/errors";
import {
  apiErrorSchema,
  classifySettingsConflict,
  classifyCreateReplay,
  classifyEditConflict,
  retryDecision,
} from "../src/shared/responses";
import { transcribe } from "ai";
import { MockTranscriptionModelV4 } from "ai/test";
const config = {
  origin: "http://localhost:3210",
  databaseUrl: "libsql://example.turso.io",
  databaseToken: "fixture",
  googleKey: "fixture",
  mistralKey: "fixture",
  fireworksKey: "fixture",
};
const input = {
  provider: "google" as const,
  mode: "verbatim" as const,
  audio: new Uint8Array(44),
  vocabulary: [],
};
afterEach(() => vi.useRealTimers());
describe("Deadlines and actual operation lifetime", () => {
  it("responds by the deadline while holding slots until completion", async () => {
    vi.useFakeTimers();
    const controls: {
      resolve: (value: { text: string }) => void;
      reject: (error: Error) => void;
      signal?: AbortSignal;
    }[] = [];
    const transport: Transport = {
      transcribe: (opts) =>
        new Promise((resolve, reject) =>
          controls.push({ resolve, reject, signal: opts.abortSignal }),
        ),
      generateText: vi.fn(),
    };
    const service = createModels(config, transport);
    const slots = { active: 0 };
    const first = withModelSlot(slots, (lease) =>
      service.transcribe(input, new AbortController().signal, lease),
    ).catch((e) => e);
    const second = withModelSlot(slots, (lease) =>
      service.transcribe(input, new AbortController().signal, lease),
    ).catch((e) => e);
    await vi.advanceTimersByTimeAsync(120001);
    expect(await first).toMatchObject({
      code: "provider_timeout",
      status: 504,
    });
    expect(await second).toMatchObject({ code: "provider_timeout" });
    expect(controls.every((c) => c.signal?.aborted)).toBe(true);
    expect(slots.active).toBe(2);
    await expect(
      withModelSlot(slots, async () => "unexpected"),
    ).rejects.toMatchObject({ code: "busy" });
    controls[0].resolve({ text: "Späte Antwort" });
    controls[1].reject(new Error("Späte Ablehnung"));
    await vi.advanceTimersByTimeAsync(0);
    expect(slots.active).toBe(0);
  });
  it("limits small chunks without requiring large payloads", async () => {
    let count = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array([1]));
        if (++count === 4) c.close();
      },
    });
    const request = new Request("http://localhost:3210", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expect(
      withBoundedBody(
        request,
        100,
        (body) => new Response(body).arrayBuffer(),
        1000,
        3,
      ),
    ).rejects.toMatchObject({ code: "request_too_fragmented" });
  });
  it("suppresses unrestricted warnings from the real SDK", async () => {
    const emit = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const fake = new MockTranscriptionModelV4({
      doGenerate: async () => ({
        text: "Test",
        segments: [],
        language: undefined,
        durationInSeconds: undefined,
        warnings: [{ type: "other", message: "Fixture mit privaten Details" }],
        response: { timestamp: new Date(), modelId: "fixture", headers: {} },
      }),
    });
    const service = createModels(config, {
      transcribe: (opts) => transcribe({ ...opts, model: fake }),
      generateText: vi.fn(),
    });
    await service.transcribe(input, new AbortController().signal);
    expect(emit).not.toHaveBeenCalled();
  });
});
describe("Shared client contract", () => {
  it("recognizes canonical settings replays and bounded retries", () => {
    expect(
      classifySettingsConflict(
        { vocabulary: [" Café ", "Café"], expectedRevision: 1 },
        { vocabulary: ["Café"], revision: 2 },
      ),
    ).toBe("confirmed");
    expect(
      retryDecision({ operation: "model", attempt: 0, networkFailure: true }),
    ).toBe("manual_cost_possible");
    expect(
      retryDecision({
        operation: "write",
        attempt: 0,
        code: "storage_unavailable",
        status: 503,
      }),
    ).toBe("once_same_payload");
    expect(
      retryDecision({
        operation: "write",
        attempt: 1,
        code: "storage_unavailable",
        status: 503,
      }),
    ).toBe("manual");
    expect(
      retryDecision({
        operation: "read",
        attempt: 0,
        code: "configuration_unavailable",
        status: 503,
      }),
    ).toBe("never");
  });
  it("routes configuration failures through request IDs and shared errors", async () => {
    const log = vi.fn();
    const handler = createApi({
      getConfig: () => {
        throw new ApiError("configuration_unavailable");
      },
      getStore: vi.fn(),
      getModels: vi.fn(),
      log,
    });
    const result = await handler(
      new Request("http://localhost:3210/api/config", {
        headers: { host: "localhost:3210" },
      }),
    );
    expect(result.headers.get("x-request-id")).toBeTruthy();
    expect(apiErrorSchema.parse(await result.json()).error.code).toBe(
      "configuration_unavailable",
    );
    expect(log).toHaveBeenCalled();
  });
});

it("returns safe field paths without echoing invalid values", async () => {
  const api = createApi({
    getConfig: () => config,
    getStore: vi.fn(),
    getModels: vi.fn(),
  });
  const response = await api(
    new Request(config.origin + "/api/settings", {
      method: "PUT",
      headers: {
        host: "localhost:3210",
        origin: config.origin,
        "x-voice-workbench": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        vocabulary: ["PRIVATE,VALUE"],
        expectedRevision: 1,
      }),
    }),
  );
  const error = apiErrorSchema.parse(await response.json());
  expect(error.error.issues?.[0].path).toEqual(["vocabulary", "0"]);
  expect(JSON.stringify(error)).not.toContain("PRIVATE");
});

it("distinguishes confirmed replays from newer versions and different origins", () => {
  const input = {
    title: "Alt",
    body: "Alt",
    originalText: "Original",
    provider: "google" as const,
    model: "gemini-3.5-transcribe",
    mode: "verbatim" as const,
    durationMs: 1,
  };
  const current = {
    ...input,
    id: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 2,
  };
  expect(classifyCreateReplay(input, current)).toBe("confirmed");
  expect(
    classifyCreateReplay(input, { ...current, body: "Fremde Fassung" }),
  ).toBe("conflict");
  expect(
    classifyCreateReplay(input, {
      ...current,
      originalText: "Andere Aufnahme",
    }),
  ).toBe("different_origin");
  expect(
    classifyEditConflict(
      { title: "Alt", body: "Alt", expectedRevision: 1 },
      current,
    ),
  ).toBe("confirmed");
  expect(
    classifyEditConflict(
      { title: "Alt", body: "Neu", expectedRevision: 1 },
      current,
    ),
  ).toBe("conflict");
});
