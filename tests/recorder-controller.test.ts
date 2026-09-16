import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RecorderController,
  type RecorderSnapshot,
} from "../src/client/recorder-controller";

function fixture() {
  const track = { stop: vi.fn() };
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
    await f.controller.start("google", "verbatim");
    f.controller.stop();
    f.controller.requestDiscard();
    f.controller.keepRecording();
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
    await f.controller.start("google", "verbatim");
    f.controller.discard();
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.ready).not.toHaveBeenCalled();
  });
  it("delivers one completed recording only after the final data event", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start("google", "smart");
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
    await f.controller.start("google", "verbatim");
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
    const start = f.controller.start("google", "verbatim");
    f.controller.discard();
    allow(f.stream);
    await start;
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.dependencies.recorder).not.toHaveBeenCalled();
    expect(f.ready).not.toHaveBeenCalled();
  });
  it("does not let an old stop event release a new session", async () => {
    const f = fixture();
    await f.controller.start("google", "verbatim");
    const oldStop = f.native.onstop!;
    f.controller.discard();
    await f.controller.start("mistral", "verbatim");
    oldStop();
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.changed.mock.lastCall?.[0].phase).toBe("recording");
    f.controller.discard();
  });
  it("keeps the capture running when discard confirmation is dismissed", async () => {
    const f = fixture();
    await f.controller.start("google", "verbatim");
    f.controller.requestDiscard();
    expect(f.changed.mock.lastCall?.[0].confirmDiscard).toBe(true);
    f.controller.keepRecording();
    expect(f.changed.mock.lastCall?.[0]).toMatchObject({
      phase: "recording",
      confirmDiscard: false,
    });
    expect(f.native.stop).not.toHaveBeenCalled();
    f.controller.discard();
  });
  it.each(["discard", "keep"])(
    "holds a limit completion during confirmation until %s",
    async (choice) => {
      vi.useFakeTimers();
      const f = fixture();
      await f.controller.start("google", "verbatim");
      f.controller.requestDiscard();
      await vi.advanceTimersByTimeAsync(600000);
      expect(f.native.stop).toHaveBeenCalledTimes(1);
      f.complete();
      expect(f.changed.mock.lastCall?.[0].phase).toBe("review");
      expect(f.ready).not.toHaveBeenCalled();
      if (choice === "discard") f.controller.discard();
      else f.controller.keepRecording();
      expect(f.ready).toHaveBeenCalledTimes(choice === "discard" ? 0 : 1);
    },
  );
  it("emits actual measured level history rather than an animated placeholder", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start("google", "verbatim");
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
    await f.controller.start("google", "verbatim");
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.changed.mock.lastCall?.[0].phase).toBe("idle");
    expect(f.ready).not.toHaveBeenCalled();
  });
  it("keeps interrupted audio out of automatic transcription", async () => {
    const f = fixture();
    await f.controller.start("google", "verbatim");
    f.native.onerror?.();
    f.complete();
    expect(f.ready.mock.calls[0][1]).toBe(true);
  });
});
