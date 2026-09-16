"use client";
import { useEffect, useId, useRef } from "react";
import {
  Mic,
  Square,
  Trash2,
  X,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { duration } from "./export";
import type { RecorderSnapshot } from "./recorder-controller";

export function RecordingDialog({
  state,
  stop,
  requestDiscard,
  keep,
  discard,
  retry,
}: {
  state: RecorderSnapshot;
  stop: () => void;
  requestDiscard: () => void;
  keep: () => void;
  discard: () => void;
  retry: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const permission = state.phase === "permission";
  const stopping = state.phase === "stopping";
  const review = state.phase === "review";
  const failed = state.phase === "idle";
  const close = () => {
    if (stopping || review) return;
    if (failed || permission) discard();
    else if (state.confirmDiscard) keep();
    else requestDiscard();
  };
  return (
    <dialog
      ref={ref}
      className="capture-modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className="capture-header">
        <span
          className={`capture-status ${state.phase === "recording" ? "is-live" : ""}`}
        >
          <span className="capture-dot" />
          {permission
            ? "MICROPHONE ACCESS"
            : failed
              ? "CAPTURE UNAVAILABLE"
              : review || stopping
                ? "CAPTURE FINISHED"
                : "RECORDING"}
        </span>
        <button
          className="icon-button"
          onClick={close}
          disabled={stopping || review}
          aria-label={
            state.confirmDiscard ? "Keep recording" : "Cancel recording"
          }
        >
          <X size={20} />
        </button>
      </header>
      <div className="capture-body">
        <h2 id={titleId}>
          {state.confirmDiscard
            ? "Discard this recording?"
            : permission
              ? "One moment before you speak."
              : failed
                ? "No audio captured."
                : stopping
                  ? "Finishing your recording…"
                  : "Your words, in focus."}
        </h2>
        <p className="capture-description">
          {state.confirmDiscard
            ? review
              ? "Recording has stopped. Keep the audio or discard it before anything is sent."
              : "Recording continues while you decide. Discarding sends nothing and saves no audio."
            : permission
              ? "Choose Allow in your browser to start recording."
              : failed
                ? state.error
                : "Speak naturally. Your recording stays on this device until you finish."}
        </p>
        {!failed && (
          <div className="capture-signal">
            <div
              className="capture-timer"
              role="timer"
              aria-label="Recording duration"
            >
              {duration(state.elapsed)}
            </div>
            <span className="capture-limit">
              Automatically finishes at 10:00
            </span>
            <div
              className={`input-level ${permission || stopping || review ? "input-level-idle" : ""}`}
              role="img"
              aria-label={
                state.meterAvailable
                  ? "Microphone input level"
                  : "Input meter unavailable"
              }
            >
              {permission || stopping ? (
                <LoaderCircle size={30} className="spin" />
              ) : (
                state.levels.map((level, index) => (
                  <i key={index} style={{ height: `${3 + level * 69}px` }} />
                ))
              )}
            </div>
            <span className="capture-level-label">
              {permission
                ? "Waiting for permission"
                : stopping
                  ? "Preparing captured audio"
                  : review
                    ? "Microphone stopped"
                    : state.meterAvailable
                      ? "Live microphone level"
                      : "Input meter unavailable. Recording continues."}
            </span>
          </div>
        )}
        <div className="capture-provider">
          <Mic size={16} />
          <span>
            {state.provider === "google" ? "Google" : "Mistral"}{" "}
            <span className="capture-provider-divider">/</span>{" "}
            {state.mode === "smart" ? "Polished" : "Verbatim"}
          </span>
        </div>
      </div>
      <footer className="capture-actions">
        {failed ? (
          <>
            <button className="secondary" onClick={discard}>
              Close
            </button>
            <button className="primary" onClick={retry}>
              Try again
            </button>
          </>
        ) : state.confirmDiscard ? (
          <>
            <button className="secondary" onClick={keep} disabled={stopping}>
              {review
                ? state.error
                  ? "Keep audio"
                  : "Keep & transcribe"
                : "Keep recording"}
            </button>
            <button className="danger" onClick={discard}>
              <Trash2 size={17} />
              Discard recording
            </button>
          </>
        ) : (
          <>
            <button
              className="capture-cancel"
              onClick={permission ? discard : requestDiscard}
              disabled={stopping}
            >
              {permission ? "Cancel" : "Cancel recording"}
            </button>
            {!permission && (
              <button
                className="primary capture-finish"
                onClick={stop}
                disabled={stopping}
              >
                <Square size={15} fill="currentColor" />
                {stopping ? "Finishing…" : "Stop & transcribe"}
              </button>
            )}
          </>
        )}
        <p className="capture-privacy">
          <ShieldCheck size={14} />
          {state.confirmDiscard
            ? "Nothing has been sent for transcription."
            : `Finishing sends this recording to ${state.provider === "google" ? "Google" : "Mistral"}.`}
        </p>
      </footer>
    </dialog>
  );
}
