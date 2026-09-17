import {
  LIMITS,
  vocabularySchema,
  isVocabularyTermTextAllowed,
  type Settings,
} from "../shared/contracts";
import { sameVocabularyTerms } from "../shared/responses";

export type VocabularyInput = {
  terms: string[];
  pending: string;
  error: string;
  announcement: string;
};

export function hasPendingVocabulary(input: string) {
  return !!input.trim() || !isVocabularyTermTextAllowed(input);
}

export function prepareVocabularySave(
  terms: readonly string[],
  pending: string,
  base: Settings,
) {
  const value = commitVocabulary(terms, pending);
  const write =
    value.error || sameVocabularyTerms(value.terms, base.vocabulary)
      ? null
      : { vocabulary: value.terms, expectedRevision: base.revision };
  return { value, write };
}

const alphabetical = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true,
});
const spelling = new Intl.Collator("en", {
  sensitivity: "variant",
  numeric: true,
});

export function sortedVocabulary(terms: readonly string[]) {
  return [...terms].sort(
    (a, b) => alphabetical.compare(a, b) || spelling.compare(a, b),
  );
}

export function pasteVocabulary(
  input: string,
  pasted: string,
  start: number,
  end: number,
) {
  return input.slice(0, start) + pasted + input.slice(end);
}

export function commitVocabulary(
  terms: readonly string[],
  input: string,
): VocabularyInput {
  const next = new Set(terms);
  const rejected: string[] = [];
  let invalid = false;
  let full = false;
  let added = 0;
  let duplicates = 0;
  for (const raw of input.split(/[\r\n,\t]+/u)) {
    if (!isVocabularyTermTextAllowed(raw)) {
      rejected.push(raw);
      invalid = true;
      continue;
    }
    const term = raw.trim().normalize("NFC");
    if (!term) continue;
    const parsed = vocabularySchema.safeParse([term]);
    if (!parsed.success) {
      rejected.push(term);
      invalid = true;
    } else if (next.has(term)) {
      duplicates++;
    } else if (next.size >= LIMITS.maxVocabularyTerms) {
      rejected.push(term);
      full = true;
    } else {
      next.add(term);
      added++;
    }
  }
  const error = [
    invalid
      ? `Use at most ${LIMITS.maxVocabularyTermLength} characters per term, without control characters.`
      : "",
    full
      ? `Your vocabulary can contain up to ${LIMITS.maxVocabularyTerms} terms. Remove a term to make room.`
      : "",
    rejected.length
      ? "Unadded terms are still in the input. Nothing has been saved."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    terms: [...next],
    pending: rejected.join(","),
    error,
    announcement: [
      added ? `${added} ${added === 1 ? "term" : "terms"} added.` : "",
      duplicates ? `${duplicates} already in your vocabulary.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}
