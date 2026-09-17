import { LIMITS, PROVIDERS, type Provider } from "../shared/contracts";
import {
  canonicalAudioMime,
  detectedAudioMime,
  type AudioMime,
} from "../shared/audio-format";

export type AudioImport = { name: string; blob: Blob; mime: AudioMime };

export function readAudioFile(
  file: File,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const reader = new FileReader();
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      reader.onload = reader.onerror = reader.onabort = null;
    };
    const abort = () => {
      cleanup();
      reader.abort();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    reader.onload = () => {
      const result = reader.result;
      cleanup();
      if (result instanceof ArrayBuffer) resolve(result);
      else
        reject(
          new Error("This file could not be read. Choose another audio file."),
        );
    };
    reader.onerror = reader.onabort = () => {
      cleanup();
      reject(
        new Error("This file could not be read. Choose another audio file."),
      );
    };
    try {
      reader.readAsArrayBuffer(file);
    } catch {
      cleanup();
      reject(
        new Error("This file could not be read. Choose another audio file."),
      );
    }
  });
}

export async function inspectAudioFile(
  file: File,
  signal: AbortSignal,
  read: (
    file: File,
    signal: AbortSignal,
  ) => Promise<ArrayBuffer> = readAudioFile,
): Promise<AudioImport> {
  signal.throwIfAborted();
  if (!file.size)
    throw new Error(
      "This file is empty. Choose an audio file with a recording.",
    );
  if (file.size > LIMITS.maxAudioBytes)
    throw new Error("This file exceeds 500 MB. Choose a smaller audio file.");
  const bytes = new Uint8Array(await read(file, signal));
  signal.throwIfAborted();
  const mime = detectedAudioMime(bytes);
  if (!mime)
    throw new Error("Choose an MP3, M4A, WAV, WebM, or Ogg/Opus audio file.");
  const declared = file.type.split(";", 1)[0].trim().toLowerCase();
  if (
    declared &&
    declared !== "application/octet-stream" &&
    canonicalAudioMime(declared) !== mime
  )
    throw new Error(
      "The file contents do not match its audio format. Choose another file.",
    );
  return { name: file.name, blob: new Blob([bytes], { type: mime }), mime };
}
export function importDurationError(
  durationMs: number,
  provider: Provider,
): string | undefined {
  if (!Number.isFinite(durationMs) || durationMs <= 0)
    return "This file has no readable audio duration.";
  if (durationMs > PROVIDERS[provider].maxRecordingSeconds * 1000)
    return `${PROVIDERS[provider].label} supports up to ${PROVIDERS[provider].maxRecordingSeconds / 60} minutes per transcription. Choose another provider or a shorter file.`;
}
