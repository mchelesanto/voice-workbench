import { describe, it, expect } from "vitest";
import {
  createNoteSchema,
  editSchema,
  vocabularySchema,
} from "../src/shared/contracts";
import { validateAudio } from "../src/server/audio";
import { ApiError } from "../src/server/errors";
const note = {
  generation: 1,
  areaId: null,
  title: "Test",
  body: "Test",
  originalText: "Test",
  provider: "google",
  model: "gemini-3.5-transcribe",
  mode: "verbatim",
  durationMs: 1000,
};
describe("Validation contract", () => {
  it("validates vocabulary capacity after trim and NFC while rejecting raw controls", () => {
    expect(vocabularySchema.parse([" " + "a".repeat(80) + " "])).toEqual([
      "a".repeat(80),
    ]);
    expect(vocabularySchema.parse(["e\u0301".repeat(80)])).toEqual([
      "é".repeat(80),
    ]);
    expect(vocabularySchema.safeParse(["a".repeat(81)]).success).toBe(false);
    expect(vocabularySchema.safeParse(["\tterm"]).success).toBe(false);
  });
  it("rejects unknown fields and incompatible models", () => {
    expect(
      createNoteSchema.safeParse({ ...note, key: "ignored?" }).success,
    ).toBe(false);
    expect(
      createNoteSchema.safeParse({ ...note, provider: "mistral" }).success,
    ).toBe(false);
    expect(
      createNoteSchema.safeParse({
        ...note,
        provider: "mistral",
        model: "voxtral-mini-latest",
        mode: "smart",
      }).success,
    ).toBe(false);
  });
  it("preserves intentionally empty edits while requiring an original", () => {
    expect(createNoteSchema.safeParse({ ...note, body: "" }).success).toBe(
      true,
    );
    expect(
      createNoteSchema.safeParse({ ...note, originalText: "  " }).success,
    ).toBe(false);
    expect(
      createNoteSchema.safeParse({ ...note, title: "x".repeat(161) }).success,
    ).toBe(false);
  });
  it("requires safe positive revisions", () => {
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      expect(
        editSchema.safeParse({
          generation: 1,
          areaId: null,
          title: "A",
          body: "B",
          expectedRevision: revision,
        }).success,
      ).toBe(false);
    }
  });
  it("normalizes vocabulary without losing multiword terms", () => {
    expect(
      vocabularySchema.parse([" Café ", "Cafe\u0301", "Eigener Begriff"]),
    ).toEqual(["Café", "Eigener Begriff"]);
    for (const terms of [[""], ["a,b"], ["a\nb"], Array(1001).fill("a")])
      expect(vocabularySchema.safeParse(terms).success).toBe(false);
  });
});
describe("Bounded audio detection", () => {
  const wav = () => {
    const b = new Uint8Array(44);
    b.set(new TextEncoder().encode("RIFF"));
    b.set(new TextEncoder().encode("WAVE"), 8);
    return b;
  };
  it("recognizes WAV across MIME aliases and parameters", () => {
    expect(validateAudio(wav(), "audio/x-wav; charset=binary")).toBe(
      "audio/wav",
    );
  });
  it("prevents silent SDK fallback and MIME mismatches", () => {
    expect(() => validateAudio(new Uint8Array([1, 2, 3]), "audio/wav")).toThrow(
      ApiError,
    );
    expect(() => validateAudio(wav(), "audio/ogg")).toThrow(ApiError);
    expect(() => validateAudio(wav(), "text/plain")).toThrow(ApiError);
  });
  it("recognizes supported browser containers", () => {
    expect(
      validateAudio(
        new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]),
        "audio/webm;codecs=opus",
      ),
    ).toBe("audio/webm");
    expect(
      validateAudio(new TextEncoder().encode("OggS12345678"), "audio/ogg"),
    ).toBe("audio/ogg");
    expect(
      validateAudio(
        new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32]),
        "audio/x-m4a",
      ),
    ).toBe("audio/mp4");
  });
  it("rejects oversized ID3 prefixes", () => {
    const bytes = new Uint8Array(10);
    bytes.set([73, 68, 51, 4, 0, 0, 0, 16, 0, 0]);
    expect(() => validateAudio(bytes, "audio/mpeg")).toThrow(ApiError);
  });
});

it("rejects container signatures with a different SDK MIME classification", () => {
  expect(() =>
    validateAudio(new Uint8Array([0xff, 0xe7, 0, 0]), "audio/mpeg"),
  ).toThrow(ApiError);
  expect(() =>
    validateAudio(
      new Uint8Array([0, 0, 1, 24, 102, 116, 121, 112, 77, 52, 65, 32]),
      "audio/mp4",
    ),
  ).toThrow(ApiError);
});
