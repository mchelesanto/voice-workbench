import "server-only";
import { detectMediaType } from "@ai-sdk/provider-utils";
import { ApiError } from "./errors";
const ALLOWED = new Set([
  "audio/wav",
  "audio/ogg",
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
]);
const ALIASES: Record<string, string> = {
  "audio/x-wav": "audio/wav",
  "audio/mp3": "audio/mpeg",
  "audio/m4a": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
};
export function validateAudio(bytes: Uint8Array, declared: string): string {
  const essence = declared.split(";", 1)[0].trim().toLowerCase();
  const type = detectMediaType({ data: bytes, topLevelType: "audio" });
  if (!type || !ALLOWED.has(type) || type !== (ALIASES[essence] ?? essence))
    throw new ApiError("unsupported_audio");
  return type;
}
