import { z } from "zod";
import {
  areaSchema,
  libraryStateSchema,
  resetResolutionSchema,
  noteSchema,
  settingsSchema,
  summarySchema,
  providerSchema,
  modeSchema,
  LIMITS,
  vocabularySchema,
  type CreateNote,
  type Note,
  type EditNote,
  type Settings,
  type SettingsEdit,
} from "./contracts";

export const errorCodeSchema = z.enum([
  "library_reset",
  "reset_conflict",
  "reset_cancelled",
  "generation_exhausted",
  "area_name_conflict",
  "area_not_found",
  "forbidden_origin",
  "method_not_allowed",
  "api_not_found",
  "unsupported_content_type",
  "invalid_input",
  "request_too_fragmented",
  "request_too_large",
  "audio_too_large",
  "request_timeout",
  "request_aborted",
  "unsupported_audio",
  "unsupported_mode",
  "provider_unavailable",
  "provider_auth_failed",
  "provider_rate_limited",
  "busy",
  "provider_timeout",
  "no_transcript",
  "transcription_failed",
  "enhancement_failed",
  "enhancement_incomplete",
  "enhancement_input_too_long",
  "output_too_large",
  "storage_unavailable",
  "storage_timeout",
  "schema_unavailable",
  "configuration_unavailable",
  "note_not_found",
  "note_deleted",
  "id_conflict",
  "revision_conflict",
  "internal_error",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export const fieldIssueSchema = z.strictObject({
  path: z.array(z.string().max(80)).max(10),
  reason: z
    .string()
    .max(64)
    .regex(/^[a-z_]+$/),
});
export type FieldIssue = z.infer<typeof fieldIssueSchema>;
export const errorDetailSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().max(1000),
  issues: z.array(fieldIssueSchema).max(20).optional(),
});
export const conflictSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("note"), current: noteSchema }),
  z.strictObject({ kind: z.literal("settings"), current: settingsSchema }),
  z.strictObject({ kind: z.literal("area"), current: areaSchema }),
  z.strictObject({ kind: z.literal("library"), current: libraryStateSchema }),
  z.strictObject({ kind: z.literal("reset"), current: resetResolutionSchema }),
]);
export type Conflict = z.infer<typeof conflictSchema>;
export const apiErrorSchema = z.strictObject({
  error: errorDetailSchema,
  conflict: conflictSchema.optional(),
});
export const noteConflictSchema = z.strictObject({
  error: errorDetailSchema,
  conflict: z.strictObject({ kind: z.literal("note"), current: noteSchema }),
});
export const settingsConflictSchema = z.strictObject({
  error: errorDetailSchema,
  conflict: z.strictObject({
    kind: z.literal("settings"),
    current: settingsSchema,
  }),
});
export const areaPageSchema = z.strictObject({ items: z.array(areaSchema) });
export const notePageSchema = z.strictObject({
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  items: z.array(summarySchema).max(50),
  nextCursor: z.string().max(512).nullable(),
});
export const configSchema = z.strictObject({
  providers: z.array(
    z.strictObject({
      id: providerSchema,
      label: z.string().max(80),
      model: z.string().max(100),
      available: z.boolean(),
      smartMode: z.boolean(),
      vocabulary: z.boolean(),
      maxVocabularyTerms: z.number().int().positive(),
      maxAudioBytes: z.number().int().positive(),
      maxRecordingSeconds: z.number().int().positive(),
    }),
  ),
  enhancementAvailable: z.boolean(),
  limits: z.strictObject({
    maxAudioBytes: z.number().int().positive(),
    maxEnhanceLength: z.number().int().positive(),
  }),
});
export const transcriptionResultSchema = z.strictObject({
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  text: z.string().min(1).max(LIMITS.maxTextLength),
  provider: providerSchema,
  model: z.string().min(1).max(100),
  mode: modeSchema,
});
export const enhancementResultSchema = z.strictObject({
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  text: z.string().min(1).max(LIMITS.maxTextLength),
  provider: z.literal("fireworks"),
  model: z.string().min(1).max(100),
  preset: z.enum(["clean", "bullets", "english"]),
});
export type ApiFailure = z.infer<typeof apiErrorSchema>;
export type AppConfig = z.infer<typeof configSchema>;

export function normalizeVocabulary(input: string[]) {
  return vocabularySchema.parse(input);
}
export function sameNoteOrigin(input: CreateNote, current: CreateNote) {
  const fields = [
    "generation",
    "originalText",
    "provider",
    "model",
    "mode",
    "durationMs",
  ] as const;
  return fields.every((field) => input[field] === current[field]);
}
export function classifyCreateReplay(
  input: CreateNote,
  current: Note,
): "confirmed" | "conflict" | "different_origin" {
  if (!sameNoteOrigin(input, current)) return "different_origin";
  return input.title === current.title &&
    input.body === current.body &&
    input.areaId === current.areaId
    ? "confirmed"
    : "conflict";
}
export function classifyEditConflict(
  input: EditNote,
  current: Note,
): "confirmed" | "conflict" {
  return input.generation === current.generation &&
    input.title === current.title &&
    input.body === current.body &&
    input.areaId === current.areaId
    ? "confirmed"
    : "conflict";
}
export function sameVocabularyTerms(local: string[], remote: string[]) {
  const canonical = normalizeVocabulary(local);
  const other = new Set(normalizeVocabulary(remote));
  return (
    canonical.length === other.size &&
    canonical.every((term) => other.has(term))
  );
}

export function classifySettingsConflict(
  input: SettingsEdit,
  current: Settings,
): "confirmed" | "conflict" {
  return sameVocabularyTerms(input.vocabulary, current.vocabulary)
    ? "confirmed"
    : "conflict";
}
export type RetryOperation = "model" | "read" | "write" | "reset";
export function retryDecision(input: {
  operation: RetryOperation;
  attempt: number;
  status?: number;
  code?: ErrorCode;
  networkFailure?: boolean;
}): "once_same_payload" | "manual" | "manual_cost_possible" | "never" {
  if (input.operation === "reset") return "manual";
  if (input.operation === "model") return "manual_cost_possible";
  if (
    input.code &&
    [
      "invalid_input",
      "unsupported_content_type",
      "forbidden_origin",
      "configuration_unavailable",
      "schema_unavailable",
      "method_not_allowed",
      "api_not_found",
    ].includes(input.code)
  )
    return "never";
  if (
    input.code &&
    [
      "library_reset",
      "reset_conflict",
      "reset_cancelled",
      "generation_exhausted",
      "area_name_conflict",
      "area_not_found",
      "revision_conflict",
      "id_conflict",
      "note_deleted",
      "note_not_found",
      "request_aborted",
      "request_timeout",
      "storage_timeout",
    ].includes(input.code)
  )
    return "manual";
  if (input.status === 408 || input.status === 504) return "manual";
  if (
    input.attempt === 0 &&
    (input.networkFailure ||
      input.code === "storage_unavailable" ||
      (input.status !== undefined &&
        input.status >= 500 &&
        input.status <= 599))
  )
    return "once_same_payload";
  return "manual";
}
