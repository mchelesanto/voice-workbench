import "server-only";
import type { ErrorCode, FieldIssue } from "../shared/responses";
export type { ErrorCode } from "../shared/responses";
const definitions = {
  forbidden_origin: [403, "This request is not allowed."],
  method_not_allowed: [405, "This method is not available here."],
  api_not_found: [404, "This endpoint does not exist."],
  unsupported_content_type: [415, "This data format is not supported."],
  invalid_input: [400, "Please check the submitted values."],
  request_too_fragmented: [
    413,
    "The upload contains too many chunks. Please try again.",
  ],
  request_too_large: [413, "The request is too large."],
  audio_too_large: [
    413,
    "The recording exceeds 25 MiB. It remains available on this device.",
  ],
  request_timeout: [408, "The upload did not finish in time."],
  request_aborted: [
    408,
    "The request was canceled. Its outcome may be unknown.",
  ],
  unsupported_audio: [
    415,
    "The audio format was not recognized or does not match the file.",
  ],
  unsupported_mode: [400, "The selected provider does not support this mode."],
  provider_unavailable: [503, "This provider is not configured locally."],
  provider_auth_failed: [
    502,
    "The provider rejected the credentials. Please check the API key.",
  ],
  provider_rate_limited: [
    429,
    "The provider is not accepting more requests right now. Please try again later.",
  ],
  busy: [429, "Two model requests are already running. Please wait a moment."],
  provider_timeout: [
    504,
    "Processing took too long. Another attempt may incur an additional charge.",
  ],
  no_transcript: [
    422,
    "No usable transcript was produced. Your recording is still available.",
  ],
  transcription_failed: [
    502,
    "Transcription failed. Your recording is still available.",
  ],
  enhancement_failed: [502, "The text could not be refined."],
  enhancement_incomplete: [
    502,
    "Refining did not finish completely. Your text is unchanged.",
  ],
  enhancement_input_too_long: [
    400,
    "Refining supports up to 12,000 characters. You can still save and export.",
  ],
  output_too_large: [
    502,
    "The model response exceeds the supported text length.",
  ],
  storage_unavailable: [
    503,
    "The database is unavailable. Your local draft is still available.",
  ],
  storage_timeout: [
    504,
    "The database operation timed out. A write may already have completed. Check the cloud state before retrying manually.",
  ],
  schema_unavailable: [
    503,
    "Prepare the database by running npm run db:migrate.",
  ],
  configuration_unavailable: [
    503,
    "The local project configuration is missing or invalid.",
  ],
  note_not_found: [404, "The note was not found."],
  note_deleted: [
    410,
    "This note was deleted. You can save your draft as a new note.",
  ],
  id_conflict: [409, "This note ID already belongs to another recording."],
  revision_conflict: [
    409,
    "This note or setting has changed. Both versions remain available.",
  ],
  internal_error: [500, "The request could not be processed."],
} as const satisfies Record<ErrorCode, readonly [number, string]>;
export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    readonly current?: unknown,
    readonly issues?: FieldIssue[],
  ) {
    super(definitions[code][1]);
    this.name = "ApiError";
    this.status = definitions[code][0];
  }
}
