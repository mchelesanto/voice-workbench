import { describe, expect, it } from "vitest";
import {
  sameVocabularyTerms,
  classifySettingsConflict,
} from "../src/shared/responses";
import { LIMITS, vocabularySchema } from "../src/shared/contracts";
import {
  commitVocabulary,
  sortedVocabulary,
  pasteVocabulary,
  hasPendingVocabulary,
  prepareVocabularySave,
} from "../src/client/vocabulary-input";

describe("Vocabulary entry", () => {
  it("does not prepare a write for a pending exact or canonical duplicate", () => {
    const base = { vocabulary: ["Café"], revision: 7 };
    for (const pending of ["Café", " Cafe\u0301 "]) {
      const prepared = prepareVocabularySave(base.vocabulary, pending, base);
      expect(prepared.write).toBeNull();
      expect(prepared.value.pending).toBe("");
      expect(prepared.value.terms).toEqual(base.vocabulary);
    }
    expect(
      prepareVocabularySave(base.vocabulary, "New term", base).write,
    ).toEqual({ vocabulary: ["Café", "New term"], expectedRevision: 7 });
    expect(
      prepareVocabularySave(base.vocabulary, "bad\u000b", base).write,
    ).toBeNull();
    expect(prepareVocabularySave([], "", base).write).toEqual({
      vocabulary: [],
      expectedRevision: 7,
    });
  });
  it("keeps multiple raw rejections stable across repeated attempts", () => {
    const raw = "bad\u000b, evil\u000c";
    const first = commitVocabulary([], raw);
    expect(first.pending).toBe(raw);
    expect(commitVocabulary(first.terms, first.pending).pending).toBe(
      first.pending,
    );
  });

  it("ignores ordinary whitespace but protects rejected control-only input", () => {
    expect(hasPendingVocabulary(" ")).toBe(false);
    expect(hasPendingVocabulary("")).toBe(false);
    expect(hasPendingVocabulary("\u000b")).toBe(true);
    expect(hasPendingVocabulary("\u000c")).toBe(true);
    expect(hasPendingVocabulary("Word")).toBe(true);
  });
  it("retains forbidden edge controls before whitespace normalization", () => {
    for (const raw of ["\u000bterm\u000b", "\u000cterm\u000c", "\u000b"]) {
      expect(vocabularySchema.safeParse([raw]).success).toBe(false);
      const result = commitVocabulary([], raw);
      expect(result.terms).toEqual([]);
      expect(result.pending).toBe(raw);
      expect(result.error).toContain("control characters");
    }
  });

  it("confirms the same canonical term set without imposing an invisible order", () => {
    const vocabulary = ["Zulu", "Alpha"];
    const remote = ["Alpha", "Zulu"];
    expect(
      classifySettingsConflict(
        { vocabulary, expectedRevision: 1 },
        { vocabulary: remote, revision: 2 },
      ),
    ).toBe("confirmed");
    expect(vocabulary).toEqual(["Zulu", "Alpha"]);
    expect(remote).toEqual(["Alpha", "Zulu"]);
    expect(sameVocabularyTerms([" Café ", "Cafe\u0301"], ["Café"])).toBe(true);
    expect(sameVocabularyTerms(["Zulu", "Alpha"], ["Alpha"])).toBe(false);
    expect(sameVocabularyTerms(["Zulu", "Alpha"], ["Alpha", "zulu"])).toBe(
      false,
    );
    expect(sameVocabularyTerms([], [])).toBe(true);
  });

  it("keeps phrases and normalizes spelling without merging case variants", () => {
    const result = commitVocabulary(
      ["Café"],
      " Cafe\u0301, café\nVoice Workbench\tTurso ",
    );
    expect(result.terms).toEqual(["Café", "café", "Voice Workbench", "Turso"]);
    expect(result.pending).toBe("");
    expect(result.error).toBe("");
    expect(vocabularySchema.parse(result.terms)).toEqual(result.terms);
  });

  it("retains rejected entries for correction while accepting the valid ones", () => {
    const long = "x".repeat(81);
    const result = commitVocabulary(
      ["Existing"],
      `Good,${long},bad\u0000term,Also good`,
    );
    expect(result.terms).toEqual(["Existing", "Good", "Also good"]);
    expect(result.pending).toBe(`${long},bad\u0000term`);
    expect(result.error).toContain("80");
    expect(result.error).toContain("control characters");
  });

  it("never truncates an over-capacity paste and permits duplicates at capacity", () => {
    const terms = Array.from(
      { length: LIMITS.maxVocabularyTerms },
      (_, i) => `Term ${i}`,
    );
    const result = commitVocabulary(terms, "Term 0, Extra one, Extra two");
    expect(result.terms).toEqual(terms);
    expect(result.pending).toBe("Extra one,Extra two");
    expect(result.error).toContain(String(LIMITS.maxVocabularyTerms));
    expect(commitVocabulary(terms, "Term 0").error).toBe("");
    expect(terms).toHaveLength(LIMITS.maxVocabularyTerms);
  });

  it("accepts the length boundary after trim and NFC, including surrogate pairs", () => {
    const term = "é".repeat(80);
    expect(commitVocabulary([], ` ${"e\u0301".repeat(80)} `).terms).toEqual([
      term,
    ]);
    expect(commitVocabulary([], "😀".repeat(80)).terms).toEqual([
      "😀".repeat(80),
    ]);
    expect(commitVocabulary([], "😀".repeat(81)).pending).toBe("😀".repeat(81));
  });

  it("sorts only a copy, with numeric ordering and a stable case tie-breaker", () => {
    const terms = ["Term 10", "zebra", "Alpha", "Term 2", "alpha"];
    const original = [...terms];
    const sorted = sortedVocabulary(terms);
    expect(sorted).toEqual(["alpha", "Alpha", "Term 2", "Term 10", "zebra"]);
    expect(sortedVocabulary([...terms].reverse())).toEqual(sorted);
    expect(terms).toEqual(original);
  });

  it("replaces the selected input range on paste without losing its prefix or suffix", () => {
    expect(pasteVocabulary("My old term", "new, Second", 3, 6)).toBe(
      "My new, Second term",
    );
    expect(pasteVocabulary("Voice ", "Workbench", 6, 6)).toBe(
      "Voice Workbench",
    );
    const result = commitVocabulary(
      [],
      pasteVocabulary("My old term", "new, Second", 3, 6),
    );
    expect(result.terms).toEqual(["My new", "Second term"]);
  });

  it("commits the last pending phrase on save and handles an empty dictionary", () => {
    expect(commitVocabulary(["Turso"], "Last phrase").terms).toEqual([
      "Turso",
      "Last phrase",
    ]);
    expect(commitVocabulary([], " , \n\t ")).toMatchObject({
      terms: [],
      pending: "",
      error: "",
    });
  });
});
