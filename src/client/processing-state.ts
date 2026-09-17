import type { Provider } from "../shared/contracts";
import type { RecordingPhase } from "./recording-recovery";

export function processingPresentation(
  phase: RecordingPhase,
  selectedProvider: Provider,
  durable: boolean,
) {
  const provider = selectedProvider === "google" ? "Google" : "Mistral";
  const preparing = phase === "saving_audio" && durable;
  const transcribing = phase === "transcribing";
  const savingResult = phase === "saving_transcript" || phase === "saving_note";
  const stage = savingResult ? 2 : transcribing || preparing ? 1 : 0;
  return {
    provider,
    title: transcribing
      ? `${provider} is transcribing.`
      : phase === "saving_note"
        ? "Saving your note."
        : phase === "saving_transcript"
          ? "Your words are here."
          : preparing
            ? "Preparing transcription."
            : "Keeping your audio safe.",
    detail: transcribing
      ? "Sending and processing your recording. Your transcript will appear here."
      : phase === "saving_note"
        ? "Preparing and saving your note in the library."
        : phase === "saving_transcript"
          ? "Saving the transcript on this device before syncing."
          : preparing
            ? "Your audio is saved. Preparing the transcription request."
            : "Saving this recording on your device before anything is sent.",
    storage: durable
      ? savingResult
        ? "Transcript saved on this device"
        : "Audio saved on this device"
      : "Keep this tab open while your local copy is saved",
    canCancel: transcribing,
    steps: [
      { label: "Audio", detail: stage === 0 ? "Saving locally" : "Captured" },
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
