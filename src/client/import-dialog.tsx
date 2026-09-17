"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AudioLines,
  Upload,
  X,
  LoaderCircle,
  ArrowRight,
  FileAudio,
} from "lucide-react";
import type { AppConfig } from "../shared/responses";
import {
  PROVIDERS,
  supportsMode,
  type Mode,
  type Provider,
} from "../shared/contracts";
import type { Recording, CaptureContext } from "./recording";
import {
  inspectAudioFile,
  validateImportSize,
  importDurationError,
  type AudioImport,
} from "./audio-import";
import { AudioPlayer, type PlaybackDuration } from "./audio-player";
import { duration } from "./export";

type Selection = AudioImport & {
  key: string;
  durationMs?: number;
  playbackFailed?: boolean;
};
export function ImportDialog({
  config,
  settingsReady,
  cachedWords,
  retryConnection,
  provider: initialProvider,
  mode: initialMode,
  close,
  transcribe,
  reserve,
  release,
  freeze,
}: {
  config: AppConfig | null;
  settingsReady: boolean;
  cachedWords: boolean;
  retryConnection: () => Promise<void>;
  provider: Provider;
  mode: Mode;
  close: () => void;
  transcribe: (recording: Recording, reservation: string) => void;
  reserve: (bytes: number) => string;
  release: (token: string) => void;
  freeze: (provider: Provider, mode: Mode) => Promise<CaptureContext>;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null),
    inspection = useRef<AbortController | null>(null),
    counter = useRef(0),
    committed = useRef(false);
  const reservation = useRef<string | null>(null);
  const alive = useRef(true);
  const releaseRef = useRef(release);
  useEffect(() => {
    releaseRef.current = release;
  }, [release]);
  const titleId = useId(),
    providerId = useId(),
    modeId = useId();
  const [provider, setProvider] = useState(initialProvider),
    [mode, setMode] = useState<Mode>(
      supportsMode(initialProvider, initialMode) ? initialMode : "verbatim",
    );
  const [selection, setSelection] = useState<Selection | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [dragging, setDragging] = useState(false),
    [checking, setChecking] = useState(false);
  useEffect(() => {
    alive.current = true;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      alive.current = false;
      inspection.current?.abort();
      if (reservation.current) releaseRef.current(reservation.current);
      reservation.current = null;
      dialog?.close();
    };
  }, []);
  const read = async (files: FileList | File[]) => {
    if (committed.current) return;
    if (reservation.current) releaseRef.current(reservation.current);
    reservation.current = null;
    inspection.current?.abort();
    const controller = new AbortController();
    inspection.current = controller;
    const ticket = ++counter.current;
    setSelection(null);
    setError("");
    setDragging(false);
    if (files.length !== 1) {
      setBusy(false);
      setError("Choose one audio file at a time.");
      return;
    }
    setBusy(true);
    let token: string | undefined;
    try {
      validateImportSize(files[0].size);
      token = reserve(files[0].size);
      reservation.current = token;
      const result = await inspectAudioFile(files[0], controller.signal);
      if (!controller.signal.aborted)
        setSelection({ ...result, key: `import-${ticket}` });
    } catch (e) {
      if (token) {
        releaseRef.current(token);
        if (reservation.current === token) reservation.current = null;
      }
      if (!controller.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : "This audio file could not be opened.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const onDuration = useCallback(
    (result: PlaybackDuration) =>
      setSelection((current) =>
        current?.key === result.sourceKey
          ? {
              ...current,
              durationMs: result.durationMs,
            }
          : current,
      ),
    [],
  );
  const onFailure = useCallback(
    (key: string) =>
      setSelection((current) =>
        current?.key === key
          ? {
              ...current,
              durationMs: undefined,
              playbackFailed: true,
            }
          : current,
      ),
    [],
  );
  const available = !!config?.providers.find((item) => item.id === provider)
    ?.available;
  const limits = PROVIDERS[provider];
  const selectionError = selection
    ? selection.blob.size > limits.maxAudioBytes
      ? `${limits.label} supports files up to ${Math.round(limits.maxAudioBytes / 1_000_000)} MB through this upload. Choose another provider or a smaller file.`
      : selection.durationMs !== undefined
        ? importDurationError(selection.durationMs, provider)
        : undefined
    : undefined;
  const canSend =
    !!selection?.durationMs &&
    !selectionError &&
    available &&
    !busy &&
    !checking &&
    settingsReady &&
    supportsMode(provider, mode);
  const send = async () => {
    if (!canSend || !selection || committed.current || !reservation.current)
      return;
    committed.current = true;
    setBusy(true);
    const token = reservation.current,
      ticket = counter.current;
    try {
      const context = await freeze(provider, mode);
      if (
        !alive.current ||
        ticket !== counter.current ||
        reservation.current !== token
      )
        return;
      reservation.current = null;
      transcribe(
        {
          ...context,
          kind: "recording",
          blob: selection.blob,
          mime: selection.mime,
          durationMs: Math.round(selection.durationMs!),
          provider,
          mode,
          state: "recorded",
        },
        token,
      );
    } catch (error) {
      if (alive.current)
        setError(
          error instanceof Error
            ? error.message
            : "The recording context could not be loaded.",
        );
    } finally {
      committed.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <dialog
      ref={ref}
      className="modal import-modal"
      aria-labelledby={titleId}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        void read(event.dataTransfer.files);
      }}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="import-content">
        <header className="modal-heading">
          <div>
            <span className="dialog-eyebrow">FROM YOUR FILES</span>
            <h2 id={titleId}>Bring your audio.</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close import"
            onClick={close}
          >
            <X size={20} />
          </button>
        </header>
        <p className="modal-intro">
          Preview a recording, choose how to transcribe it, and make it a note.
        </p>
        <input
          ref={input}
          type="file"
          accept="audio/*,.mp3,.m4a,.mp4,.wav,.ogg,.opus,.webm"
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose audio file"
          onChange={(event) => {
            if (event.target.files?.length) void read(event.target.files);
            event.target.value = "";
          }}
        />
        {!selection ? (
          <button
            type="button"
            className={`audio-dropzone ${dragging ? "is-dragging" : ""}`}
            onClick={() => input.current?.click()}
          >
            <span className="dropzone-icon">
              {busy ? (
                <LoaderCircle className="spin" size={27} />
              ) : (
                <Upload size={27} />
              )}
            </span>
            <strong>
              {busy ? "Checking your audio…" : "Choose a file or drop it here"}
            </strong>
            <span>MP3, M4A, WAV, Ogg/Opus, WebM</span>
            <small>Limits follow your selected provider</small>
          </button>
        ) : (
          <section className="import-preview" aria-label="Selected audio file">
            <div className="import-file-heading">
              <FileAudio size={24} />
              <div>
                <strong title={selection.name}>{selection.name}</strong>
                <span>
                  {selection.blob.size < 1024 * 1024
                    ? `${Math.ceil(selection.blob.size / 1024)} KiB`
                    : `${(selection.blob.size / 1024 / 1024).toFixed(1)} MiB`}{" "}
                  ·{" "}
                  {selection.playbackFailed
                    ? "Duration unavailable"
                    : selection.durationMs
                      ? duration(selection.durationMs)
                      : "Reading duration…"}
                </span>
              </div>
              <button
                className="text-button"
                onClick={() => input.current?.click()}
              >
                Replace
              </button>
            </div>
            <AudioPlayer
              key={selection.key}
              blob={selection.blob}
              sourceKey={selection.key}
              onDuration={onDuration}
              onFailure={onFailure}
              errorMessage="This file cannot be played here. Choose another audio file."
            />
          </section>
        )}
        {(error || selectionError) && (
          <p className="notice import-error" role="alert">
            {error || selectionError}
          </p>
        )}
        <div className="import-options">
          <div>
            <label className="field-label" htmlFor={providerId}>
              Transcription provider
            </label>
            <select
              id={providerId}
              disabled={busy}
              value={provider}
              onChange={(event) => {
                const next = event.target.value as Provider;
                setProvider(next);
                if (!supportsMode(next, mode)) setMode("verbatim");
              }}
            >
              {(["google", "mistral"] as const).map((id) => (
                <option
                  key={id}
                  value={id}
                  disabled={
                    !config?.providers.find((item) => item.id === id)?.available
                  }
                >
                  {id === "google" ? "Google" : "Mistral"}
                  {config?.providers.find((item) => item.id === id)?.available
                    ? ""
                    : " · not configured"}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor={modeId}>
              Transcription mode
            </label>
            <select
              id={modeId}
              disabled={busy}
              value={mode}
              onChange={(event) => setMode(event.target.value as Mode)}
            >
              <option value="verbatim">Verbatim</option>
              {supportsMode(provider, "smart") && (
                <option value="smart">Polished</option>
              )}
            </select>
          </div>
        </div>
        <p className="field-hint">
          {limits.label}: up to {limits.maxRecordingSeconds / 60} minutes ·{" "}
          {Math.round(limits.maxAudioBytes / 1_000_000)} MB per file
        </p>
        {!available && (
          <p className="field-hint">
            Choose a configured provider to transcribe this file.
          </p>
        )}
        {(!settingsReady || !config) && (
          <div className="notice" role="status">
            <p>
              Transcription is unavailable until settings load. Your selected
              file stays here.
            </p>
          </div>
        )}
        <p className="import-privacy">
          <AudioLines size={16} />
          Your original file stays unchanged. Imported audio is temporary in
          this tab.
        </p>
        {cachedWords && (
          <p className="field-hint">
            Offline: use the last loaded words and keep this audio in the tab.
            Reconnect before transcribing.
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button className="secondary" onClick={close}>
          Cancel
        </button>
        {!settingsReady || !config ? (
          <button
            className="primary"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              try {
                await retryConnection();
              } finally {
                setChecking(false);
              }
            }}
          >
            {checking ? "Checking connection…" : "Check connection"}
          </button>
        ) : (
          <button
            className="primary"
            disabled={!canSend}
            onClick={() => void send()}
          >
            {cachedWords ? "Keep with cached words" : "Transcribe"}
            <ArrowRight size={17} />
          </button>
        )}
      </div>
    </dialog>
  );
}
