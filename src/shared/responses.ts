import { z } from "zod";
import {
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
export const apiErrorSchema = z.strictObject({
  error: errorDetailSchema,
  current: z.union([noteSchema, settingsSchema]).optional(),
});
export const noteConflictSchema = z.strictObject({
  error: errorDetailSchema,
  current: noteSchema,
});
export const settingsConflictSchema = z.strictObject({
  error: errorDetailSchema,
  current: settingsSchema,
});
export const notePageSchema = z.strictObject({
  items: z.array(summarySchema).max(50),
  nextCursor: z.string().max(256).nullable(),
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
  text: z.string().min(1).max(LIMITS.maxTextLength),
  provider: providerSchema,
  model: z.string().min(1).max(100),
  mode: modeSchema,
});
export const enhancementResultSchema = z.strictObject({
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
export function classifyCreateReplay(
  input: CreateNote,
  current: Note,
): "confirmed" | "conflict" | "different_origin" {
  const fields = [
    "originalText",
    "provider",
    "model",
    "mode",
    "durationMs",
  ] as const;
  if (fields.some((field) => input[field] !== current[field]))
    return "different_origin";
  return input.title === current.title && input.body === current.body
    ? "confirmed"
    : "conflict";
}
export function classifyEditConflict(
  input: EditNote,
  current: Note,
): "confirmed" | "conflict" {
  return input.title === current.title && input.body === current.body
    ? "confirmed"
    : "conflict";
}
export function classifySettingsConflict(
  input: SettingsEdit,
  current: Settings,
): "confirmed" | "conflict" {
  return JSON.stringify(normalizeVocabulary(input.vocabulary)) ===
    JSON.stringify(current.vocabulary)
    ? "confirmed"
    : "conflict";
}
export type RetryOperation = "model" | "read" | "write";
export function retryDecision(input: {
  operation: RetryOperation;
  attempt: number;
  status?: number;
  code?: ErrorCode;
  networkFailure?: boolean;
}): "once_same_payload" | "manual" | "manual_cost_possible" | "never" {
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
