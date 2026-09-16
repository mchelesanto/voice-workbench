"use client";
import { useEffect, useRef, useState } from "react";
import { prepareAudioPlayback } from "./audio-playback";
export type PlaybackDuration = { sourceKey: string; durationMs: number };
export function AudioPlayer({
  blob,
  sourceKey,
  onDuration,
  onFailure,
  errorMessage = "This recording could not be played here. Download the audio to try another player.",
}: {
  blob: Blob;
  sourceKey: string;
  onDuration: (result: PlaybackDuration) => void;
  onFailure?: (sourceKey: string) => void;
  errorMessage?: string;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const [sourceBlob] = useState(blob);
  const [status, setStatus] = useState<"preparing" | "ready" | "error">(
    "preparing",
  );
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const controller = new AbortController();
    const url = URL.createObjectURL(sourceBlob);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      element.removeEventListener("error", fail);
      element.pause();
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(url);
    };
    const fail = () => {
      if (controller.signal.aborted) return;
      setStatus("error");
      controller.abort();
      release();
      onFailure?.(sourceKey);
    };
    element.addEventListener("error", fail);
    element.src = url;
    void prepareAudioPlayback(element, controller.signal)
      .then((seconds) => {
        if (controller.signal.aborted) return;
        if (element.error) return fail();
        onDuration({ sourceKey, durationMs: seconds * 1000 });
        setStatus("ready");
      })
      .catch(fail);
    return () => {
      controller.abort();
      release();
    };
  }, [sourceBlob, sourceKey, onDuration, onFailure]);
  return (
    <>
      <audio
        ref={ref}
        controls={status === "ready"}
        style={status === "ready" ? undefined : { display: "none" }}
        preload="auto"
        aria-label="Play this local recording"
      />
      {status === "preparing" && (
        <p className="field-hint" role="status">
          Preparing playback…
        </p>
      )}
      {status === "error" && (
        <p className="notice" role="status">
          {errorMessage}
        </p>
      )}
    </>
  );
}
