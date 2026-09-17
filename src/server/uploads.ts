import "server-only";
import { ApiError } from "./errors";
import { requireType, withBoundedBody, parseInput } from "./http";
import { validateAudio } from "./audio";
import {
  LIMITS,
  PROVIDERS,
  transcriptionSchema,
  supportsMode,
  type TranscriptionInput,
} from "../shared/contracts";
export async function readTranscription(
  request: Request,
): Promise<TranscriptionInput> {
  requireType(request, "multipart/form-data");
  let form: FormData;
  try {
    form = await withBoundedBody(
      request,
      LIMITS.maxBodyBytes,
      (body) =>
        new Response(body, {
          headers: { "content-type": request.headers.get("content-type")! },
        }).formData(),
      LIMITS.audioBodyTimeoutMs,
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("invalid_input");
  }
  const allowed = ["audio", "provider", "mode", "vocabulary"];
  if (
    [...form.keys()].some((key) => !allowed.includes(key)) ||
    allowed.some((key) => form.getAll(key).length !== 1)
  )
    throw new ApiError("invalid_input");
  const file = form.get("audio"),
    vocabulary = form.get("vocabulary");
  if (
    !(file instanceof File) ||
    typeof vocabulary !== "string" ||
    new TextEncoder().encode(vocabulary).length > 32768 ||
    file.size === 0
  )
    throw new ApiError("invalid_input");
  if (file.size > LIMITS.maxAudioBytes) throw new ApiError("audio_too_large");
  let words: unknown;
  try {
    words = JSON.parse(vocabulary);
  } catch {
    throw new ApiError("invalid_input");
  }
  const input = parseInput(transcriptionSchema, {
    provider: form.get("provider"),
    mode: form.get("mode"),
    vocabulary: words,
  });
  if (!supportsMode(input.provider, input.mode))
    throw new ApiError("unsupported_mode");
  if (file.size > PROVIDERS[input.provider].maxAudioBytes)
    throw new ApiError("audio_too_large");
  const audio = new Uint8Array(await file.arrayBuffer());
  validateAudio(audio, file.type);
  return { ...input, audio };
}
