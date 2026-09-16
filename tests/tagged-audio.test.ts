import { describe, it, expect, vi } from "vitest";
const generated = vi.hoisted(() =>
  vi.fn(async (_options: unknown) => ({
    text: "Synthetic tagged audio.",
    segments: [],
    language: "en",
    durationInSeconds: 1,
    warnings: [],
    response: {},
  })),
);
vi.mock("@ai-sdk/google", () => ({
  createGoogle: () => ({
    transcription: () => ({
      specificationVersion: "v4",
      provider: "fixture",
      modelId: "gemini-3.5-transcribe",
      doGenerate: generated,
    }),
  }),
}));
import { createModels } from "../src/server/models";
import { detectedAudioMime } from "../src/shared/audio-format";
function tagged(size: number, footer = false) {
  const bytes = new Uint8Array(10 + size + (footer ? 10 : 0) + 4);
  bytes.set([
    73,
    68,
    51,
    footer ? 4 : 3,
    0,
    footer ? 16 : 0,
    (size >>> 21) & 127,
    (size >>> 14) & 127,
    (size >>> 7) & 127,
    size & 127,
  ]);
  if (footer) {
    bytes.set(bytes.subarray(0, 10), 10 + size);
    bytes.set([51, 68, 73], 10 + size);
  }
  bytes.set([255, 251, 144, 100], bytes.length - 4);
  return bytes;
}
describe("Tagged MP3 format across the SDK boundary", () => {
  it("preserves the complete file while overriding the SDK's WAV fallback", async () => {
    const audio = tagged(131073);
    const service = createModels({
      origin: "http://localhost:3210",
      databaseUrl: "libsql://example.turso.io",
      databaseToken: "fixture",
      googleKey: "fixture",
      mistralKey: "",
      fireworksKey: "",
    });
    const result = await service.transcribe(
      { audio, provider: "google", mode: "verbatim", vocabulary: [] },
      new AbortController().signal,
    );
    expect(result.text).toBe("Synthetic tagged audio.");
    expect(generated).toHaveBeenCalledTimes(1);
    expect(generated.mock.calls[0][0]).toMatchObject({
      mediaType: "audio/mpeg",
      audio,
    });
  });
  it("handles a v2.4 footer and rejects broken bounds, flags, and frame signatures", () => {
    expect(detectedAudioMime(tagged(131073, true))).toBe("audio/mpeg");
    const truncated = tagged(131073).slice(0, 50);
    expect(detectedAudioMime(truncated)).toBeUndefined();
    const highBit = tagged(10);
    highBit[6] = 128;
    expect(detectedAudioMime(highBit)).toBeUndefined();
    const flags = tagged(10);
    flags[5] = 1;
    expect(detectedAudioMime(flags)).toBeUndefined();
    const wrongFrame = tagged(10);
    wrongFrame.fill(0, wrongFrame.length - 4);
    expect(detectedAudioMime(wrongFrame)).toBeUndefined();
    const badFooter = tagged(10, true);
    badFooter[20] = 0;
    expect(detectedAudioMime(badFooter)).toBeUndefined();
  });
});
