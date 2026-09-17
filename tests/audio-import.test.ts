import { describe, it, expect, vi } from "vitest";
import {
  inspectAudioFile,
  importDurationError,
} from "../src/client/audio-import";
import { audioExtension, detectedAudioMime } from "../src/shared/audio-format";
import { validateAudio } from "../src/server/audio";
const wav = () => {
  const b = new Uint8Array(44);
  b.set(new TextEncoder().encode("RIFF"));
  b.set(new TextEncoder().encode("WAVE"), 8);
  return b;
};
const signal = () => new AbortController().signal;
const read = (file: File) => file.arrayBuffer();
describe("Local audio file inspection", () => {
  it("accepts a valid MP3 frame after a large ID3 tag without changing bytes", async () => {
    const size = 131073;
    const bytes = new Uint8Array(10 + size + 4);
    bytes.set([
      73,
      68,
      51,
      3,
      0,
      0,
      (size >>> 21) & 127,
      (size >>> 14) & 127,
      (size >>> 7) & 127,
      size & 127,
    ]);
    bytes.set([255, 251, 144, 100], 10 + size);
    expect(detectedAudioMime(bytes)).toBe("audio/mpeg");
    const result = await inspectAudioFile(
      new File([bytes], "tagged.mp3", { type: "audio/mpeg" }),
      signal(),
      read,
    );
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(bytes);
    expect(validateAudio(bytes, result.mime)).toBe("audio/mpeg");
  });
  it("accepts the platform MP3 alias while preserving content validation", async () => {
    const bytes = new Uint8Array([255, 251, 144, 100]);
    const result = await inspectAudioFile(
      new File([bytes], "voice.mp3", { type: "audio/x-mp3" }),
      signal(),
      read,
    );
    expect(result.mime).toBe("audio/mpeg");
  });
  it("accepts the registered WAV MIME alias", async () => {
    const result = await inspectAudioFile(
      new File([wav()], "test.wav", { type: "audio/vnd.wave" }),
      signal(),
      read,
    );
    expect(validateAudio(wav(), "audio/vnd.wave")).toBe(result.mime);
  });
  it.each(["", "application/octet-stream", "audio/x-wav", "audio/wav"])(
    "recognizes WAV with browser MIME %s",
    async (type) => {
      const result = await inspectAudioFile(
        new File([wav()], "test.wav", { type }),
        signal(),
        read,
      );
      expect(result.mime).toBe("audio/wav");
      expect(result.blob.type).toBe("audio/wav");
      expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(wav());
    },
  );
  it("recognizes Ogg/Opus and uses the same server MIME contract", async () => {
    const bytes = new TextEncoder().encode("OggS12345678");
    const result = await inspectAudioFile(
      new File([bytes], "test.opus", { type: "audio/opus" }),
      signal(),
      read,
    );
    expect(result.mime).toBe("audio/ogg");
    expect(validateAudio(bytes, result.mime)).toBe("audio/ogg");
  });
  it("rejects misleading extensions and contradictory MIME before any upload", async () => {
    await expect(
      inspectAudioFile(
        new File(["not audio"], "fake.mp3", { type: "audio/mpeg" }),
        signal(),
        read,
      ),
    ).rejects.toThrow("Choose an MP3");
    await expect(
      inspectAudioFile(
        new File([wav()], "wrong.mp3", { type: "audio/mpeg" }),
        signal(),
        read,
      ),
    ).rejects.toThrow("do not match");
  });
  it("rejects empty and oversized files before reading", async () => {
    const reader = vi.fn();
    await expect(
      inspectAudioFile(new File([], "empty.wav"), signal(), reader),
    ).rejects.toThrow("empty");
    await expect(
      inspectAudioFile(
        Object.defineProperty(new File([], "large.wav"), "size", {
          value: 500_000_001,
        }),
        signal(),
        reader,
      ),
    ).rejects.toThrow("500 MB");
    expect(reader).not.toHaveBeenCalled();
  });
  it("ignores a read completed after cancellation", async () => {
    const controller = new AbortController();
    const reader = vi.fn(async () => {
      controller.abort();
      return wav().buffer;
    });
    await expect(
      inspectAudioFile(
        new File([wav()], "test.wav"),
        controller.signal,
        reader,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("accepts half-hour imports and enforces the selected provider duration", () => {
    for (const provider of ["google", "mistral"] as const) {
      expect(importDurationError(1800000, provider)).toBeUndefined();
      for (const ms of [0, NaN, Infinity])
        expect(importDurationError(ms, provider)).toBeDefined();
    }
    expect(importDurationError(3600000, "google")).toBeUndefined();
    expect(importDurationError(3600001, "google")).toContain("60 minutes");
    expect(importDurationError(3600001, "mistral")).toBeUndefined();
    expect(importDurationError(10800000, "mistral")).toBeUndefined();
    expect(importDurationError(10800001, "mistral")).toContain("180 minutes");
  });
  it.each([
    ["audio/mpeg", "mp3"],
    ["audio/wav", "wav"],
    ["audio/mp4", "m4a"],
    ["audio/ogg;codecs=opus", "ogg"],
    ["audio/webm;codecs=opus", "webm"],
  ])("uses the correct extension for %s", (type, extension) => {
    expect(audioExtension(type)).toBe(extension);
  });
});
