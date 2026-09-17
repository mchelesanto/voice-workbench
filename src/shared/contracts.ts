import { z } from "zod";

export const LIMITS = {
  maxAudioBytes: 500_000_000,
  maxBodyBytes: 500_000_000 + 1024 * 1024,
  maxJsonBytes: 512 * 1024,
  maxBodyChunks: 65536,
  maxTitleLength: 160,
  maxVocabularyTerms: 1000,
  maxVocabularyTermLength: 80,
  maxTextLength: 100000,
  maxEnhanceLength: 12000,
  maxOutputTokens: 8192,
  bodyTimeoutMs: 20000,
  providerTimeoutMs: 120000,
  storageTimeoutMs: 12000,
  transcriptionTimeoutMs: 30 * 60 * 1000,
  audioBodyTimeoutMs: 60000,
} as const;
export const providerSchema = z.enum(["google", "mistral"]);
export const modeSchema = z.enum(["verbatim", "smart"]);
// Keep previously supported entries for saved and pending notes.
export const MODEL_HISTORY = {
  google: [{ model: "gemini-3.5-transcribe", modes: ["verbatim", "smart"] }],
  mistral: [
    { model: "voxtral-mini-2602", modes: ["verbatim"] },
    { model: "voxtral-mini-latest", modes: ["verbatim"] },
  ],
} as const;
export const PROVIDERS = {
  google: {
    ...MODEL_HISTORY.google[0],
    label: "Google",
    maxRecordingSeconds: 60 * 60,
    // The inline SDK request is base64 JSON, below Google's 100 MB limit.
    maxAudioBytes: 70 * 1024 * 1024,
    vocabulary: true,
    maxVocabularyTerms: 1000,
    key: "googleKey",
  },
  mistral: {
    ...MODEL_HISTORY.mistral[1],
    label: "Mistral",
    maxRecordingSeconds: 3 * 60 * 60,
    maxAudioBytes: 500_000_000,
    vocabulary: true,
    maxVocabularyTerms: 100,
    key: "mistralKey",
  },
} as const;
export const MODELS = {
  google: PROVIDERS.google.model,
  mistral: PROVIDERS.mistral.model,
  enhancement: "accounts/fireworks/models/glm-5p3-flash",
} as const;
export function supportsMode(
  provider: z.infer<typeof providerSchema>,
  mode: z.infer<typeof modeSchema>,
) {
  return (PROVIDERS[provider].modes as readonly string[]).includes(mode);
}
export const idSchema = z.uuid().transform((x) => x.toLowerCase());
export const revisionSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);
export function isVocabularyTermTextAllowed(value: string) {
  return !/[\u0000-\u001f\u007f-\u009f,]/u.test(value);
}
const word = z
  .string()
  .refine(isVocabularyTermTextAllowed)
  .transform((s) => s.trim().normalize("NFC"))
  .pipe(z.string().min(1).max(LIMITS.maxVocabularyTermLength));
export const vocabularySchema = z
  .array(word)
  .max(LIMITS.maxVocabularyTerms)
  .transform((words) => [...new Set(words)]);
export const transcriptionSchema = z
  .strictObject({
    provider: providerSchema,
    mode: modeSchema,
    vocabulary: vocabularySchema,
    generation: revisionSchema,
  })
  .refine(
    (value) =>
      value.vocabulary.length <= PROVIDERS[value.provider].maxVocabularyTerms,
    { path: ["vocabulary"], message: "Too many terms for this provider." },
  );
const fields = {
  generation: revisionSchema,
  areaId: idSchema.nullable(),
  title: z.string().max(LIMITS.maxTitleLength),
  originalText: z
    .string()
    .max(LIMITS.maxTextLength)
    .refine((s) => !!s.trim()),
  body: z.string().max(LIMITS.maxTextLength),
  provider: providerSchema,
  model: z.string().min(1).max(100),
  mode: modeSchema,
  durationMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
};
function compatible(input: {
  provider: "google" | "mistral";
  model: string;
  mode: "verbatim" | "smart";
}) {
  return MODEL_HISTORY[input.provider].some(
    (entry) =>
      entry.model === input.model &&
      (entry.modes as readonly string[]).includes(input.mode),
  );
}
export const createNoteSchema = z.strictObject(fields).refine(compatible);
export const editSchema = z.strictObject({
  generation: revisionSchema,
  areaId: idSchema.nullable(),
  title: fields.title,
  body: fields.body,
  expectedRevision: revisionSchema,
});
export const deleteSchema = z.strictObject({
  generation: revisionSchema,
  expectedRevision: revisionSchema,
});
export const settingsEditSchema = z.strictObject({
  vocabulary: vocabularySchema,
  expectedRevision: revisionSchema,
});
export const settingsSchema = z.strictObject({
  vocabulary: vocabularySchema,
  revision: revisionSchema,
});
export const isoSchema = z.string().refine((s) => {
  try {
    return new Date(s).toISOString() === s;
  } catch {
    return false;
  }
});
export const noteSchema = z
  .strictObject({
    ...fields,
    id: idSchema,
    createdAt: isoSchema,
    updatedAt: isoSchema,
    revision: revisionSchema,
  })
  .refine(compatible);
export const enhancementSchema = z.strictObject({
  generation: revisionSchema,
  text: z
    .string()
    .min(1)
    .refine((s) => s.length <= LIMITS.maxEnhanceLength)
    .refine((s) => !!s.trim()),
  preset: z.enum(["clean", "bullets", "english"]),
});
export type Provider = z.infer<typeof providerSchema>;
export type Mode = z.infer<typeof modeSchema>;
export type CreateNote = z.infer<typeof createNoteSchema>;
export type EditNote = z.infer<typeof editSchema>;
export type Note = z.infer<typeof noteSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type SettingsEdit = z.infer<typeof settingsEditSchema>;
export type Enhancement = z.infer<typeof enhancementSchema>;
export type TranscriptionInput = z.infer<typeof transcriptionSchema> & {
  audio: Uint8Array;
};
export type Transcription = {
  text: string;
  provider: Provider;
  model: string;
  mode: Mode;
};
export type EnhancedText = {
  text: string;
  provider: "fireworks";
  model: string;
  preset: Enhancement["preset"];
};
export type NoteSummary = Pick<
  Note,
  | "id"
  | "title"
  | "provider"
  | "mode"
  | "updatedAt"
  | "revision"
  | "generation"
  | "areaId"
> & { preview: string };
export type NotePage = {
  generation: number;
  items: NoteSummary[];
  nextCursor: string | null;
};

export const summarySchema = z.strictObject({
  generation: revisionSchema,
  areaId: idSchema.nullable(),
  id: idSchema,
  title: fields.title,
  preview: z.string().max(140),
  provider: providerSchema,
  mode: modeSchema,
  updatedAt: isoSchema,
  revision: revisionSchema,
});

export const generationQuerySchema = z
  .string()
  .max(16)
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(revisionSchema);
export const areaFilterSchema = z.union([
  z.literal("all"),
  z.literal("general"),
  idSchema,
]);
export type AreaFilter = z.infer<typeof areaFilterSchema>;
export const areaNameSchema = z
  .string()
  .transform((value) => value.trim().normalize("NFC").replace(/\s+/gu, " "))
  .refine((value) => value.length >= 1 && value.length <= 80);
export const createAreaSchema = z.strictObject({
  name: areaNameSchema,
  vocabulary: vocabularySchema,
});
export const editAreaSchema = createAreaSchema.extend({
  archived: z.boolean(),
  expectedRevision: revisionSchema,
});
export const areaSchema = createAreaSchema.extend({
  id: idSchema,
  revision: revisionSchema,
  createdAt: isoSchema,
  updatedAt: isoSchema,
  archivedAt: isoSchema.nullable(),
});
export const libraryStateSchema = z.strictObject({
  generation: revisionSchema,
  lastResetAt: isoSchema.nullable(),
});
export const resetInputSchema = z.strictObject({
  operationId: idSchema,
  expectedGeneration: revisionSchema,
});
export const resetRequestSchema = resetInputSchema.extend({
  confirmation: z.literal("DELETE ALL NOTES"),
});
export const resetReceiptSchema = z
  .strictObject({
    operationId: idSchema,
    fromGeneration: revisionSchema,
    generation: revisionSchema,
    resetAt: isoSchema,
    deletedNoteCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .refine((v) => v.generation === v.fromGeneration + 1);
export const resetResolutionSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("completed"),
    receipt: resetReceiptSchema,
  }),
  resetInputSchema.extend({ state: z.literal("cancelled") }),
]);
export type Area = z.infer<typeof areaSchema>;
export type CreateArea = z.infer<typeof createAreaSchema>;
export type EditArea = z.infer<typeof editAreaSchema>;
export type LibraryState = z.infer<typeof libraryStateSchema>;
export type ResetInput = z.infer<typeof resetInputSchema>;
export type ResetReceipt = z.infer<typeof resetReceiptSchema>;
export type ResetResolution = z.infer<typeof resetResolutionSchema>;
export function effectiveVocabulary(
  globalWords: readonly string[],
  areaWords: readonly string[],
) {
  return [...new Set([...globalWords, ...areaWords])];
}
