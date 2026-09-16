import "server-only";
import { canonicalAudioMime, detectedAudioMime } from "../shared/audio-format";
import { ApiError } from "./errors";
export function validateAudio(bytes: Uint8Array, declared: string): string {
  const type = detectedAudioMime(bytes);
  if (!type || type !== canonicalAudioMime(declared))
    throw new ApiError("unsupported_audio");
  return type;
}
