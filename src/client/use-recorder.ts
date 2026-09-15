"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Mode, Provider } from "../shared/contracts";
import type { Recording } from "./local-store";
export type RecorderPhase = "idle" | "permission" | "recording" | "stopping";
export function useRecorder(
  onReady: (recording: Recording, damaged: boolean) => void,
) {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const generation = useRef(0);
  const active = useRef(false);
  const tick = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const callback = useRef(onReady);
  useEffect(() => {
    callback.current = onReady;
  }, [onReady]);
  const release = useCallback(() => {
    clearInterval(tick.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);
  const stop = useCallback(() => {
    const current = recorder.current;
    if (current?.state === "recording") {
      setPhase("stopping");
      current.stop();
    }
  }, []);
  const cancelPermission = useCallback(() => {
    generation.current++;
    active.current = false;
    setPhase("idle");
  }, []);
  const start = useCallback(
    async (provider: Provider, mode: Mode) => {
      if (active.current) return;
      active.current = true;
      const ticket = ++generation.current;
      setError("");
      setElapsed(0);
      setPhase("permission");
      try {
        if (
          !navigator.mediaDevices?.getUserMedia ||
          typeof MediaRecorder === "undefined"
        )
          throw new Error("unsupported");
        const mime = [
          "audio/webm;codecs=opus",
          "audio/mp4",
          "audio/ogg;codecs=opus",
          "audio/webm",
        ].find((type) => MediaRecorder.isTypeSupported(type));
        if (!mime) throw new Error("unsupported");
        const source = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        if (ticket !== generation.current) {
          source.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = source;
        const current = new MediaRecorder(source, { mimeType: mime });
        recorder.current = current;
        const chunks: Blob[] = [];
        let bytes = 0,
          damaged = false;
        const started = performance.now();
        current.ondataavailable = (event) => {
          if (event.data.size) {
            chunks.push(event.data);
            bytes += event.data.size;
          }
          if (bytes >= 24 * 1024 * 1024) stop();
        };
        current.onerror = () => {
          damaged = true;
          setError(
            "Recording was interrupted. You can recover the captured audio.",
          );
          if (current.state !== "inactive") stop();
        };
        current.onstop = () => {
          const durationMs = Math.round(performance.now() - started);
          release();
          recorder.current = null;
          active.current = false;
          if (ticket !== generation.current) return;
          setPhase("idle");
          if (!chunks.length) {
            setError("No audio was captured. Please try again.");
            return;
          }
          callback.current(
            {
              kind: "recording",
              id: crypto.randomUUID(),
              blob: new Blob(chunks, { type: mime }),
              mime,
              durationMs,
              createdAt: new Date().toISOString(),
              provider,
              mode,
              state: "recorded",
            },
            damaged,
          );
        };
        current.start(250);
        setPhase("recording");
        tick.current = setInterval(() => {
          const ms = Math.round(performance.now() - started);
          setElapsed(ms);
          if (ms >= 600000) stop();
        }, 100);
      } catch (e) {
        if (ticket !== generation.current) return;
        release();
        active.current = false;
        setPhase("idle");
        setError(
          e instanceof DOMException && e.name === "NotAllowedError"
            ? "Microphone access is blocked. Allow it in your site settings, then try again."
            : e instanceof DOMException && e.name === "NotFoundError"
              ? "No microphone found. Connect a microphone, then try again."
              : "Recording could not start. Check your microphone and use a recent browser.",
        );
      }
    },
    [release, stop],
  );
  useEffect(
    () => () => {
      generation.current++;
      if (recorder.current?.state === "recording") recorder.current.stop();
      release();
    },
    [release],
  );
  return {
    phase,
    elapsed,
    error,
    start,
    stop,
    cancelPermission,
    clearError: () => setError(""),
  };
}
