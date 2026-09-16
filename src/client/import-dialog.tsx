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
import { supportsMode, type Mode, type Provider } from "../shared/contracts";
import type { Recording } from "./local-store";
import {
  inspectAudioFile,
  importDurationError,
  type AudioImport,
} from "./audio-import";
import { AudioPlayer, type PlaybackDuration } from "./audio-player";
import { duration } from "./export";

type Selection = AudioImport & {
  key: string;
  durationMs?: number;
  error?: string;
  playbackFailed?: boolean;
};
export function ImportDialog({
  config,
  settingsReady,
  provider: initialProvider,
  mode: initialMode,
  close,
  transcribe,
}: {
  config: AppConfig | null;
  settingsReady: boolean;
  provider: Provider;
  mode: Mode;
  close: () => void;
  transcribe: (recording: Recording) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null),
    inspection = useRef<AbortController | null>(null),
    counter = useRef(0),
    committed = useRef(false);
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
    [dragging, setDragging] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      inspection.current?.abort();
      dialog?.close();
    };
  }, []);
  const read = async (files: FileList | File[]) => {
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
    try {
      const result = await inspectAudioFile(files[0], controller.signal);
      if (!controller.signal.aborted)
        setSelection({ ...result, key: `import-${ticket}` });
    } catch (e) {
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
              error: importDurationError(result.durationMs),
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
              error: undefined,
            }
          : current,
      ),
    [],
  );
  const available = !!config?.providers.find((item) => item.id === provider)
    ?.available;
  const canSend =
    !!selection?.durationMs &&
    !selection.error &&
    available &&
    !busy &&
    settingsReady &&
    supportsMode(provider, mode);
  const send = () => {
    if (!canSend || !selection || committed.current) return;
    committed.current = true;
    inspection.current?.abort();
    transcribe({
      kind: "recording",
      id: crypto.randomUUID(),
      blob: selection.blob,
      mime: selection.mime,
      durationMs: Math.round(selection.durationMs!),
      createdAt: new Date().toISOString(),
      provider,
      mode,
      state: "recorded",
    });
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
          <small>Up to 25 MiB · 10 minutes</small>
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
      {(error || selection?.error) && (
        <p className="notice import-error" role="alert">
          {error || selection?.error}
        </p>
      )}
      <div className="import-options">
        <div>
          <label className="field-label" htmlFor={providerId}>
            Transcription provider
          </label>
          <select
            id={providerId}
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
      {!available && (
        <p className="field-hint">
          Choose a configured provider to transcribe this file.
        </p>
      )}
      {!settingsReady && (
        <p className="notice" role="status">
          Transcription is unavailable until vocabulary settings load. Close
          this dialog and check the connection, then try again.
        </p>
      )}
      <p className="import-privacy">
        <AudioLines size={16} />
        Your file stays here until you choose Transcribe.
      </p>
      <div className="modal-actions">
        <button className="secondary" onClick={close}>
          Cancel
        </button>
        <button className="primary" disabled={!canSend} onClick={send}>
          Transcribe
          <ArrowRight size={17} />
        </button>
      </div>
    </dialog>
  );
}
