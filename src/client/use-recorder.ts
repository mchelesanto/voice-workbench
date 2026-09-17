"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Mode, Provider } from "../shared/contracts";
import type { Recording, CaptureContext } from "./recording";
import {
  RecorderController,
  initialRecorderState,
  type InputMeter,
} from "./recorder-controller";

function inputMeter(stream: MediaStream): InputMeter {
  const context = new AudioContext();
  try {
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    void context.resume().catch(() => {});
    let closed = false;
    return {
      read() {
        if (context.state !== "running") throw new Error("Meter unavailable");
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
        return Math.min(1, Math.sqrt(sum / samples.length) * 4);
      },
      close() {
        if (closed) return;
        closed = true;
        source.disconnect();
        analyser.disconnect();
        void context.close().catch(() => {});
      },
    };
  } catch (error) {
    void context.close().catch(() => {});
    throw error;
  }
}

export function useRecorder(
  onReady: (recording: Recording, damaged: boolean) => void,
  onAbandoned: (context: CaptureContext) => void,
) {
  const [state, setState] = useState(initialRecorderState);
  const controller = useRef<RecorderController | null>(null);
  const callback = useRef(onReady);
  const abandoned = useRef(onAbandoned);
  useEffect(() => {
    callback.current = onReady;
    abandoned.current = onAbandoned;
  }, [onReady, onAbandoned]);
  useEffect(() => {
    const current = new RecorderController(
      {
        stream: () => {
          if (!navigator.mediaDevices?.getUserMedia)
            return Promise.reject(new Error("Unsupported microphone"));
          return navigator.mediaDevices.getUserMedia({ audio: true });
        },
        recorder: (stream) => {
          if (typeof MediaRecorder === "undefined")
            throw new Error("Unsupported recorder");
          const mime = [
            "audio/webm;codecs=opus",
            "audio/mp4",
            "audio/ogg;codecs=opus",
            "audio/webm",
          ].find((type) => MediaRecorder.isTypeSupported(type));
          if (!mime) throw new Error("Unsupported recording format");
          return new MediaRecorder(stream, {
            mimeType: mime,
            audioBitsPerSecond: 64000,
          });
        },
        meter: inputMeter,
        now: () => performance.now(),
      },
      setState,
      (recording, damaged) => callback.current(recording, damaged),
      (context) => abandoned.current(context),
    );
    controller.current = current;
    return () => {
      current.discard(false);
      if (controller.current === current) controller.current = null;
    };
  }, []);
  return {
    ...state,
    start: useCallback(
      (provider: Provider, mode: Mode, context: CaptureContext) =>
        controller.current?.start(provider, mode, context),
      [],
    ),
    quarantineAndStop: useCallback(
      () => controller.current?.quarantineAndStop(),
      [],
    ),
    stop: useCallback(() => controller.current?.stop(), []),
    requestDiscard: useCallback(() => controller.current?.requestDiscard(), []),
    pause: useCallback(() => controller.current?.pause(), []),
    resume: useCallback(() => controller.current?.resume(), []),
    dismissDiscard: useCallback(() => controller.current?.dismissDiscard(), []),
    continueCapture: useCallback(
      (expected: "paused" | "review") =>
        controller.current?.continueCapture(expected),
      [],
    ),
    discard: useCallback(() => controller.current?.discard(), []),
    cancelPermission: useCallback(() => controller.current?.discard(), []),
    clearError: useCallback(() => controller.current?.clearError(), []),
  };
}
