import { LIMITS, type Note } from "../shared/contracts";
import type { Recording } from "./recording";
import {
  recordingConfirmation,
  sameRecordingSnapshot,
} from "./recording-recovery";
function immutable(record: Recording): Recording {
  return Object.freeze({
    ...record,
    vocabulary: Object.freeze([...record.vocabulary]),
    ...(record.result ? { result: Object.freeze({ ...record.result }) } : {}),
  });
}
export const AUDIO_MEMORY_BUDGET = 2 * LIMITS.maxAudioBytes;
export class TemporaryAudio {
  private records = new Map<string, Recording>();
  private reservations = new Map<string, number>();
  private listeners = new Set<() => void>();
  private value: readonly Recording[] = [];
  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish() {
    this.value = Object.freeze([...this.records.values()]);
    this.listeners.forEach((fn) => fn());
  }
  get bytes() {
    return this.value.reduce((n, r) => n + r.blob.size, 0);
  }
  reserve(bytes: number) {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      this.bytes +
        [...this.reservations.values()].reduce((a, b) => a + b, 0) +
        bytes >
        AUDIO_MEMORY_BUDGET
    )
      throw new Error(
        "Temporary audio is full. Download or remove a recording before adding another.",
      );
    const token = crypto.randomUUID();
    this.reservations.set(token, bytes);
    return token;
  }
  release(token: string) {
    this.reservations.delete(token);
  }
  retain(token: string, record: Recording) {
    if (!this.reservations.has(token) || this.records.has(record.id))
      return false;
    this.reservations.delete(token);
    // Late native chunks are retained even above the reservation. New work is blocked by the budget.
    this.records.set(record.id, immutable(record));
    this.publish();
    return true;
  }
  read(id: string) {
    return this.records.get(id);
  }
  begin(expected: Recording) {
    const current = this.read(expected.id);
    if (
      !current ||
      current.readOnly ||
      current.result ||
      !sameRecordingSnapshot(current, expected)
    )
      return;
    const next = {
      ...current,
      state: "transcribing" as const,
      attemptId: crypto.randomUUID(),
      error: undefined,
      errorCode: undefined,
    };
    this.records.set(next.id, immutable(next));
    this.publish();
    return next;
  }
  complete(expected: Recording, next: Recording) {
    const current = this.read(expected.id);
    if (
      !current ||
      current.readOnly ||
      next.id !== expected.id ||
      next.attemptId !== expected.attemptId ||
      !sameRecordingSnapshot(current, expected)
    )
      return;
    this.records.set(next.id, immutable(next));
    this.publish();
    return next;
  }
  markText(id: string) {
    const current = this.read(id);
    if (current && !current.readOnly) {
      this.records.set(id, immutable({ ...current, textDurable: true }));
      this.publish();
    }
  }
  confirm(note: Note) {
    const current = this.read(note.id);
    if (!current || current.readOnly) return;
    const next = recordingConfirmation(current, note);
    if (next) {
      this.records.set(next.id, immutable({ ...next, textDurable: true }));
      this.publish();
    }
  }
  remove(expected: Recording) {
    const current = this.read(expected.id);
    if (current && !sameRecordingSnapshot(current, expected)) return false;
    this.records.delete(expected.id);
    this.publish();
    return true;
  }
  quarantine() {
    for (const [id, r] of this.records)
      this.records.set(id, immutable({ ...r, readOnly: true }));
    this.publish();
  }
  resume(generation: number) {
    for (const [id, r] of this.records)
      if (r.generation === generation)
        this.records.set(id, immutable({ ...r, readOnly: false }));
    this.publish();
  }
  clear() {
    this.records.clear();
    this.reservations.clear();
    this.publish();
  }
}
