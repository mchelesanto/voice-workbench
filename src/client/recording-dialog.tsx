"use client";
import { useEffect, useId, useRef } from "react";
import {
  Mic,
  Pause,
  Play,
  Square,
  Trash2,
  X,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { PROVIDERS } from "../shared/contracts";
import { duration } from "./export";
import type { RecorderSnapshot } from "./recorder-controller";

function DiscardPrompt({
  state,
  continueCapture,
  discard,
  dismiss,
}: {
  state: RecorderSnapshot;
  continueCapture: (expected: "paused" | "review") => void;
  discard: () => void;
  dismiss: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    safeAction = useRef<HTMLButtonElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId(),
    descriptionId = useId();
  const finished = state.phase === "review";
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    if (safeAction.current?.disabled) heading.current?.focus();
    else safeAction.current?.focus();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="capture-discard-prompt"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }}
    >
      <span className="dialog-eyebrow">
        {finished ? "CAPTURE FINISHED" : "RECORDING PAUSED"}
      </span>
      <h2 id={titleId} ref={heading} tabIndex={-1}>
        Discard this recording?
      </h2>
      <p id={descriptionId}>
        {finished
          ? "Recording has ended. Keep the captured audio or discard it."
          : "Nothing more is being recorded. Discard this clip or continue where you left off."}
      </p>
      <div className="capture-discard-actions">
        <button
          ref={safeAction}
          className="primary"
          onClick={() => continueCapture(finished ? "review" : "paused")}
          disabled={state.phase === "stopping"}
        >
          {finished
            ? state.error
              ? "Keep audio"
              : "Keep & transcribe"
            : "Continue recording"}
        </button>
        <button className="danger" onClick={discard}>
          <Trash2 size={16} /> Discard recording
        </button>
      </div>
      {state.phase === "paused" && (
        <button className="text-button stay-paused" onClick={dismiss}>
          Stay paused
        </button>
      )}
      <small>
        <ShieldCheck size={14} /> Nothing has been sent for transcription.
      </small>
    </dialog>
  );
}

export function RecordingDialog({
  state,
  receiving,
  stop,
  pause,
  resume,
  requestDiscard,
  continueCapture,
  dismissDiscard,
  discard,
  retry,
}: {
  state: RecorderSnapshot;
  receiving: boolean;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  requestDiscard: () => void;
  continueCapture: (expected: "paused" | "review") => void;
  dismissDiscard: () => void;
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
  const paused = state.phase === "paused";
  const review = state.phase === "review";
  const failed = state.phase === "idle" && !!state.error && !receiving;
  // A completed clip can still be transferring to the workspace's RAM manager.
  const stopping =
    receiving ||
    state.phase === "stopping" ||
    (state.phase === "idle" && !state.error);
  const close = () => {
    if (stopping || review) return;
    if (failed || permission) discard();
    else requestDiscard();
  };
  return (
    <>
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
                : paused
                  ? "PAUSED"
                  : stopping || review
                    ? "CAPTURE FINISHED"
                    : "RECORDING"}
          </span>
          <button
            className="icon-button"
            onClick={close}
            disabled={stopping || review}
            aria-label="Cancel recording"
          >
            <X size={20} />
          </button>
        </header>
        <div className="capture-body">
          <h2 id={titleId}>
            {permission
              ? "One moment before you speak."
              : failed
                ? "No audio captured."
                : stopping || review
                  ? "Finishing your recording…"
                  : paused
                    ? "Take your time."
                    : "Your words, in focus."}
          </h2>
          <p className="capture-description">
            {permission
              ? "Choose Allow in your browser to start recording."
              : failed
                ? state.error
                : paused
                  ? "No audio is being recorded. Resume when you’re ready."
                  : stopping || review
                    ? "Preparing the audio you captured."
                    : "Speak naturally. Pause whenever you need a moment."}
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
                {PROVIDERS[state.provider].label} limit:{" "}
                {PROVIDERS[state.provider].maxRecordingSeconds / 60} minutes of
                audio
              </span>
              <div
                className={`input-level ${permission || paused || stopping || review ? "input-level-idle" : ""}`}
                role="img"
                aria-label={
                  paused
                    ? "Paused microphone input"
                    : state.meterAvailable
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
                      : paused
                        ? "Recording paused · pause time is not included"
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
          ) : (
            !permission && (
              <>
                <button
                  className={`${paused ? "primary" : "secondary"} capture-pause`}
                  onClick={paused ? resume : pause}
                  disabled={stopping || review}
                >
                  {paused ? <Play size={16} /> : <Pause size={16} />}{" "}
                  {paused ? "Resume recording" : "Pause recording"}
                </button>
                <button
                  className={`${paused ? "secondary" : "primary"} capture-finish`}
                  onClick={stop}
                  disabled={stopping || review}
                >
                  <Square size={15} fill="currentColor" />{" "}
                  {stopping || review ? "Finishing…" : "Stop & transcribe"}
                </button>
              </>
            )
          )}
          <p className="capture-privacy">
            <ShieldCheck size={14} />
            {failed || permission
              ? "Nothing has been sent for transcription."
              : `Finishing sends this recording to ${state.provider === "google" ? "Google" : "Mistral"}.`}
          </p>
        </footer>
      </dialog>
      {state.confirmDiscard && (
        <DiscardPrompt
          state={state}
          continueCapture={continueCapture}
          discard={discard}
          dismiss={dismissDiscard}
        />
      )}
    </>
  );
}
