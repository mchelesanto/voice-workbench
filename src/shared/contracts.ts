import { z } from "zod";

export const LIMITS = {
  maxAudioBytes: 25 * 1024 * 1024,
  maxBodyBytes: 26 * 1024 * 1024,
  maxJsonBytes: 512 * 1024,
  maxBodyChunks: 65536,
  maxTitleLength: 160,
  maxVocabularyTerms: 100,
  maxVocabularyTermLength: 80,
  maxRecordingSeconds: 600,
  maxTextLength: 100000,
  maxEnhanceLength: 12000,
  maxOutputTokens: 8192,
  bodyTimeoutMs: 20000,
  providerTimeoutMs: 120000,
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
    vocabulary: true,
    key: "googleKey",
  },
  mistral: {
    ...MODEL_HISTORY.mistral[1],
    label: "Mistral",
    vocabulary: true,
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
const word = z
  .string()
  .max(LIMITS.maxVocabularyTermLength)
  .refine((s) => !/[\u0000-\u001f\u007f-\u009f,]/u.test(s))
  .transform((s) => s.trim().normalize("NFC"))
  .pipe(z.string().min(1).max(LIMITS.maxVocabularyTermLength));
export const vocabularySchema = z
  .array(word)
  .max(LIMITS.maxVocabularyTerms)
  .transform((words) => [...new Set(words)]);
export const transcriptionSchema = z.strictObject({
  provider: providerSchema,
  mode: modeSchema,
  vocabulary: vocabularySchema,
});
const fields = {
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
  title: fields.title,
  body: fields.body,
  expectedRevision: revisionSchema,
});
export const deleteSchema = z.strictObject({
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
  "id" | "title" | "provider" | "mode" | "updatedAt" | "revision"
> & { preview: string };
export type NotePage = { items: NoteSummary[]; nextCursor: string | null };

export const summarySchema = z.strictObject({
  id: idSchema,
  title: fields.title,
  preview: z.string().max(140),
  provider: providerSchema,
  mode: modeSchema,
  updatedAt: isoSchema,
  revision: revisionSchema,
});
