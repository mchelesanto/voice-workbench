import { detectMediaType } from "@ai-sdk/provider-utils";
import { LIMITS } from "./contracts";

export const AUDIO_FORMATS = {
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
} as const;
export type AudioMime = keyof typeof AUDIO_FORMATS;
const aliases: Record<string, string> = {
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/mp3": "audio/mpeg",
  "audio/x-mp3": "audio/mpeg",
  "audio/m4a": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "video/mp4": "audio/mp4",
  "audio/opus": "audio/ogg",
  "audio/x-opus": "audio/ogg",
  "application/ogg": "audio/ogg",
  "video/webm": "audio/webm",
};
export function canonicalAudioMime(mime: string): AudioMime | undefined {
  const essence = mime.split(";", 1)[0].trim().toLowerCase();
  const canonical = aliases[essence] ?? essence;
  return Object.hasOwn(AUDIO_FORMATS, canonical)
    ? (canonical as AudioMime)
    : undefined;
}
export function detectedAudioMime(bytes: Uint8Array): AudioMime | undefined {
  if (bytes.length > LIMITS.maxAudioBytes) return;
  if (bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51) {
    // ID3 metadata can include large cover art. Skip only its declared,
    // bounded extent, then verify an MPEG frame with the shared detector.
    if (bytes.length < 14 || ![2, 3, 4].includes(bytes[3]) || bytes[4] === 255)
      return;
    const reserved = bytes[3] === 2 ? 63 : bytes[3] === 3 ? 31 : 15;
    if (bytes[5] & reserved || bytes.slice(6, 10).some((byte) => byte & 128))
      return;
    let size = 0;
    for (const byte of bytes.subarray(6, 10)) size = size * 128 + byte;
    let offset = 10 + size;
    if (bytes[3] === 4 && bytes[5] & 16) {
      if (
        bytes[offset] !== 51 ||
        bytes[offset + 1] !== 68 ||
        bytes[offset + 2] !== 73 ||
        !bytes
          .subarray(3, 10)
          .every((byte, index) => bytes[offset + 3 + index] === byte)
      )
        return;
      offset += 10;
    }
    if (offset + 4 > bytes.length) return;
    const type = detectMediaType({
      data: bytes.subarray(offset, offset + 12),
      topLevelType: "audio",
    });
    return type === "audio/mpeg" ? type : undefined;
  }
  const type = detectMediaType({ data: bytes, topLevelType: "audio" });
  return type && Object.hasOwn(AUDIO_FORMATS, type)
    ? (type as AudioMime)
    : undefined;
}
export function audioExtension(mime: string): string {
  const type = canonicalAudioMime(mime);
  return type ? AUDIO_FORMATS[type] : "bin";
}
