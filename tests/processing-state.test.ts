import { describe, expect, it } from "vitest";
import { processingPresentation } from "../src/client/processing-state";

describe("Truthful processing presentation", () => {
  it.each(["google", "mistral"] as const)(
    "identifies the bound %s provider during its request",
    (provider) => {
      const view = processingPresentation("transcribing", provider, true);
      expect(view.title).toBe(
        `${provider === "google" ? "Google" : "Mistral"} is transcribing.`,
      );
      expect(view.canCancel).toBe(true);
      expect(view.steps.map((s) => s.state)).toEqual([
        "done",
        "current",
        "pending",
      ]);
      expect(view.storage).toBe("Audio saved on this device");
    },
  );
  it.each(["saving_audio", "saving_transcript", "saving_note"] as const)(
    "does not promise durability or offer model cancellation while %s",
    (phase) => {
      const view = processingPresentation(phase, "google", false);
      expect(view.canCancel).toBe(false);
      expect(view.storage).not.toMatch(/saved on this device/i);
      expect(view.storage).toContain("Keep this tab open");
    },
  );
  it("distinguishes confirmed audio from preparation before the model call", () => {
    const view = processingPresentation("saving_audio", "mistral", true);
    expect(view.title).toBe("Preparing transcription.");
    expect(view.canCancel).toBe(false);
    expect(view.steps[0].state).toBe("done");
    expect(view.steps[1]).toMatchObject({
      state: "current",
      detail: "Preparing request",
    });
    expect(view.storage).toBe("Audio saved on this device");
  });
  it("keeps device confirmation distinct from pending cloud storage", () => {
    const view = processingPresentation("saving_note", "mistral", true);
    expect(view.storage).toBe("Transcript saved on this device");
    expect(view.title).toBe("Saving your note.");
    expect(view.detail).toBe("Preparing and saving your note in the library.");
    expect(view.steps[2]).toMatchObject({
      state: "current",
      detail: "Saving to library",
    });
  });
});
