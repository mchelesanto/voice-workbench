"use client";
import { useEffect, useRef, useState } from "react";
import { AudioLines, Check, Download, ShieldCheck } from "lucide-react";
import type { Recording } from "./recording";
import type { RecordingPhase } from "./recording-recovery";
import { duration } from "./export";
import { processingPresentation } from "./processing-state";

export function ProcessingStatus({
  recording,
  phase,
  textDurable,
  cancel,
  downloadAudio,
  downloadTranscript,
}: {
  recording: Recording;
  phase: RecordingPhase;
  textDurable: boolean;
  cancel: () => void;
  downloadAudio: () => void;
  downloadTranscript: () => void;
}) {
  const [started] = useState(() => performance.now());
  const [elapsed, setElapsed] = useState(0);
  const title = useRef<HTMLHeadingElement>(null);
  const view = processingPresentation(phase, recording.provider, textDurable);
  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    const timer = setInterval(
      () => setElapsed(Math.max(0, performance.now() - started)),
      1000,
    );
    return () => clearInterval(timer);
  }, [started]);
  return (
    <section className="processing-status" aria-label="Recording processing">
      <div className="section-label">YOUR RECORDING</div>
      <div className="processing-focus">
        <span className="processing-eyebrow">A moment for your words</span>
        <h1 ref={title} tabIndex={-1} aria-live="polite">
          {view.title}
        </h1>
        <p className="processing-description">{view.detail}</p>
        <div className="processing-orbit" aria-hidden="true">
          <AudioLines size={30} strokeWidth={1.5} />
          <span className="processing-pulse">
            <i />
            <i />
            <i />
          </span>
        </div>
        <div className="processing-clock" role="timer" aria-live="off">
          {duration(elapsed)}
          <span>Elapsed processing time</span>
        </div>
        <ol className="processing-steps" aria-label="Processing stages">
          {view.steps.map((step, index) => (
            <li
              key={step.label}
              className={step.state}
              aria-current={step.state === "current" ? "step" : undefined}
            >
              <span className="processing-step-marker" aria-hidden="true">
                {step.state === "done" ? <Check size={15} /> : index + 1}
              </span>
              <div>
                <strong>{step.label}</strong>
                <small>{step.detail}</small>
              </div>
            </li>
          ))}
        </ol>
        <div className="processing-source">
          <ShieldCheck size={20} aria-hidden="true" />
          <div>
            <strong>{view.storage}</strong>
            <span>
              {duration(recording.durationMs)} recording · {view.provider} ·{" "}
              {recording.mode === "smart" ? "Polished" : "Verbatim"}
            </span>
          </div>
        </div>
        <div className="processing-actions">
          {view.canCancel && (
            <>
              <button className="secondary" onClick={cancel}>
                Cancel processing
              </button>
              <p>Cancel keeps your audio. Provider charges may still apply.</p>
            </>
          )}
          <div className="processing-backups">
            <button className="text-button" onClick={downloadAudio}>
              <Download size={14} /> Download audio
            </button>
            {recording.result && (
              <button className="text-button" onClick={downloadTranscript}>
                <Download size={14} /> Download transcript
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
