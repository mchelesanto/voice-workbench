import { describe, it, expect, vi } from "vitest";
import { createModels } from "../src/server/models";
import { LIMITS } from "../src/shared/contracts";
const config = {
  origin: "http://localhost:3210",
  databaseUrl: "libsql://example.turso.io",
  databaseToken: "test-only",
  googleKey: "test-google",
  mistralKey: "test-mistral",
};
const input = {
  audio: new Uint8Array(44),
  provider: "google" as const,
  mode: "verbatim" as const,
  vocabulary: ["Eigener Begriff"],
};
const signal = () => new AbortController().signal;
describe("Provider contract", () => {
  it("disables billable retries and maps vocabulary for each provider", async () => {
    const transcribe = vi
      .fn()
      .mockResolvedValue({ text: " Noch nicht veröffentlichen. " });
    const service = createModels(config, { transcribe, generateText: vi.fn() });
    const google = await service.transcribe(input, signal());
    expect(google.text).toBe("Noch nicht veröffentlichen.");
    expect(transcribe.mock.calls[0][0]).toMatchObject({
      maxRetries: 0,
      providerOptions: {
        google: { mode: "VERBATIM", customVocabulary: ["Eigener Begriff"] },
      },
    });
    await service.transcribe({ ...input, provider: "mistral" }, signal());
    expect(transcribe.mock.calls[1][0]).toMatchObject({
      maxRetries: 0,
      providerOptions: { mistral: { contextBias: ["Eigener_Begriff"] } },
    });
    expect(transcribe.mock.calls[1][0].abortSignal).toBeInstanceOf(AbortSignal);
  });
  it("does not offer empty or oversized transcripts as successful results", async () => {
    const transcribe = vi.fn().mockResolvedValue({ text: "   " });
    const service = createModels(config, { transcribe, generateText: vi.fn() });
    await expect(service.transcribe(input, signal())).rejects.toMatchObject({
      code: "no_transcript",
    });
    transcribe.mockResolvedValue({
      text: "x".repeat(LIMITS.maxTextLength + 1),
    });
    await expect(service.transcribe(input, signal())).rejects.toMatchObject({
      code: "output_too_large",
    });
  });
  it("maps provider errors without raw details or fallback", async () => {
    const transcribe = vi.fn();
    const service = createModels(config, { transcribe, generateText: vi.fn() });
    for (const [statusCode, code] of [
      [401, "provider_auth_failed"],
      [429, "provider_rate_limited"],
      [504, "provider_timeout"],
      [500, "transcription_failed"],
    ]) {
      transcribe.mockRejectedValue(
        Object.assign(new Error("Sensitive upstream details"), { statusCode }),
      );
      await expect(service.transcribe(input, signal())).rejects.toMatchObject({
        code,
      });
      try {
        await service.transcribe(input, signal());
      } catch (e) {
        expect(String(e)).not.toContain("Sensitive");
      }
    }
    expect(transcribe).toHaveBeenCalledTimes(8);
  });
  it("rejects unavailable and incompatible selections before SDK calls", async () => {
    const transcribe = vi.fn();
    const service = createModels(
      { ...config, googleKey: "" },
      { transcribe, generateText: vi.fn() },
    );
    await expect(service.transcribe(input, signal())).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    await expect(
      service.transcribe(
        { ...input, provider: "mistral", mode: "smart" },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "unsupported_mode" });
    expect(transcribe).not.toHaveBeenCalled();
  });
  it("does not start an already canceled request", async () => {
    const transcribe = vi.fn();
    const service = createModels(config, { transcribe, generateText: vi.fn() });
    await expect(
      service.transcribe(input, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "request_aborted" });
    expect(transcribe).not.toHaveBeenCalled();
  });
  it("offers only complete suggestions and preserves text as input", async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue({ text: "Vollständig", finishReason: "stop" });
    const service = createModels(config, { transcribe: vi.fn(), generateText });
    const source = "Zuerst prüfen, noch nicht veröffentlichen.";
    expect(
      (await service.enhance({ text: source, preset: "clean" }, signal())).text,
    ).toBe("Vollständig");
    expect(generateText.mock.calls[0][0]).toMatchObject({
      prompt: source,
      maxRetries: 0,
      maxOutputTokens: 8192,
    });
    expect(generateText.mock.calls[0][0]).not.toHaveProperty("tools");
    for (const finishReason of [
      "length",
      "other",
      "tool-calls",
      "content-filter",
      "error",
    ]) {
      generateText.mockResolvedValue({
        text: "Abgeschnittener Text",
        finishReason,
      });
      await expect(
        service.enhance({ text: source, preset: "clean" }, signal()),
      ).rejects.toMatchObject({ code: "enhancement_incomplete" });
    }
  });
});
