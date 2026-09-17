import { PROVIDERS, type Mode, type Provider } from "../shared/contracts";
import type { Recording } from "./local-store";

export type RecorderPhase =
  | "idle"
  | "permission"
  | "recording"
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
  async start(provider: Provider, mode: Mode) {
    if (this.active) return;
    const session: Session = {
      provider,
      mode,
      chunks: [],
      bytes: 0,
      damaged: false,
      released: false,
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
        )
          this.stop();
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
      session.timer = setInterval(() => {
        if (this.active !== session || this.state.phase !== "recording") return;
        const elapsed = Math.max(
          0,
          Math.round(this.dependencies.now() - session.started!),
        );
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
    } catch (error) {
      if (this.active !== session) return;
      this.active = undefined;
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
    if (!session?.recorder || this.state.phase !== "recording") return;
    session.ended = this.dependencies.now();
    this.update({ phase: "stopping" });
    try {
      if (session.recorder.state !== "inactive") session.recorder.stop();
    } catch {
      session.damaged = true;
      this.update({
        error: "Recording was interrupted. You can recover the captured audio.",
      });
      this.finished(session);
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
    const durationMs = Math.max(
      0,
      Math.round((session.ended ?? this.dependencies.now()) - session.started!),
    );
    if (!session.chunks.length) {
      this.active = undefined;
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
      kind: "recording",
      id: crypto.randomUUID(),
      blob,
      mime: blob.type,
      durationMs,
      createdAt: new Date().toISOString(),
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
    this.ready(session.completed, session.damaged);
  }
  requestDiscard() {
    if (this.state.phase === "permission") this.discard();
    else if (
      this.state.phase === "recording" ||
      this.state.phase === "stopping"
    )
      this.update({ confirmDiscard: true });
  }
  keepRecording() {
    if (
      !this.active ||
      !this.state.confirmDiscard ||
      !["recording", "review"].includes(this.state.phase)
    )
      return;
    this.update({ confirmDiscard: false });
    if (this.active.completed) this.deliver(this.active);
  }
  discard(notify = true) {
    const session = this.active;
    this.active = undefined;
    if (session) {
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
