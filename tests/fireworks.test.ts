import { describe, it, expect, vi } from "vitest";
import { fireworksText } from "../src/server/fireworks";
import { createModels } from "../src/server/models";
import { MODELS } from "../src/shared/contracts";

const input = {
  system: "Preserve meaning. Return only the edited text.",
  prompt: "Erst prüfen, danach vielleicht freigeben. Nicht löschen.",
  abortSignal: new AbortController().signal,
};
const completion = (content: unknown = "Vorschlag", finish = "stop") => ({
  choices: [
    {
      finish_reason: finish,
      message: {
        role: "assistant",
        content,
        reasoning_content: "Private reasoning",
      },
    },
  ],
});
const config = {
  origin: "http://localhost:3210",
  databaseUrl: "libsql://example.turso.io",
  databaseToken: "fixture",
  googleKey: "",
  mistralKey: "",
  fireworksKey: "fixture-fireworks",
};

describe("Fireworks refinement", () => {
  it("accepts a valid response at the exact 2 MiB boundary", async () => {
    const body = { ...completion(), padding: "" };
    const prefixBytes = new TextEncoder().encode(
      JSON.stringify(body),
    ).byteLength;
    body.padding = "x".repeat(2 * 1024 * 1024 - prefixBytes);
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    expect(bytes.byteLength).toBe(2 * 1024 * 1024);
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 100));
          controller.enqueue(bytes.slice(100));
          controller.close();
        },
      }),
    );
    expect(
      await fireworksText(
        "fixture",
        input,
        vi.fn<typeof fetch>().mockResolvedValue(response),
      ),
    ).toEqual({ text: "Vorschlag" });
  });
  it("waits for error-body cancellation before releasing the transport", async () => {
    let finishCancel!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      finishCancel = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new ReadableStream({ cancel: () => cancellation }), {
        status: 500,
      }),
    );
    let settled = false;
    const pending = fireworksText("fixture", input, fetcher).catch((error) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finishCancel();
    expect(await pending).toMatchObject({ statusCode: 500 });
  });
  it("rejects legacy function calls even with a stop finish reason", async () => {
    const body = completion();
    Object.assign(body.choices[0].message, {
      function_call: { name: "example", arguments: "{}" },
    });
    await expect(
      fireworksText(
        "fixture",
        input,
        vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
      ),
    ).rejects.toMatchObject({ code: "enhancement_incomplete" });
  });
  it("rejects an oversized declared response before reading its stream", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
      { headers: { "Content-Length": String(2 * 1024 * 1024 + 1) } },
    );
    await expect(
      fireworksText(
        "fixture",
        input,
        vi.fn<typeof fetch>().mockResolvedValue(response),
      ),
    ).rejects.toMatchObject({ code: "output_too_large" });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each(["length", "tool_calls", "content_filter", "error"])(
    "rejects incomplete wire output %s before exposing partial text",
    async (finish) => {
      await expect(
        fireworksText(
          "fixture",
          input,
          vi
            .fn<typeof fetch>()
            .mockResolvedValue(Response.json(completion(null, finish))),
        ),
      ).rejects.toMatchObject({ code: "enhancement_incomplete" });
    },
  );
  it("accepts explicit null tool metadata", async () => {
    const body = completion();
    Object.assign(body.choices[0].message, { tool_calls: null });
    expect(
      await fireworksText(
        "fixture",
        input,
        vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
      ),
    ).toEqual({ text: "Vorschlag" });
  });
  it("sends one bounded request to the fixed provider with low reasoning", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(completion()));
    const result = await fireworksText("fixture-key", input, fetcher);
    expect(result).toEqual({ text: "Vorschlag" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
    expect(options).toMatchObject({
      method: "POST",
      redirect: "error",
      signal: input.abortSignal,
      headers: { Authorization: "Bearer fixture-key" },
    });
    expect(JSON.parse(String(options?.body))).toEqual({
      model: MODELS.enhancement,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
      max_tokens: 8192,
      reasoning_effort: "low",
      stream: false,
      n: 1,
    });
    expect(JSON.stringify(result)).not.toContain("reasoning");
  });
  it.each([
    [401, "provider_auth_failed"],
    [403, "provider_auth_failed"],
    [429, "provider_rate_limited"],
    [408, "provider_timeout"],
    [504, "provider_timeout"],
    [400, "enhancement_failed"],
    [500, "enhancement_failed"],
  ])("sanitizes HTTP %s without retrying", async (status, code) => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        status: Number(status),
      }),
    );
    const service = createModels(config, {
      transcribe: vi.fn(),
      generateText: (args) => fireworksText(config.fireworksKey, args, fetcher),
    });
    const error = await service
      .enhance({ text: input.prompt, preset: "clean" }, input.abortSignal)
      .catch((e) => e);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("fixture-fireworks");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each([
    null,
    {},
    { choices: [] },
    completion(null),
    completion(42),
    { choices: [...completion().choices, ...completion().choices] },
  ])("rejects malformed upstream responses", async (value) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(value));
    await expect(
      fireworksText("fixture", input, fetcher),
    ).rejects.toMatchObject({ code: "enhancement_failed" });
  });
  it("does not turn tool calls into a text suggestion", async () => {
    const body = completion();
    Object.assign(body.choices[0].message, { tool_calls: [{ id: "x" }] });
    await expect(
      fireworksText(
        "fixture",
        input,
        vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
      ),
    ).rejects.toMatchObject({ code: "enhancement_incomplete" });
  });
  it("bounds the response stream and cancels oversized output", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
          },
          cancel,
        }),
      ),
    );
    await expect(
      fireworksText("fixture", input, fetcher),
    ).rejects.toMatchObject({ code: "output_too_large" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("requires Fireworks independently of transcription providers", async () => {
    const generateText = vi.fn().mockResolvedValue({ text: "Vorschlag" });
    const available = createModels(config, {
      transcribe: vi.fn(),
      generateText,
    });
    expect(
      await available.enhance(
        { text: input.prompt, preset: "clean" },
        input.abortSignal,
      ),
    ).toMatchObject({
      provider: "fireworks",
      model: "accounts/fireworks/models/glm-5p3-flash",
    });
    const missing = createModels(
      { ...config, fireworksKey: "", mistralKey: "fixture-mistral" },
      { transcribe: vi.fn(), generateText },
    );
    await expect(
      missing.enhance(
        { text: input.prompt, preset: "clean" },
        input.abortSignal,
      ),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(generateText).toHaveBeenCalledTimes(1);
  });
  it("forwards cancellation through the actual HTTP transport", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );
    const service = createModels(config, {
      transcribe: vi.fn(),
      generateText: (args) => fireworksText(config.fireworksKey, args, fetcher),
    });
    const pending = service.enhance(
      { text: input.prompt, preset: "clean" },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "request_aborted" });
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
