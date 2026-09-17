import { captureContext } from "./capture-context";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RecorderController,
  type RecorderSnapshot,
} from "../src/client/recorder-controller";

function fixture() {
  const track = { stop: vi.fn(), enabled: true, readyState: "live" };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const native = {
    state: "inactive",
    mimeType: "audio/webm;codecs=opus",
    ondataavailable: null as ((event: { data: Blob }) => void) | null,
    onstop: null as (() => void) | null,
    onerror: null as (() => void) | null,
    start: vi.fn(() => {
      native.state = "recording";
    }),
    pause: vi.fn(() => {
      native.state = "paused";
    }),
    resume: vi.fn(() => {
      native.state = "recording";
    }),
    stop: vi.fn(() => {
      native.state = "inactive";
    }),
  };
  const meter = { read: vi.fn(() => 0.5), close: vi.fn() };
  const changed = vi.fn<(state: RecorderSnapshot) => void>();
  const ready = vi.fn();
  const dependencies = {
    stream: vi.fn(async () => stream),
    recorder: vi.fn(() => native as unknown as MediaRecorder),
    meter: vi.fn(() => meter),
    now: () => Date.now(),
  };
  const controller = new RecorderController(dependencies, changed, ready);
  const complete = () => {
    native.ondataavailable?.({ data: new Blob(["synthetic audio"]) });
    native.onstop?.();
  };
  return {
    controller,
    dependencies,
    native,
    track,
    meter,
    changed,
    ready,
    complete,
    stream,
  };
}
afterEach(() => vi.useRealTimers());
describe("Recording session ownership", () => {
  it("does not bypass a pending discard decision while native stop is completing", async () => {
    const f = fixture();
    await f.controller.start("google", "verbatim", captureContext());
    f.controller.stop();
    f.controller.requestDiscard();
    f.controller.continueCapture("review");
    f.complete();
    expect(f.ready).not.toHaveBeenCalled();
    expect(f.changed.mock.lastCall?.[0].phase).toBe("review");
    f.controller.discard();
  });
  it("releases the microphone even if meter cleanup fails", async () => {
    const f = fixture();
    f.meter.close.mockImplementation(() => {
      throw new Error("meter error");
    });
    await f.controller.start("google", "verbatim", captureContext());
    f.controller.discard();
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.ready).not.toHaveBeenCalled();
  });
  it("delivers one completed recording only after the final data event", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start("google", "smart", captureContext());
    await vi.advanceTimersByTimeAsync(500);
    f.controller.stop();
    f.controller.stop();
    expect(f.ready).not.toHaveBeenCalled();
    f.complete();
    expect(f.ready).toHaveBeenCalledTimes(1);
    expect(f.ready.mock.calls[0][0]).toMatchObject({
      durationMs: 500,
      provider: "google",
      mode: "smart",
      state: "recorded",
    });
    expect(f.native.stop).toHaveBeenCalledTimes(1);
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.meter.close).toHaveBeenCalledTimes(1);
  });
  it("discards without a ready callback and ignores captured late callbacks", async () => {
    const f = fixture();
    await f.controller.start("google", "verbatim", captureContext());
    const data = f.native.ondataavailable!,
      stop = f.native.onstop!;
    data({ data: new Blob(["first"]) });
    f.controller.requestDiscard();
    f.controller.discard();
    data({ data: new Blob(["late"]) });
    stop();
    expect(f.ready).not.toHaveBeenCalled();
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.changed.mock.lastCall?.[0].phase).toBe("idle");
  });
  it("cancels permission and stops a late stream without creating a recorder", async () => {
    const f = fixture();
    let allow!: (stream: MediaStream) => void;
    f.dependencies.stream.mockImplementation(
      () =>
        new Promise((resolve) => {
          allow = resolve;
        }),
    );
    const start = f.controller.start("google", "verbatim", captureContext());
    f.controller.discard();
    allow(f.stream);
    await start;
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.dependencies.recorder).not.toHaveBeenCalled();
    expect(f.ready).not.toHaveBeenCalled();
  });
  it("does not let an old stop event release a new session", async () => {
    const f = fixture();
    await f.controller.start("google", "verbatim", captureContext());
    const oldStop = f.native.onstop!;
    f.controller.discard();
    await f.controller.start("mistral", "verbatim", captureContext());
    oldStop();
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.changed.mock.lastCall?.[0].phase).toBe("recording");
    f.controller.discard();
  });
  it("pauses before the discard question and resumes the same clip without counting the pause", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start("google", "verbatim", captureContext());
    f.native.ondataavailable?.({ data: new Blob(["before"]) });
    await vi.advanceTimersByTimeAsync(500);
    f.controller.requestDiscard();
    expect(f.changed.mock.lastCall?.[0]).toMatchObject({
      phase: "paused",
      confirmDiscard: true,
      elapsed: 500,
    });
    expect(f.native.pause).toHaveBeenCalledTimes(1);
    expect(f.track.enabled).toBe(false);
    expect(f.native.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const reads = f.meter.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.meter.read).toHaveBeenCalledTimes(reads);
    expect(f.changed.mock.lastCall?.[0].elapsed).toBe(500);
    expect(f.ready).not.toHaveBeenCalled();
    f.controller.continueCapture("paused");
    expect(f.track.enabled).toBe(true);
    expect(f.native.resume).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    f.native.ondataavailable?.({ data: new Blob(["after"]) });
    f.controller.stop();
    f.complete();
    expect(f.ready).toHaveBeenCalledTimes(1);
    expect(f.ready.mock.calls[0][0].durationMs).toBe(1000);
    expect(await f.ready.mock.calls[0][0].blob.text()).toBe(
      "beforeaftersynthetic audio",
    );
    expect(f.native.start).toHaveBeenCalledTimes(1);
    expect(f.dependencies.stream).toHaveBeenCalledTimes(1);
  });
  it("supports a thinking pause without a discard question and stops while paused", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start("mistral", "verbatim", captureContext());
    await vi.advanceTimersByTimeAsync(1200);
    f.controller.pause();
    f.controller.pause();
    expect(f.changed.mock.lastCall?.[0]).toMatchObject({
      phase: "paused",
      confirmDiscard: false,
      elapsed: 1200,
    });
    expect(f.native.pause).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    f.controller.stop();
    f.complete();
    expect(f.ready.mock.calls[0][0].durationMs).toBe(1200);
    expect(f.track.stop).toHaveBeenCalledTimes(1);
  });
  it("closing the discard question leaves the recording paused", async () => {
    const f = fixture();
    await f.controller.start("google", "verbatim", captureContext());
    f.controller.requestDiscard();
    f.controller.dismissDiscard();
    expect(f.changed.mock.lastCall?.[0]).toMatchObject({
      phase: "paused",
      confirmDiscard: false,
    });
    expect(f.track.enabled).toBe(false);
    expect(f.native.resume).not.toHaveBeenCalled();
    f.controller.resume();
    expect(f.track.enabled).toBe(true);
    f.controller.discard();
    f.controller.resume();
    expect(f.native.resume).toHaveBeenCalledTimes(1);
  });
  it.each(["discard", "keep"])(
    "holds a late byte-limit completion while paused until %s",
    async (choice) => {
      const f = fixture();
      await f.controller.start("google", "verbatim", captureContext());
      f.controller.pause();
      f.native.ondataavailable?.({ data: { size: 70 * 1024 * 1024 } as Blob });
      f.complete();
      expect(f.changed.mock.lastCall?.[0]).toMatchObject({
        phase: "review",
        confirmDiscard: true,
      });
      expect(f.ready).not.toHaveBeenCalled();
      if (choice === "discard") f.controller.discard();
      else f.controller.continueCapture("review");
      expect(f.ready).toHaveBeenCalledTimes(choice === "discard" ? 0 : 1);
    },
  );
  it("does not count a long thinking pause toward the provider limit", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start("google", "verbatim", captureContext());
    await vi.advanceTimersByTimeAsync(500);
    f.controller.pause();
    vi.setSystemTime(Date.now() + 7200000);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.native.stop).not.toHaveBeenCalled();
    f.controller.resume();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.changed.mock.lastCall?.[0]).toMatchObject({
      phase: "recording",
      elapsed: 1000,
    });
    f.controller.discard();
  });
  it.each(["pause", "resume"] as const)(
    "salvages audio without automatic transcription if native %s fails",
    async (method) => {
      const f = fixture();
      await f.controller.start("google", "verbatim", captureContext());
      f.native.ondataavailable?.({ data: new Blob(["saved"]) });
      f.native[method].mockImplementation(() => {
        throw Error("Synthetic native failure");
      });
      f.controller.pause();
      if (method === "resume") f.controller.resume();
      f.complete();
      expect(f.ready).toHaveBeenCalledTimes(1);
      expect(f.ready.mock.calls[0][1]).toBe(true);
      expect(f.track.stop).toHaveBeenCalledTimes(1);
    },
  );
  it("a remote clear terminates a paused capture and prevents resuming it", async () => {
    const f = fixture();
    await f.controller.start("google", "verbatim", captureContext());
    f.controller.pause();
    f.controller.quarantineAndStop();
    f.complete();
    f.controller.resume();
    expect(f.ready.mock.calls[0][0].readOnly).toBe(true);
    expect(f.ready.mock.calls[0][1]).toBe(true);
    expect(f.native.resume).not.toHaveBeenCalled();
    expect(f.track.stop).toHaveBeenCalledTimes(1);
  });
  it.each(["google", "mistral"] as const)(
    "keeps a %s half-hour capture running",
    async (provider) => {
      vi.useFakeTimers();
      const f = fixture();
      await f.controller.start(provider, "verbatim", captureContext());
      vi.setSystemTime(Date.now() + 1800000);
      await vi.advanceTimersByTimeAsync(100);
      expect(f.changed.mock.lastCall?.[0].phase).toBe("recording");
      expect(f.native.stop).not.toHaveBeenCalled();
      f.controller.stop();
      f.complete();
      expect(f.ready.mock.calls[0][0].durationMs).toBeGreaterThanOrEqual(
        1800000,
      );
      f.controller.discard();
    },
  );
  it("keeps Mistral running past the Google limit and stops at its own boundary", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start("mistral", "verbatim", captureContext());
    const start = Date.now();
    vi.setSystemTime(start + 3600000);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.native.stop).not.toHaveBeenCalled();
    vi.setSystemTime(start + 10800000);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.native.stop).toHaveBeenCalledTimes(1);
    f.controller.discard();
  });
  it.each([
    ["google", 70 * 1024 * 1024],
    ["mistral", 500000000],
  ] as const)("stops %s at its byte reserve", async (provider, limit) => {
    const f = fixture();
    await f.controller.start(provider, "verbatim", captureContext());
    f.native.ondataavailable?.({
      data: { size: limit - 1024 * 1024 - 1 } as Blob,
    });
    expect(f.native.stop).not.toHaveBeenCalled();
    f.native.ondataavailable?.({ data: { size: 1 } as Blob });
    expect(f.native.stop).toHaveBeenCalledTimes(1);
    f.controller.discard();
  });
  it("keeps an unexpected native stop out of automatic transcription", async () => {
    const f = fixture();
    await f.controller.start("google", "verbatim", captureContext());
    f.complete();
    expect(f.ready).toHaveBeenCalledTimes(1);
    expect(f.ready.mock.calls[0][1]).toBe(true);
    expect(f.track.stop).toHaveBeenCalledTimes(1);
  });
  it("emits actual measured level history rather than an animated placeholder", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start("google", "verbatim", captureContext());
    await vi.advanceTimersByTimeAsync(100);
    expect(f.changed.mock.lastCall?.[0].levels.at(-1)).toBe(0.5);
    f.meter.read.mockReturnValue(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.changed.mock.lastCall?.[0].levels.at(-1)).toBe(0);
    f.controller.discard();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("releases the microphone when recorder construction fails", async () => {
    const f = fixture();
    f.dependencies.recorder.mockImplementation(() => {
      throw new Error("unsupported");
    });
    await f.controller.start("google", "verbatim", captureContext());
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.changed.mock.lastCall?.[0].phase).toBe("idle");
    expect(f.ready).not.toHaveBeenCalled();
  });
  it("keeps interrupted audio out of automatic transcription", async () => {
    const f = fixture();
    await f.controller.start("google", "verbatim", captureContext());
    f.native.onerror?.();
    f.complete();
    expect(f.ready.mock.calls[0][1]).toBe(true);
  });
});

it("quarantines native final chunks on a remote clear without automatic transcription", async () => {
  const f = fixture(),
    context = captureContext({ vocabulary: ["Frozen words"] });
  await f.controller.start("google", "verbatim", context);
  f.controller.quarantineAndStop();
  f.complete();
  expect(f.ready).toHaveBeenCalledTimes(1);
  expect(f.ready.mock.calls[0][0]).toMatchObject({
    id: context.id,
    generation: 1,
    readOnly: true,
    vocabulary: ["Frozen words"],
  });
  expect(f.ready.mock.calls[0][1]).toBe(true);
  expect(f.track.stop).toHaveBeenCalledTimes(1);
});
it("lets a local discard win over a pending quarantine completion", async () => {
  const f = fixture();
  await f.controller.start("google", "verbatim", captureContext());
  const stop = f.native.onstop!;
  f.controller.quarantineAndStop();
  f.controller.discard();
  stop();
  expect(f.ready).not.toHaveBeenCalled();
});
it("freezes context before asynchronous permission resolves", async () => {
  const f = fixture();
  let allow!: (stream: MediaStream) => void;
  f.dependencies.stream.mockImplementation(
    () =>
      new Promise((resolve) => {
        allow = resolve;
      }),
  );
  const words = ["Original"],
    context = captureContext({ vocabulary: words });
  const starting = f.controller.start("google", "verbatim", context);
  words.push("Changed later");
  allow(f.stream);
  await starting;
  f.controller.stop();
  f.complete();
  expect(f.ready.mock.calls[0][0].vocabulary).toEqual(["Original"]);
});

it("does not turn an old Continue action into an upload after a late file limit", async () => {
  const f = fixture();
  await f.controller.start("google", "verbatim", captureContext());
  f.controller.requestDiscard();
  f.native.ondataavailable?.({ data: { size: 70 * 1024 * 1024 } as Blob });
  f.complete();
  f.controller.continueCapture("paused");
  expect(f.ready).not.toHaveBeenCalled();
  f.controller.continueCapture("review");
  expect(f.ready).toHaveBeenCalledTimes(1);
});
