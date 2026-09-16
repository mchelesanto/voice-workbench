const events = [
  "loadedmetadata",
  "durationchange",
  "seeked",
  "timeupdate",
  "error",
] as const;

export function playbackSourceKey(recording: {
  id: string;
  createdAt: string;
  durationMs: number;
  mime: string;
  blob: Blob;
}): string {
  // A recording UUID names one captured audio source. IndexedDB creates new
  // Blob wrappers on reads, even when that capture has not changed.
  return JSON.stringify([
    recording.id,
    recording.createdAt,
    recording.durationMs,
    recording.mime,
    recording.blob.size,
    recording.blob.type,
  ]);
}

function waitForMedia(
  media: HTMLMediaElement,
  ready: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      for (const event of events) media.removeEventListener(event, check);
      signal.removeEventListener("abort", check);
    };
    const check = () => {
      try {
        signal.throwIfAborted();
        if (media.error) throw new Error("Audio could not be loaded.");
        if (!ready()) return;
        cleanup();
        resolve();
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    for (const event of events) media.addEventListener(event, check);
    signal.addEventListener("abort", check, { once: true });
    check();
  });
}

/** Resolve missing container duration while paused, then restore the start. */
export async function prepareAudioPlayback(
  media: HTMLMediaElement,
  incoming: AbortSignal,
  timeoutMs = 15000,
): Promise<number> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new DOMException("Playback preparation timed out.", "TimeoutError"),
      ),
    timeoutMs,
  );
  const signal = AbortSignal.any([incoming, deadline.signal]);
  try {
    await waitForMedia(
      media,
      () => media.readyState >= 1 && !Number.isNaN(media.duration),
      signal,
    );
    if (media.duration === Infinity) {
      // MediaRecorder WebM may omit duration. Seeking beyond the end makes
      // the browser scan the local container and discover its actual end.
      media.currentTime = Number.MAX_SAFE_INTEGER;
      await waitForMedia(media, () => Number.isFinite(media.duration), signal);
      const beginning = media.seekable.length ? media.seekable.start(0) : 0;
      media.currentTime = beginning;
      await waitForMedia(
        media,
        () => !media.seeking && Math.abs(media.currentTime - beginning) < 0.1,
        signal,
      );
    }
    signal.throwIfAborted();
    if (!Number.isFinite(media.duration) || media.duration <= 0)
      throw new Error("Audio has no playable duration.");
    return media.duration;
  } finally {
    clearTimeout(timer);
  }
}
