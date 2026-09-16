import { describe, it, expect, vi, afterEach } from "vitest";
import {
  prepareAudioPlayback,
  playbackSourceKey,
} from "../src/client/audio-playback";

class Media extends EventTarget {
  seekable = { length: 0, start: () => 0, end: () => this.duration };
  duration = NaN;
  readyState = 0;
  error: object | null = null;
  seeking = false;
  seeks: number[] = [];
  position = 0;
  seekAction?: (value: number) => void;
  get currentTime() {
    return this.position;
  }
  set currentTime(value: number) {
    this.seeks.push(value);
    this.position = value;
    this.seekAction?.(value);
  }
  metadata(duration: number) {
    this.duration = duration;
    this.readyState = 1;
    this.dispatchEvent(new Event("loadedmetadata"));
  }
  get element() {
    return this as unknown as HTMLAudioElement;
  }
}
afterEach(() => vi.useRealTimers());
describe("Local audio playback preparation", () => {
  it.each([0.025, 1.25])(
    "returns to the positive seekable start %s",
    async (beginning) => {
      vi.useFakeTimers();
      const media = new Media();
      media.seekable = { length: 1, start: () => beginning, end: () => 69 };
      media.seekAction = (value) => {
        if (value === Number.MAX_SAFE_INTEGER) {
          media.duration = 69;
          media.position = 69;
          media.dispatchEvent(new Event("durationchange"));
        } else {
          media.position = Math.max(beginning, value);
          media.seeking = false;
          media.dispatchEvent(new Event("seeked"));
        }
      };
      const promise = prepareAudioPlayback(
        media.element,
        new AbortController().signal,
        100,
      );
      const actual = promise.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      media.metadata(Infinity);
      await vi.advanceTimersByTimeAsync(100);
      expect(await actual).toEqual({ value: 69 });
      expect(media.currentTime).toBe(beginning);
    },
  );
  it("keeps source identity across IndexedDB-style clones without retaining the blob", () => {
    const source = {
      id: "recording-a",
      createdAt: "2026-09-16T00:00:00.000Z",
      durationMs: 1000,
      mime: "audio/webm",
      blob: new Blob(["audio"], { type: "audio/webm" }),
    };
    const clone = structuredClone(source);
    expect(clone.blob).not.toBe(source.blob);
    expect(playbackSourceKey(clone)).toBe(playbackSourceKey(source));
    expect(playbackSourceKey({ ...source, id: "recording-b" })).not.toBe(
      playbackSourceKey(source),
    );
    expect(
      playbackSourceKey({
        ...source,
        blob: new Blob(["other audio"], { type: "audio/webm" }),
      }),
    ).not.toBe(playbackSourceKey(source));
  });
  it("leaves finite media at the beginning without scanning", async () => {
    const media = new Media();
    const promise = prepareAudioPlayback(
      media.element,
      new AbortController().signal,
    );
    media.metadata(69.25);
    expect(await promise).toBe(69.25);
    expect(media.seeks).toEqual([]);
  });
  it("discovers the end of durationless media and waits for the return to zero", async () => {
    const media = new Media();
    let rewinding = false;
    media.seekAction = (value) => {
      media.seeking = true;
      if (value === Number.MAX_SAFE_INTEGER) {
        media.duration = 69.25;
        media.position = 69.25;
        media.dispatchEvent(new Event("durationchange"));
      } else {
        rewinding = true;
      }
    };
    const promise = prepareAudioPlayback(
      media.element,
      new AbortController().signal,
    );
    media.metadata(Infinity);
    await vi.waitFor(() => expect(rewinding).toBe(true));
    let done = false;
    void promise.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    media.seeking = false;
    media.dispatchEvent(new Event("seeked"));
    expect(await promise).toBe(69.25);
    expect(media.position).toBe(0);
    expect(media.seeks).toEqual([Number.MAX_SAFE_INTEGER, 0]);
  });
  it("stops on cancellation and ignores late metadata", async () => {
    const media = new Media();
    const controller = new AbortController();
    const promise = prepareAudioPlayback(media.element, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    media.metadata(Infinity);
    expect(media.seeks).toEqual([]);
  });
  it("does not expose a player when duration discovery never finishes", async () => {
    vi.useFakeTimers();
    const media = new Media();
    const promise = prepareAudioPlayback(
      media.element,
      new AbortController().signal,
      100,
    );
    const failure = expect(promise).rejects.toMatchObject({
      name: "TimeoutError",
    });
    media.metadata(Infinity);
    await vi.advanceTimersByTimeAsync(100);
    await failure;
  });
  it("rejects media errors without waiting for the deadline", async () => {
    const media = new Media();
    const promise = prepareAudioPlayback(
      media.element,
      new AbortController().signal,
    );
    media.error = {};
    media.dispatchEvent(new Event("error"));
    await expect(promise).rejects.toThrow("Audio could not be loaded.");
  });
  it("rejects empty media rather than presenting an unusable timeline", async () => {
    const media = new Media();
    const promise = prepareAudioPlayback(
      media.element,
      new AbortController().signal,
    );
    media.metadata(0);
    await expect(promise).rejects.toThrow();
  });
  it("rejects a failed seek and clears its deadline", async () => {
    vi.useFakeTimers();
    const media = new Media();
    media.seekAction = () => {
      throw new Error("Seek unavailable");
    };
    const promise = prepareAudioPlayback(
      media.element,
      new AbortController().signal,
    );
    media.metadata(Infinity);
    await expect(promise).rejects.toThrow("Seek unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });
});
