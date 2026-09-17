import type { CreateNote, Mode, Provider } from "../shared/contracts";
import type { ErrorCode } from "../shared/responses";
export type CaptureContext = {
  id: string;
  generation: number;
  areaId: string | null;
  areaLabel: string;
  vocabulary: readonly string[];
  createdAt: string;
  localResetId: string | null;
  cached?: boolean;
};
export type Recording = CaptureContext & {
  kind: "recording";
  blob: Blob;
  mime: string;
  durationMs: number;
  provider: Provider;
  mode: Mode;
  state:
    | "recorded"
    | "transcribing"
    | "unknown"
    | "error"
    | "transcribed"
    | "cloud_confirmed";
  result?: CreateNote;
  error?: string;
  errorCode?: ErrorCode;
  attemptId?: string;
  textDurable?: boolean;
  readOnly?: boolean;
  superseded?: boolean;
};
export type LegacyRecording = Recording & {
  legacy: true;
  storageKey: string;
  snapshotToken: string;
};
