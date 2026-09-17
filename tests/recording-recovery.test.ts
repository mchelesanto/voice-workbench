import { expect, it } from "vitest";
import type { Recording } from "../src/client/local-store";
import {
  recordingConfirmation,
  recordingRecovery,
  selectLocalRecording,
  recordingProgress,
} from "../src/client/recording-recovery";
import type { Note } from "../src/shared/contracts";

const input = {
  title: "Original title",
  originalText: "Original words",
  body: "Original words",
  provider: "google" as const,
  model: "gemini-3.5-transcribe",
  mode: "smart" as const,
  durationMs: 1000,
};

it.each([
  "saving_audio",
  "saving_transcript",
  "saving_note",
  "transcribing",
] as const)(
  "never claims device durability before confirmation during %s",
  (phase) => {
    expect(recordingProgress(phase, false).detail).toContain(
      "Only in this tab",
    );
    expect(recordingProgress(phase, false).detail).not.toContain(
      "saved on this device",
    );
  },
);
it("offers cancellation only while a model request is active", () => {
  expect(recordingProgress("transcribing", true).canCancel).toBe(true);
  for (const phase of [
    "saving_audio",
    "saving_transcript",
    "saving_note",
    "idle",
  ] as const)
    expect(recordingProgress(phase, false).canCancel).toBe(false);
});
it("offers only export for a superseded RAM result", () => {
  expect(recordingRecovery({ ...recording, superseded: true }).action).toBe(
    "none",
  );
});
const recording: Recording = {
  kind: "recording",
  id: "11111111-1111-4111-8111-111111111111",
  blob: new Blob(["audio"]),
  mime: "audio/webm",
  durationMs: 1000,
  createdAt: "2026-09-16T10:00:00.000Z",
  provider: "google",
  mode: "smart",
  state: "transcribed",
  result: input,
};
const note: Note = {
  ...input,
  id: recording.id,
  title: "Edited title",
  body: "Edited cloud version",
  revision: 3,
  createdAt: recording.createdAt,
  updatedAt: recording.createdAt,
};

it("opens consecutive durable recordings without clearing the selected audio", () => {
  const other = { ...recording, id: "22222222-2222-4222-8222-222222222222" };
  expect(selectLocalRecording(recording, true, other)).toEqual({
    recording: other,
    durable: true,
  });
});
it("never replaces a RAM-only recording with another or a stale stored copy", () => {
  const live = { ...recording, result: { ...input, body: "Only in RAM" } };
  expect(
    selectLocalRecording(live, false, {
      ...recording,
      id: "22222222-2222-4222-8222-222222222222",
    }),
  ).toBeUndefined();
  expect(selectLocalRecording(live, false, recording)).toEqual({
    recording: live,
    durable: false,
  });
});

it("confirms the recording origin after later edits without replacing its transcript", () => {
  const confirmed = recordingConfirmation(recording, note);
  expect(confirmed?.state).toBe("cloud_confirmed");
  expect(confirmed?.result?.body).toBe("Original words");
});
it("never confirms a different origin, another recording, or a newer processing attempt", () => {
  expect(
    recordingConfirmation(recording, {
      ...note,
      originalText: "Other recording",
    }),
  ).toBeUndefined();
  expect(
    recordingConfirmation(recording, {
      ...note,
      id: "22222222-2222-4222-8222-222222222222",
    }),
  ).toBeUndefined();
  expect(
    recordingConfirmation({ ...recording, state: "transcribing" }, note),
  ).toBeUndefined();
  expect(
    recordingConfirmation({ ...recording, state: "cloud_confirmed" }, note),
  ).toBeUndefined();
});
it("keeps a finished result savable even when the retained audio exceeds the upload limit", () => {
  expect(
    recordingRecovery({
      ...recording,
      blob: new Blob([new Uint8Array(71 * 1024 * 1024)]),
    }).action,
  ).toBe("save");
});
it("explains oversized legacy recordings after reload and never offers an upload", () => {
  const next = recordingRecovery({
    ...recording,
    state: "recorded",
    result: undefined,
    blob: new Blob([new Uint8Array(71 * 1024 * 1024)]),
  });
  expect(next.action).toBe("none");
  expect(next.hint).toContain("73 MB");
});
it.each(["unsupported_audio", "audio_too_large", "unsupported_mode"] as const)(
  "does not repeat an unchanged definitively rejected input: %s",
  (code) => {
    expect(
      recordingRecovery({
        ...recording,
        state: "error",
        result: undefined,
        errorCode: code,
      }).action,
    ).toBe("none");
  },
);
it.each(["provider_auth_failed", "provider_unavailable"] as const)(
  "requires explicit setup acknowledgement before retrying %s",
  (code) => {
    expect(
      recordingRecovery({
        ...recording,
        state: "error",
        result: undefined,
        errorCode: code,
      }).action,
    ).toBe("setup");
  },
);
it("preserves manual retry for transient and unknown outcomes", () => {
  expect(
    recordingRecovery({
      ...recording,
      state: "error",
      result: undefined,
      errorCode: "provider_rate_limited",
    }).action,
  ).toBe("transcribe");
  expect(
    recordingRecovery({ ...recording, state: "unknown", result: undefined })
      .action,
  ).toBe("transcribe");
});

it("keeps a no-transcript result manually recoverable without treating it as silence", () => {
  expect(
    recordingRecovery({
      ...recording,
      result: undefined,
      state: "error",
      errorCode: "no_transcript",
    }).action,
  ).toBe("transcribe");
});
it.each(["method_not_allowed", "api_not_found", "output_too_large"] as const)(
  "does not offer the same rejected operation again for %s",
  (errorCode) => {
    expect(
      recordingRecovery({
        ...recording,
        result: undefined,
        state: "error",
        errorCode,
      }).action,
    ).toBe("none");
  },
);
it.each(["forbidden_origin", "configuration_unavailable"] as const)(
  "points application setup failures to application configuration: %s",
  (errorCode) => {
    const next = recordingRecovery({
      ...recording,
      result: undefined,
      state: "error",
      errorCode,
    });
    expect(next.action).toBe("setup");
    expect(next.hint).toContain("application configuration and address");
    expect(next.setupPrompt).toContain("application configuration and address");
  },
);

it("uses the recording provider for upload recovery rather than a global byte cap", () => {
  const blob = Object.defineProperty(new Blob(["test"]), "size", {
    value: 80_000_000,
  });
  const base = {
    kind: "recording",
    id: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-09-17T00:00:00.000Z",
    blob,
    mime: "audio/wav",
    durationMs: 1800000,
    mode: "verbatim",
    state: "recorded",
  } as const;
  expect(recordingRecovery({ ...base, provider: "google" }).action).toBe(
    "none",
  );
  expect(recordingRecovery({ ...base, provider: "mistral" }).action).toBe(
    "transcribe",
  );
});

it("retains over-duration audio without offering another unchanged upload", () => {
  const base = {
    kind: "recording",
    id: "11111111-1111-4111-8111-111111111111",
    blob: new Blob(["audio"]),
    mime: "audio/webm",
    durationMs: 3600001,
    createdAt: "2026-09-17T00:00:00.000Z",
    mode: "verbatim",
    state: "recorded",
  } as const;
  expect(recordingRecovery({ ...base, provider: "google" }).action).toBe(
    "none",
  );
  expect(recordingRecovery({ ...base, provider: "google" }).hint).toContain(
    "60 minutes",
  );
  expect(recordingRecovery({ ...base, provider: "mistral" }).action).toBe(
    "transcribe",
  );
});
