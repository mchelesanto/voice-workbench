import { PROVIDERS, type Mode, type Provider } from "../shared/contracts";
import type { Recording, CaptureContext } from "./recording";

export type RecorderPhase =
  | "idle"
  | "permission"
  | "recording"
  | "paused"
  | "stopping"
  | "review";
export type RecorderSnapshot = {
  phase: RecorderPhase;
  elapsed: number;
  levels: number[];
  meterAvailable: boolean;
  confirmDiscard: boolean;
  provider: Provider;
  mode: Mode;
  error: string;
};
export type InputMeter = { read: () => number; close: () => void };
export type RecorderDependencies = {
  stream: () => Promise<MediaStream>;
  recorder: (stream: MediaStream) => MediaRecorder;
  meter: (stream: MediaStream) => InputMeter | undefined;
  now: () => number;
};
type Session = {
  context: CaptureContext;
  quarantined: boolean;
  provider: Provider;
  mode: Mode;
  chunks: Blob[];
  bytes: number;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  meter?: InputMeter;
  timer?: ReturnType<typeof setInterval>;
  started?: number;
  ended?: number;
  pausedAt?: number;
  pausedMs: number;
  trackStates?: { track: MediaStreamTrack; enabled: boolean }[];
  damaged: boolean;
  released: boolean;
  completed?: Recording;
};
export const initialRecorderState = (): RecorderSnapshot => ({
  phase: "idle",
  elapsed: 0,
  levels: Array(36).fill(0),
  meterAvailable: false,
  confirmDiscard: false,
  provider: "google",
  mode: "verbatim",
  error: "",
});

/** Each session owns its resources, including late permission and stop events. */
export class RecorderController {
  private active?: Session;
  private state = initialRecorderState();
  constructor(
    private readonly dependencies: RecorderDependencies,
    private readonly changed: (state: RecorderSnapshot) => void,
    private readonly ready: (recording: Recording, damaged: boolean) => void,
    private readonly abandoned: (context: CaptureContext) => void = () => {},
  ) {}
  private update(next: Partial<RecorderSnapshot>) {
    this.state = { ...this.state, ...next };
    this.changed(this.state);
  }
  private release(session: Session) {
    if (session.released) return;
    session.released = true;
    clearInterval(session.timer);
    try {
      session.meter?.close();
    } catch {
      /* Meter cleanup must not retain the microphone. */
    }
    session.stream?.getTracks().forEach((track) => track.stop());
  }
  private detach(session: Session) {
    if (session.recorder) {
      session.recorder.ondataavailable = null;
      session.recorder.onstop = null;
      session.recorder.onerror = null;
    }
  }
  private elapsed(session: Session) {
    return Math.max(
      0,
      Math.round(
        (session.ended ?? session.pausedAt ?? this.dependencies.now()) -
          session.started! -
          session.pausedMs,
      ),
    );
  }
  private startTimer(session: Session) {
    clearInterval(session.timer);
    session.timer = setInterval(() => {
      if (this.active !== session || this.state.phase !== "recording") return;
      const elapsed = this.elapsed(session);
      let level = 0;
      try {
        level = session.meter?.read() ?? 0;
      } catch {
        try {
          session.meter?.close();
        } catch {
          /* Capture remains independent of metering. */
        }
        session.meter = undefined;
      }
      this.update({
        elapsed,
        meterAvailable: !!session.meter,
        levels: [
          ...this.state.levels.slice(1),
          Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0,
        ],
      });
      if (
        elapsed >=
        PROVIDERS[session.provider].maxRecordingSeconds * 1000 - 1000
      )
        this.stop();
    }, 100);
  }
  async start(provider: Provider, mode: Mode, context: CaptureContext) {
    if (this.active) return;
    const session: Session = {
      context: { ...context, vocabulary: [...context.vocabulary] },
      quarantined: false,
      provider,
      mode,
      chunks: [],
      bytes: 0,
      damaged: false,
      released: false,
      pausedMs: 0,
    };
    this.active = session;
    this.state = initialRecorderState();
    this.update({ phase: "permission", provider, mode });
    try {
      const stream = await this.dependencies.stream();
      if (this.active !== session) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      session.stream = stream;
      const recorder = this.dependencies.recorder(stream);
      session.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (this.active !== session) return;
        if (event.data.size) {
          session.chunks.push(event.data);
          session.bytes += event.data.size;
        }
        if (
          session.bytes >=
          PROVIDERS[session.provider].maxAudioBytes - 1024 * 1024
        ) {
          if (this.state.phase === "paused")
            this.update({ confirmDiscard: true });
          this.stop();
        }
      };
      recorder.onerror = () => {
        if (this.active !== session) return;
        session.damaged = true;
        this.update({
          error:
            "Recording was interrupted. You can recover the captured audio.",
        });
        this.stop();
      };
      recorder.onstop = () => this.finished(session);
      session.started = this.dependencies.now();
      recorder.start(250);
      try {
        session.meter = this.dependencies.meter(stream);
      } catch {
        /* Capture can work without a meter. */
      }
      this.update({ phase: "recording", meterAvailable: !!session.meter });
      this.startTimer(session);
    } catch (error) {
      if (this.active !== session) return;
      this.active = undefined;
      this.abandoned(session.context);
      this.detach(session);
      this.release(session);
      this.update({
        phase: "idle",
        error:
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "Microphone access is blocked. Allow it in your site settings, then try again."
            : error instanceof DOMException && error.name === "NotFoundError"
              ? "No microphone found. Connect a microphone, then try again."
              : "Recording could not start. Check your microphone and use a recent browser.",
      });
    }
  }
  stop() {
    const session = this.active;
    if (
      !session?.recorder ||
      !["recording", "paused"].includes(this.state.phase)
    )
      return;
    session.ended = session.pausedAt ?? this.dependencies.now();
    this.update({
      phase: "stopping",
      elapsed: this.elapsed(session),
      meterAvailable: false,
    });
    try {
      if (session.recorder.state !== "inactive") session.recorder.stop();
    } catch {
      session.damaged = true;
      this.update({
        error: "Recording was interrupted. You can recover the captured audio.",
      });
      this.finished(session);
    } finally {
      // End microphone access now; queued final data still belongs to this session.
      this.release(session);
    }
  }
  private finished(session: Session) {
    if (this.active !== session || session.completed) return;
    if (session.ended === undefined) {
      session.damaged = true;
      this.update({
        error:
          "Recording stopped unexpectedly. Review or download the captured audio before transcribing.",
      });
    }
    this.detach(session);
    this.release(session);
    const durationMs = this.elapsed(session);
    if (!session.chunks.length) {
      this.active = undefined;
      this.abandoned(session.context);
      this.update({
        phase: "idle",
        confirmDiscard: false,
        error: "No audio was captured. Please try again.",
      });
      return;
    }
    const blob = new Blob(session.chunks, { type: session.recorder!.mimeType });
    session.chunks = [];
    session.completed = {
      ...session.context,
      readOnly: session.quarantined,
      kind: "recording",
      blob,
      mime: blob.type,
      durationMs,
      provider: session.provider,
      mode: session.mode,
      state: "recorded",
    };
    if (this.state.confirmDiscard)
      this.update({
        phase: "review",
        elapsed: durationMs,
        meterAvailable: false,
      });
    else this.deliver(session);
  }
  private deliver(session: Session) {
    if (this.active !== session || !session.completed) return;
    this.active = undefined;
    this.update({ phase: "idle", confirmDiscard: false });
    this.ready(
      { ...session.completed, readOnly: session.quarantined },
      session.damaged || session.quarantined,
    );
  }
  pause() {
    const session = this.active;
    if (!session?.recorder || this.state.phase !== "recording") return;
    session.pausedAt = this.dependencies.now();
    clearInterval(session.timer);
    session.trackStates = session
      .stream!.getTracks()
      .map((track) => ({ track, enabled: track.enabled }));
    session.trackStates.forEach(({ track }) => {
      track.enabled = false;
    });
    this.update({
      phase: "paused",
      elapsed: this.elapsed(session),
      meterAvailable: false,
    });
    try {
      session.recorder.pause();
    } catch {
      session.damaged = true;
      this.update({
        error:
          "Recording could not pause. The captured audio is available for recovery.",
      });
      this.stop();
    }
  }
  resume() {
    const session = this.active;
    if (
      !session?.recorder ||
      this.state.phase !== "paused" ||
      this.state.confirmDiscard
    )
      return;
    if (
      this.elapsed(session) >=
        PROVIDERS[session.provider].maxRecordingSeconds * 1000 - 1000 ||
      session.bytes >= PROVIDERS[session.provider].maxAudioBytes - 1024 * 1024
    ) {
      this.update({ confirmDiscard: true });
      this.stop();
      return;
    }
    try {
      if (
        session
          .stream!.getTracks()
          .some((track) => track.readyState === "ended")
      )
        throw new Error("Microphone ended");
      session.recorder.resume();
      session.pausedMs += Math.max(
        0,
        this.dependencies.now() - session.pausedAt!,
      );
      session.pausedAt = undefined;
      session.trackStates?.forEach(({ track, enabled }) => {
        track.enabled = enabled;
      });
      session.trackStates = undefined;
      this.update({ phase: "recording", meterAvailable: !!session.meter });
      this.startTimer(session);
    } catch {
      session.damaged = true;
      this.update({
        error:
          "Recording could not resume. The captured audio is available for recovery.",
      });
      this.stop();
    }
  }
  requestDiscard() {
    if (this.state.phase === "permission") this.discard();
    else if (
      ["recording", "paused", "stopping", "review"].includes(this.state.phase)
    ) {
      this.update({ confirmDiscard: true });
      this.pause();
    }
  }
  dismissDiscard() {
    if (this.state.phase === "paused") this.update({ confirmDiscard: false });
  }
  continueCapture(expected: "paused" | "review") {
    if (
      !this.active ||
      !this.state.confirmDiscard ||
      this.state.phase !== expected
    )
      return;
    if (this.state.phase === "review" && this.active.completed) {
      this.update({ confirmDiscard: false });
      this.deliver(this.active);
    } else if (this.state.phase === "paused") {
      this.update({ confirmDiscard: false });
      this.resume();
    }
  }
  quarantineAndStop() {
    const session = this.active;
    if (!session) return;
    if (this.state.phase === "permission") {
      this.discard();
      return;
    }
    session.quarantined = true;
    this.update({ confirmDiscard: false });
    if (session.completed) this.deliver(session);
    else this.stop();
  }
  discard(notify = true) {
    const session = this.active;
    this.active = undefined;
    if (session) {
      this.abandoned(session.context);
      this.detach(session);
      try {
        if (session.recorder && session.recorder.state !== "inactive")
          session.recorder.stop();
      } catch {
        /* Tracks are still released below. */
      }
      this.release(session);
      session.chunks = [];
      session.completed = undefined;
    }
    this.state = initialRecorderState();
    if (notify) this.changed(this.state);
  }
  clearError() {
    this.update({ error: "" });
  }
}
