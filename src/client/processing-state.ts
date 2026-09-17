import type { Provider } from "../shared/contracts";
import type { RecordingPhase } from "./recording-recovery";

export function processingPresentation(
  phase: RecordingPhase,
  selectedProvider: Provider,
  textDurable: boolean,
) {
  const provider = selectedProvider === "google" ? "Google" : "Mistral";
  const preparing = phase === "preparing_audio";
  const transcribing = phase === "transcribing";
  const savingResult = phase === "saving_transcript" || phase === "saving_note";
  const stage = savingResult ? 2 : transcribing || preparing ? 1 : 0;
  return {
    provider,
    title: transcribing
      ? `${provider} is processing.`
      : phase === "saving_note"
        ? "Saving your note."
        : phase === "saving_transcript"
          ? "Your words are here."
          : preparing
            ? "Preparing transcription."
            : "Preparing your recording.",
    detail: transcribing
      ? "Sending and processing your recording. Your transcript will appear here."
      : phase === "saving_note"
        ? "Preparing and saving your note in the library."
        : phase === "saving_transcript"
          ? "Saving the transcript on this device before syncing."
          : preparing
            ? "Audio is ready in this tab. Checking the recording context."
            : "Audio stays in this tab. Closing or reloading removes it.",
    storage: textDurable
      ? "Transcript saved on this device"
      : "Audio is temporary in this tab",
    canCancel: transcribing,
    steps: [
      { label: "Audio", detail: "Ready in this tab" },
      {
        label: "Transcribe",
        detail:
          stage > 1
            ? "Text received"
            : preparing
              ? "Preparing request"
              : provider,
      },
      {
        label: "Save note",
        detail:
          phase === "saving_transcript"
            ? "Securing transcript"
            : phase === "saving_note"
              ? "Saving to library"
              : "Up next",
      },
    ].map((step, index) => ({
      ...step,
      state: index < stage ? "done" : index === stage ? "current" : "pending",
    })),
  };
}
