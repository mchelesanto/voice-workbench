import { LIMITS, type Note } from "../shared/contracts";
import { classifyCreateReplay } from "../shared/responses";
import type { Recording } from "./local-store";

// Confirm only the stored processing result, never a newer processing attempt.
export function recordingConfirmation(
  row: Recording,
  note: Note,
): Recording | undefined {
  if (
    row.id !== note.id ||
    row.state !== "transcribed" ||
    !row.result ||
    classifyCreateReplay(row.result, note) === "different_origin"
  )
    return;
  return {
    ...row,
    state: "cloud_confirmed",
    error: undefined,
    errorCode: undefined,
  };
}

export function recordingRecovery(row: Recording): {
  action: "none" | "save" | "transcribe" | "setup";
  label: string;
  hint?: string;
  setupPrompt?: string;
} {
  if (row.state === "cloud_confirmed") return { action: "none", label: "" };
  if (row.result)
    return { action: "save", label: "Save transcript to library" };
  if (
    row.blob.size > LIMITS.maxAudioBytes ||
    row.errorCode === "audio_too_large"
  )
    return {
      action: "none",
      label: "",
      hint: "This recording exceeds 25 MiB. Download it and record a shorter note.",
    };
  if (
    row.errorCode &&
    [
      "unsupported_audio",
      "unsupported_mode",
      "invalid_input",
      "unsupported_content_type",
      "request_too_large",
      "output_too_large",
    ].includes(row.errorCode)
  )
    return {
      action: "none",
      label: "",
      hint: "This recording cannot be processed unchanged. Download the audio or make a new recording.",
    };
  if (
    row.errorCode &&
    [
      "provider_auth_failed",
      "provider_unavailable",
      "configuration_unavailable",
      "forbidden_origin",
    ].includes(row.errorCode)
  )
    return {
      action: "setup",
      label: "Retry after setup",
      hint: ["forbidden_origin", "configuration_unavailable"].includes(
        row.errorCode,
      )
        ? "Check the local application configuration and address, then restart the server before retrying."
        : "Check this provider in your local configuration and restart the server before retrying.",
      setupPrompt: ["forbidden_origin", "configuration_unavailable"].includes(
        row.errorCode,
      )
        ? "Have you corrected the local application configuration and address, and restarted the server? This retry sends the audio to the displayed provider."
        : `Have you checked the ${recordingProvider(row)} configuration and restarted the server? This retry sends the audio to that provider.`,
    };
  if (
    row.errorCode &&
    ![
      "request_too_fragmented",
      "request_timeout",
      "request_aborted",
      "provider_rate_limited",
      "busy",
      "provider_timeout",
      "no_transcript",
      "transcription_failed",
      "internal_error",
    ].includes(row.errorCode)
  )
    return {
      action: "none",
      label: "",
      hint: "This response cannot be retried unchanged. Check the local application and reload it; the audio remains available for download.",
    };
  return {
    action: "transcribe",
    label:
      row.state === "recorded" ? "Transcribe audio" : "Try transcription again",
  };
}

export function recordingProvider(row: Recording) {
  return `${row.provider === "google" ? "Google" : "Mistral"} · ${row.mode === "smart" ? "Polished" : "Verbatim"}`;
}

export function selectLocalRecording(
  current: Recording | null,
  durable: boolean,
  stored: Recording,
) {
  if (current && !durable) {
    if (current.id !== stored.id) return;
    return { recording: current, durable: false };
  }
  return { recording: stored, durable: true };
}
