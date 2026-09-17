"use client";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { z } from "zod";
import {
  ArrowDownToLine,
  Upload,
  ArrowRight,
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cloud,
  Copy,
  FileText,
  FolderOpen,
  Headphones,
  LoaderCircle,
  Menu,
  Mic,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  PROVIDERS,
  supportsMode,
  createNoteSchema,
  noteSchema,
  settingsSchema,
  type Area,
  type CreateNote,
  type Mode,
  type NotePage,
  type Provider,
  type Settings,
  type Enhancement,
  type Note,
} from "../shared/contracts";
import {
  areaPageSchema,
  configSchema,
  enhancementResultSchema,
  notePageSchema,
  transcriptionResultSchema,
  classifySettingsConflict,
  sameVocabularyTerms,
  classifyCreateReplay,
  type AppConfig,
} from "../shared/responses";
import { ClientError, message, request, modelFailureState } from "./api";
import { EditorSession, type Draft, type EditorPorts } from "./editor";
import {
  listLocal,
  putLocal,
  removeLocal,
  retireRecovered,
  mergeLocalRecords,
  needsLocalAttention,
  warnBeforeLeaving,
  removeLegacy,
  extractLegacy,
  removeArchived,
  removeUnknown,
  type LocalRecord,
  type VisibleRecord,
  type UnknownRecord,
} from "./local-store";
import type { Recording, LegacyRecording, CaptureContext } from "./recording";
import { TemporaryAudio } from "./temporary-audio";
import { LibraryController } from "./library-controller";
import { download, duration, exportNote } from "./export";
import { useRecorder } from "./use-recorder";
import { RecordingDialog } from "./recording-dialog";
import { ImportDialog } from "./import-dialog";
import { ProcessingStatus } from "./processing-status";
import { VocabularyEditor } from "./vocabulary-editor";
import {
  prepareVocabularySave,
  hasPendingVocabulary,
  sortedVocabulary,
  type VocabularyInput,
} from "./vocabulary-input";
import { audioExtension } from "../shared/audio-format";
import { playbackSourceKey } from "./audio-playback";
import { AudioPlayer, type PlaybackDuration } from "./audio-player";
import {
  recordingRecovery,
  captureIsReadOnly,
  recordingProvider,
  recordingProgress,
  type RecordingPhase,
} from "./recording-recovery";

const emptyPage: NotePage = { generation: 0, items: [], nextCursor: null };
const statuses = {
  archived: "Read-only copy",
  saved: "Saved to cloud",
  local: "Saved on this device",
  saving: "Syncing note",
  local_error: "Not saved yet",
  error: "Cloud unavailable",
  conflict: "Two versions",
  deleted: "Note deleted",
  deleting: "Deleting",
};
function date(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
  }).format(new Date(value));
}
function localDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
function transcriptTitle(text: string) {
  const line = text.split(/\r?\n/)[0].trim();
  const characters = [...line];
  if (characters.length <= 72) return line;
  const prefix = characters.slice(0, 72).join("");
  const boundary = prefix.lastIndexOf(" ");
  return (boundary > 36 ? prefix.slice(0, boundary) : prefix) + "…";
}
function Wave({ animated = false }: { animated?: boolean }) {
  return (
    <span className={`wave ${animated ? "wave-live" : ""}`} aria-hidden="true">
      {Array.from({ length: 27 }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}
function Modal({
  title,
  children,
  close,
  wide = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    return () => {
      el?.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`modal ${wide ? "modal-wide" : ""} ${className}`}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const box = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < box.left ||
            e.clientX > box.right ||
            e.clientY < box.top ||
            e.clientY > box.bottom
          )
            close();
        }
      }}
    >
      <header className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        <button className="icon-button" onClick={close} aria-label="Close">
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Workbench() {
  const [playbackDuration, setPlaybackDuration] =
    useState<PlaybackDuration | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [page, setPage] = useState<NotePage>(emptyPage);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<EditorSession | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [provider, setProvider] = useState<Provider>("google");
  const [mode, setMode] = useState<Mode>("verbatim");
  const [panel, setPanel] = useState<
    "local" | "settings" | "help" | "library" | "recording-options" | null
  >(null);
  const [local, setLocal] = useState<LocalRecord[]>([]);
  const [localError, setLocalError] = useState("");
  const [localUnavailable, setLocalUnavailable] = useState(false);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [audio] = useState(() => new TemporaryAudio());
  const audioRecords = useSyncExternalStore(
    audio.subscribe,
    audio.snapshot,
    audio.snapshot,
  );
  const [historical, setHistorical] = useState<Draft[]>([]);
  const [unknownRows, setUnknownRows] = useState<UnknownRecord[]>([]);
  const captureTokens = useRef(new Map<string, string>());
  const [library] = useState(() => new LibraryController());
  const libraryState = useSyncExternalStore(
    library.subscribe,
    library.snapshot,
    library.snapshot,
  );
  const processingToken = useRef<string | null>(null);
  const startingTicket = useRef(0),
    receivingTicket = useRef(0);
  const [starting, setStarting] = useState(false),
    [receiving, setReceiving] = useState(false);
  const localTicket = useRef(0);
  const [areas, setAreas] = useState<Area[]>([]);

  const [recordingPhase, setRecordingPhase] = useState<RecordingPhase>("idle");
  const processing = recordingPhase !== "idle";
  const [draftProtection, setDraftProtection] = useState<
    "checking" | "protected" | "available" | "unavailable"
  >("checking");
  useEffect(() => {
    if (panel !== "local") return;
    let current = true;
    void Promise.resolve()
      .then(async () => {
        if (typeof navigator.storage?.persisted !== "function") {
          if (current) setDraftProtection("unavailable");
          return;
        }
        const protectedAlready = await navigator.storage.persisted();
        if (current)
          setDraftProtection(
            protectedAlready
              ? "protected"
              : typeof navigator.storage.persist === "function"
                ? "available"
                : "unavailable",
          );
      })
      .catch(() => {
        if (current) setDraftProtection("unavailable");
      });
    return () => {
      current = false;
    };
  }, [panel]);
  const [localActionBusy, setLocalActionBusy] = useState(false);
  const localActionRef = useRef(false);
  const [opening, setOpening] = useState(false);
  const sessions = useRef(new Map<string, EditorSession>());
  const subscriptions = useRef(new Map<string, () => void>());
  const [liveDrafts, setLiveDrafts] = useState<Draft[]>([]);
  const publishDrafts = useCallback(() => {
    setLiveDrafts(
      [...sessions.current.values()].map((session) => session.snapshot()),
    );
  }, []);
  const forgetSession = useCallback(
    (session: EditorSession) => {
      const id = session.snapshot().draftId;
      subscriptions.current.get(id)?.();
      subscriptions.current.delete(id);
      sessions.current.delete(id);
      publishDrafts();
    },
    [publishDrafts],
  );
  const workspaceScroll = useRef<HTMLDivElement>(null);
  const listTicket = useRef(0),
    openTicket = useRef(0);
  const processingRef = useRef(false);
  const modelAbort = useRef<AbortController | null>(null);
  const refreshLocal = useCallback(async () => {
    const ticket = ++localTicket.current;
    try {
      const result = await listLocal();
      await library.sync();
      if (ticket !== localTicket.current) return;
      setUnknownRows(result.unknown);
      setLocalUnavailable(false);
      setLocal(result.records);
      setLocalError(
        result.unknown.length
          ? `${result.unknown.length} local entries could not be read. They have not been changed.`
          : "",
      );
    } catch {
      if (ticket !== localTicket.current) return;
      setLocalUnavailable(true);
      setLocalError(
        "Local storage is unavailable. Copy or download unsaved text and recordings before leaving.",
      );
    }
  }, [library]);
  const refresh = useCallback(
    async (cursor?: string) => {
      const generation = library.snapshot().generation;
      if (generation === null) return;
      const ticket = ++listTicket.current;
      setLoading(true);
      try {
        const result = await library.execute(generation, (signal) =>
          request(
            `/notes?generation=${generation}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            notePageSchema,
            { signal },
          ),
        );
        if (ticket !== listTicket.current) return;
        setPage((previous) =>
          cursor
            ? {
                generation: result.generation,
                items: [
                  ...new Map(
                    [...previous.items, ...result.items].map((n) => [n.id, n]),
                  ).values(),
                ],
                nextCursor: result.nextCursor,
              }
            : result,
        );
        setListError("");
      } catch (e) {
        if (ticket === listTicket.current) setListError(message(e));
      } finally {
        if (ticket === listTicket.current) setLoading(false);
      }
    },
    [library],
  );
  const acknowledgeRecording = useCallback(
    (note: Note) => {
      audio.confirm(note);
    },
    [audio],
  );
  const ports = useCallback(
    (): EditorPorts => ({
      persist: putLocal,
      remove: removeLocal,
      retire: retireRecovered,
      confirmed: acknowledgeRecording,
      localChanged: () => {
        void refreshLocal();
      },
      changed: () => {
        void refresh();
        void refreshLocal();
      },
      write: (id, input, revision) =>
        library.execute(input.generation, (signal) =>
          request(`/notes/${id}`, noteSchema, {
            signal,
            method: revision === null ? "PUT" : "PATCH",
            body:
              revision === null
                ? input
                : {
                    generation: input.generation,
                    areaId: input.areaId,
                    title: input.title,
                    body: input.body,
                    expectedRevision: revision,
                  },
          }),
        ),
    }),
    [refresh, refreshLocal, acknowledgeRecording, library],
  );
  const activate = useCallback(
    (session: EditorSession) => {
      openTicket.current++;
      sessions.current.delete(session.snapshot().draftId);
      sessions.current.set(session.snapshot().draftId, session);
      if (!subscriptions.current.has(session.snapshot().draftId))
        subscriptions.current.set(
          session.snapshot().draftId,
          session.subscribe(publishDrafts),
        );
      publishDrafts();
      setActive(session);
      setOpening(false);
      setError("");
      setPanel(null);
      workspaceScroll.current?.scrollTo({ top: 0 });
    },
    [publishDrafts],
  );
  const setup = useCallback(async () => {
    setError("");
    const results = await Promise.allSettled([
      request("/config", configSchema),
      request("/settings", settingsSchema),
      request("/areas", areaPageSchema),
    ]);
    if (results[0].status === "fulfilled") setConfig(results[0].value);
    else setError(message(results[0].reason));
    if (results[2].status === "fulfilled") setAreas(results[2].value.items);
    if (results[1].status === "fulfilled") setSettings(results[1].value);
    else setError(message(results[1].reason));
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void setup(), 0);
    library.start();
    return () => {
      clearTimeout(timer);
      library.dispose();
    };
  }, [setup, library]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (libraryState.phase === "ready") {
        void refresh();
        void refreshLocal();
      } else if (
        libraryState.phase === "pending" ||
        libraryState.phase === "cleanup"
      )
        void refreshLocal();
    }, 0);
    return () => clearTimeout(timer);
  }, [libraryState.phase, libraryState.generation, refresh, refreshLocal]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const pool = sessions.current;
    const listeners = subscriptions.current;
    return () => {
      listeners.forEach((unsubscribe) => unsubscribe());
      listeners.clear();
      pool.forEach((s) => s.dispose());
      modelAbort.current?.abort();
    };
  }, []);
  const createFromRecording = useCallback(
    async (item: Recording, textSecured?: () => void) => {
      if (!item.result || item.readOnly) return;
      let session = [...sessions.current.values()].find(
        (s) => s.snapshot().noteId === item.id && !s.snapshot().readOnly,
      );
      if (!session)
        session = new EditorSession(
          {
            kind: "draft",
            draftId: crypto.randomUUID(),
            editorInstanceId: crypto.randomUUID(),
            noteId: item.id,
            input: item.result,
            baseRevision: null,
            updatedAt: item.createdAt,
            status: "local",
            durable: false,
          },
          ports(),
        );
      activate(session);
      await session.secure();
      if (!session.snapshot().durable || session.snapshot().readOnly) return;
      audio.markText(item.id);
      textSecured?.();
      await session.save();
      await refreshLocal();
    },
    [ports, activate, audio, refreshLocal],
  );
  const transcribe = useCallback(
    async (item: Recording) => {
      if (processingRef.current || item.readOnly) return;
      const token = crypto.randomUUID();
      processingToken.current = token;
      processingRef.current = true;
      setRecording(item);
      setRecordingPhase(item.result ? "saving_transcript" : "preparing_audio");
      setError("");
      workspaceScroll.current?.scrollTo({ top: 0 });
      const controller = new AbortController();
      modelAbort.current = controller;
      let pending: Recording | undefined;
      const saveTranscript = (record: Recording) =>
        createFromRecording(record, () => {
          if (processingToken.current === token)
            setRecordingPhase("saving_note");
        });
      try {
        if (item.result) {
          await saveTranscript(item);
          return;
        }
        const recovery = recordingRecovery(item);
        if (recovery.action === "none")
          throw new ClientError(
            recovery.hint ?? "This recording cannot be retried.",
          );
        pending = audio.begin(item);
        if (!pending) return;
        setRecording(pending);
        const form = new FormData();
        form.set(
          "audio",
          pending.blob,
          `recording.${audioExtension(pending.mime)}`,
        );
        form.set("provider", pending.provider);
        form.set("mode", pending.mode);
        form.set("vocabulary", JSON.stringify(pending.vocabulary));
        form.set("generation", String(pending.generation));
        const result = await library.execute(pending.generation, (signal) => {
          if (processingToken.current === token)
            setRecordingPhase("transcribing");
          return request("/transcribe", transcriptionResultSchema, {
            method: "POST",
            body: form,
            operation: "model",
            signal: AbortSignal.any([signal, controller.signal]),
          });
        });
        if (
          processingToken.current !== token ||
          result.generation !== pending.generation
        )
          return;
        const input = createNoteSchema.parse({
          generation: pending.generation,
          areaId: pending.areaId,
          title: transcriptTitle(result.text),
          originalText: result.text,
          body: result.text,
          provider: result.provider,
          model: result.model,
          mode: result.mode,
          durationMs: pending.durationMs,
        });
        const done: Recording = {
          ...pending,
          state: "transcribed",
          result: input,
          error: undefined,
          errorCode: undefined,
          textDurable: false,
        };
        if (!audio.complete(pending, done)) return;
        setRecording(done);
        setRecordingPhase("saving_transcript");
        await saveTranscript(done);
      } catch (e) {
        if (processingToken.current !== token) return;
        setError(message(e));
        if (pending && !audio.read(pending.id)?.result) {
          const failed: Recording = {
            ...pending,
            state: modelFailureState(e),
            error: message(e),
            errorCode: e instanceof ClientError ? e.code : undefined,
          };
          if (audio.complete(pending, failed)) setRecording(failed);
        }
      } finally {
        if (processingToken.current === token) {
          processingRef.current = false;
          processingToken.current = null;
          setRecordingPhase("idle");
          modelAbort.current = null;
          void refreshLocal();
        }
      }
    },
    [audio, library, createFromRecording, refreshLocal],
  );
  const freezeCapture = async (
    chosenProvider: Provider,
    chosenMode: Mode,
  ): Promise<CaptureContext> => {
    if (!supportsMode(chosenProvider, chosenMode))
      throw new ClientError("This transcription mode is not supported.");
    const cached = library.snapshot().phase === "offline";
    let fence = await library.captureFence(cached);
    let dictionary = settings;
    if (!cached)
      try {
        const fresh = await request("/settings", settingsSchema);
        dictionary = fresh;
        setSettings(fresh);
      } catch {
        throw new ClientError(
          "Vocabulary could not be refreshed. Check the connection before recording.",
        );
      }
    if (!dictionary) throw new ClientError("Load vocabulary before recording.");
    if (
      dictionary.vocabulary.length >
      PROVIDERS[chosenProvider].maxVocabularyTerms
    )
      throw new ClientError(
        `${PROVIDERS[chosenProvider].label} supports ${PROVIDERS[chosenProvider].maxVocabularyTerms} vocabulary terms. Your global list has ${dictionary.vocabulary.length}. Reduce the list or choose another provider.`,
      );
    fence = await library.captureFence(cached);
    // M2 introduces the context boundary; the area picker is added in M3.
    return {
      id: crypto.randomUUID(),
      generation: fence.generation,
      localResetId: fence.localResetId,
      areaId: null,
      areaLabel: "General",
      vocabulary: [...dictionary.vocabulary],
      createdAt: new Date().toISOString(),
      cached,
    };
  };
  const receiveAudio = async (
    item: Recording,
    damaged = false,
    importToken?: string,
  ) => {
    const token = importToken ?? captureTokens.current.get(item.id);
    if (!token) return;
    const ticket = ++receivingTicket.current;
    setReceiving(true);
    try {
      await library.sync();
      await library.audioAccess({
        generation: item.generation,
        localResetId: item.localResetId,
      });
      if (ticket !== receivingTicket.current) {
        audio.release(token);
        return;
      }
      const state = library.snapshot();
      // A cancelled profile reset may be resolved before native final chunks arrive.
      const readOnly = captureIsReadOnly(item, {
        generation: state.generation,
        ready: state.phase === "ready",
        resetPending: !!state.pending,
      });
      const captured = { ...item, readOnly };
      if (!audio.retain(token, captured)) return;
      setCaptureOpen(false);
      setImportOpen(false);
      openTicket.current++;
      setOpening(false);
      setRecording(captured);
      setActive(null);
      if (!damaged && !readOnly && library.snapshot().phase === "ready")
        void transcribe(captured);
      else if (library.snapshot().phase === "offline")
        setError("Audio is kept in this tab. Reconnect before transcribing.");
    } catch (e) {
      audio.release(token);
      if (ticket === receivingTicket.current) setError(message(e));
    } finally {
      captureTokens.current.delete(item.id);
      if (ticket === receivingTicket.current) setReceiving(false);
    }
  };
  const recorder = useRecorder(
    (item, damaged) => void receiveAudio(item, damaged),
    (context) => {
      const token = captureTokens.current.get(context.id);
      if (token) audio.release(token);
      captureTokens.current.delete(context.id);
    },
  );
  const locked =
    starting ||
    receiving ||
    recorder.phase !== "idle" ||
    processing ||
    localActionBusy ||
    !!libraryState.pending ||
    ["loading", "pending", "cleanup"].includes(libraryState.phase);
  const beginRecording = async (
    chosenProvider: Provider = provider,
    chosenMode: Mode = mode,
  ) => {
    if (
      locked ||
      captureTokens.current.size > 0 ||
      !settings ||
      libraryState.legacyPending ||
      !config?.providers.find((p) => p.id === chosenProvider)?.available
    )
      return;
    const ticket = ++startingTicket.current;
    setStarting(true);
    try {
      const context = await freezeCapture(chosenProvider, chosenMode);
      if (ticket !== startingTicket.current) return;
      const token = audio.reserve(PROVIDERS[chosenProvider].maxAudioBytes);
      captureTokens.current.set(context.id, token);
      openTicket.current++;
      setOpening(false);
      setCaptureOpen(true);
      void recorder.start(chosenProvider, chosenMode, context);
    } catch (e) {
      if (ticket === startingTicket.current)
        setError(e instanceof Error ? e.message : "Recording could not start.");
    } finally {
      if (ticket === startingTicket.current) setStarting(false);
    }
  };
  useEffect(() => {
    library.configure({
      invalidate: (kind, fence) => {
        startingTicket.current++;
        receivingTicket.current++;
        setStarting(false);
        setReceiving(false);
        listTicket.current++;
        openTicket.current++;
        localTicket.current++;
        processingToken.current = null;
        processingRef.current = false;
        modelAbort.current?.abort();
        setRecordingPhase("idle");
        setOpening(false);
        setActive(null);
        setPage(emptyPage);
        setCaptureOpen(false);
        setImportOpen(false);
        setRecording(null);
        const snapshots: Draft[] = [];
        for (const session of sessions.current.values())
          if (
            !session.snapshot().readOnly &&
            session.snapshot().input.generation === fence.generation
          )
            snapshots.push(session.fence());
          else session.dispose();
        subscriptions.current.forEach((fn) => fn());
        subscriptions.current.clear();
        sessions.current.clear();
        publishDrafts();
        if (kind === "local") {
          recorder.discard();
          audio.clear();
          captureTokens.current.clear();
          setHistorical([]);
          setLocal([]);
          setUnknownRows([]);
        } else {
          recorder.quarantineAndStop();
          audio.quarantine();
          setHistorical((prev) => [...prev, ...snapshots]);
        }
        setPanel((prev) => (prev === "settings" ? prev : null));
        return kind === "remote" ? snapshots : [];
      },
      pause: () => {
        startingTicket.current++;
        setStarting(false);
        sessions.current.forEach((session) => session.pause());
        recorder.quarantineAndStop();
        audio.quarantine();
        listTicket.current++;
        openTicket.current++;
        localTicket.current++;
        processingToken.current = null;
        processingRef.current = false;
        modelAbort.current?.abort();
        setRecordingPhase("idle");
      },
      resume: () => {
        sessions.current.forEach((session) => session.resume());
        const generation = library.snapshot().generation;
        if (generation) audio.resume(generation);
      },
      preserved: (rows) => {
        const ids = new Set(rows.map((row) => row.archiveToken));
        setHistorical((prev) =>
          prev.map((row) =>
            ids.has(row.archiveToken) ? { ...row, durable: true } : row,
          ),
        );
      },
      busy: () =>
        recorder.phase !== "idle" ||
        processingRef.current ||
        localActionRef.current ||
        [...sessions.current.values()].some((session) => session.saving),
    });
  });
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => {
      if (
        locked ||
        audio.snapshot().some((row) => !row.textDurable) ||
        [...sessions.current.values()].some((session) =>
          warnBeforeLeaving(session.snapshot()),
        ) ||
        historical.some((row) => !row.durable)
      )
        event.preventDefault();
    };
    const hide = () => {
      startingTicket.current++;
      receivingTicket.current++;
      processingToken.current = null;
      processingRef.current = false;
      modelAbort.current?.abort();
      recorder.discard();
      audio.clear();
      captureTokens.current.clear();
      setCaptureOpen(false);
      setImportOpen(false);
      setRecording(null);
      setStarting(false);
      setReceiving(false);
      setRecordingPhase("idle");
      setError("");
    };
    window.addEventListener("beforeunload", before);
    window.addEventListener("pagehide", hide);
    return () => {
      window.removeEventListener("beforeunload", before);
      window.removeEventListener("pagehide", hide);
    };
  }, [locked, audio, historical, recorder]);
  const refreshWorkspace = useCallback(() => {
    void refresh();
    void refreshLocal();
    if (active)
      void library
        .execute(active.snapshot().input.generation, (signal) =>
          request(
            `/notes/${active.snapshot().noteId}?generation=${active.snapshot().input.generation}`,
            noteSchema,
            { signal },
          ),
        )
        .then((n) => active.revalidate(n))
        .catch((e) => {
          if (e instanceof ClientError && [404, 410].includes(e.status ?? 0))
            active.removed();
          else setError(message(e));
        });
  }, [active, refresh, refreshLocal, library]);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      refreshWorkspace();
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [refreshWorkspace]);
  async function openNote(id: string) {
    if (locked) return;
    const existing = [...sessions.current.values()]
      .reverse()
      .find(
        (s) => s.snapshot().noteId === id && s.snapshot().status !== "deleted",
      );
    if (existing) activate(existing);
    const ticket = ++openTicket.current;
    setOpening(!existing);
    setError("");
    try {
      const generation = library.snapshot().generation;
      if (generation === null) return;
      const note = await library.execute(generation, (signal) =>
        request(`/notes/${id}?generation=${generation}`, noteSchema, {
          signal,
        }),
      );
      acknowledgeRecording(note);
      if (ticket !== openTicket.current) return;
      if (existing) existing.revalidate(note);
      else activate(EditorSession.fromNote(note, ports()));
    } catch (e) {
      if (ticket === openTicket.current) {
        if (
          existing &&
          e instanceof ClientError &&
          [404, 410].includes(e.status ?? 0)
        )
          existing.removed();
        setError(message(e));
      }
    } finally {
      if (ticket === openTicket.current) setOpening(false);
    }
  }
  async function restore(draft: Draft) {
    const ticket = ++openTicket.current;
    await library.sync();
    if (ticket !== openTicket.current) return;
    if (
      draft.readOnly ||
      draft.input.generation !== library.snapshot().generation
    ) {
      activate(
        new EditorSession(
          { ...draft, readOnly: true, status: "archived" },
          ports(),
        ),
      );
      return;
    }
    if (locked) return;
    await library.sync();
    if (draft.input.generation !== library.snapshot().generation) return;
    const live = sessions.current.get(draft.draftId);
    if (live && !live.snapshot().readOnly) {
      activate(live);
      return;
    }
    if (live) {
      live.dispose();
      forgetSession(live);
    }
    const session = EditorSession.restore(draft, ports());
    activate(session);
    const restoreTicket = openTicket.current;
    try {
      await session.secure();
      if (restoreTicket !== openTicket.current) return;
      if (session.snapshot().status === "saved") await session.retryLocal();
      else if (draft.status !== "conflict" && draft.status !== "deleted")
        await session.save();
      if (restoreTicket === openTicket.current)
        setToast("Draft restored as a separate version.");
    } catch {
      // The active draft carries its local warning and recovery actions.
    }
  }
  async function removeRecord(item: VisibleRecord) {
    if (localActionRef.current) return;
    if (
      !window.confirm(
        item.kind === "recording"
          ? "Remove this audio copy? Download it first if you want to keep it."
          : "Remove this local text copy? The shared note is kept.",
      )
    )
      return;
    localActionRef.current = true;
    setLocalActionBusy(true);
    try {
      if (item.kind === "recording") {
        await library.audioAccess({
          generation: item.generation,
          localResetId: item.localResetId,
        });
        if ("legacy" in item && item.legacy)
          await removeLegacy(item as LegacyRecording);
        else if (!audio.remove(item)) {
          await refreshLocal();
          throw new ClientError(
            "This recording changed before deletion. Review its current copy and try again.",
          );
        }
        setRecording((current) => (current?.id === item.id ? null : current));
      } else {
        const session = sessions.current.get(item.draftId);
        if (session && !item.readOnly) {
          await session.discard();
          forgetSession(session);
          setActive((current) => (current === session ? null : current));
        } else if (item.durable) {
          if (item.input.generation !== (library.snapshot().generation ?? 0))
            await removeArchived(item);
          else await removeLocal(item.draftId, item.input.generation);
        }
        setHistorical((prev) =>
          prev.filter((row) => row.draftId !== item.draftId),
        );
      }
      await library.sync();
      void refreshLocal();
    } catch (e) {
      setLocalError(message(e));
    } finally {
      localActionRef.current = false;
      setLocalActionBusy(false);
    }
  }
  function exportText(input: CreateNote, createdAt: string) {
    void library
      .localAccess()
      .then(() => exportNote(input, createdAt))
      .catch((e) => setError(message(e)));
  }
  async function audioDownload(item: Recording) {
    try {
      await library.audioAccess({
        generation: item.generation,
        localResetId: item.localResetId,
      });
      download(
        item.blob,
        `recording-${item.createdAt.replace(/[:.]/g, "-")}.${audioExtension(item.mime)}`,
      );
    } catch (e) {
      setError(message(e));
    }
  }
  const records = mergeLocalRecords(local, [
    ...liveDrafts.filter((row) => !row.readOnly || !!row.archiveToken),
    ...historical,
    ...audioRecords,
  ]);
  const currentRecording = recording
    ? records.find(
        (row): row is Recording =>
          row.kind === "recording" && row.id === recording.id,
      )
    : undefined;
  const recordingTextDurable = !!currentRecording?.textDurable;
  const processingCopy = recordingProgress(
    recordingPhase,
    recordingTextDurable,
  );
  const unsaved = records.filter(needsLocalAttention);
  const attentionCount = new Set(
    unsaved.map((row) => (row.kind === "draft" ? row.noteId : row.id)),
  ).size;
  const visibleRecording = active
    ? records.find(
        (row): row is Recording =>
          row.kind === "recording" && row.id === active.snapshot().noteId,
      )
    : currentRecording;
  const visibleRecordingTextDurable = !!visibleRecording?.textDurable;
  const recoveryAction = visibleRecording
    ? recordingRecovery(visibleRecording)
    : null;
  const workspaceError =
    error === visibleRecording?.error || error === recoveryAction?.hint
      ? ""
      : error;
  const available = config?.providers.find((p) => p.id === provider)?.available;
  const items = page.items.filter((n) =>
    `${n.title} ${n.preview}`
      .toLocaleLowerCase("en")
      .includes(query.toLocaleLowerCase("en")),
  );
  const providerControls = (
    <>
      <label className="provider-select">
        <span className="sr-only">Transcription provider</span>
        <select
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value as Provider);
            setMode("verbatim");
          }}
        >
          <option
            value="google"
            disabled={
              !config?.providers.find((p) => p.id === "google")?.available
            }
          >
            Google
            {config &&
            !config.providers.find((p) => p.id === "google")?.available
              ? "  · unavailable"
              : ""}
          </option>
          <option
            value="mistral"
            disabled={
              !config?.providers.find((p) => p.id === "mistral")?.available
            }
          >
            Mistral
            {config &&
            !config.providers.find((p) => p.id === "mistral")?.available
              ? "  · unavailable"
              : ""}
          </option>
        </select>
        <ChevronDown size={13} />
      </label>
      <span className="dock-divider" />
      <label className="provider-select mode-select">
        <span className="sr-only">Transcription mode</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="verbatim">Verbatim</option>
          {provider === "google" && <option value="smart">Polished</option>}
        </select>
        <ChevronDown size={13} />
      </label>
    </>
  );
  const recoveryGroups = [
    ...new Set(records.map((x) => (x.kind === "recording" ? x.id : x.noteId))),
  ]
    .map((id) => {
      const entries = records.filter(
        (x) =>
          (x.kind === "recording" ? x.id : x.noteId) === id &&
          (x.kind === "recording" || needsLocalAttention(x)),
      );
      const draft = entries.find((x): x is Draft => x.kind === "draft");
      const audio = entries.find((x): x is Recording => x.kind === "recording");
      const title =
        draft?.input.title ||
        audio?.result?.title ||
        page.items.find((x) => x.id === id)?.title ||
        "Untitled recording";
      const pending = entries.some(
        (x) => x.kind === "draft" || x.state !== "cloud_confirmed",
      );
      entries.sort(
        (a, b) =>
          Number(b.kind === "recording") - Number(a.kind === "recording"),
      );
      const older = entries.some(
        (x) =>
          (x.kind === "draft" ? x.input.generation : x.generation) <
          (libraryState.generation ?? 0),
      );
      const updatedAt =
        entries
          .map((x) => (x.kind === "draft" ? x.updatedAt : x.createdAt))
          .sort()
          .at(-1) ?? "";
      return {
        id,
        entries,
        title,
        pending,
        older,
        hasAudio: !!audio,
        updatedAt,
      };
    })
    .filter((g) => g.entries.length)
    .sort(
      (a, b) =>
        Number(b.hasAudio) - Number(a.hasAudio) ||
        Number(b.pending) - Number(a.pending) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  const libraryNavigation = (
    <>
      <div className="library-top">
        <a
          className="brand"
          href="#main"
          aria-label="Voice Workbench, go to workspace"
        >
          <span className="brand-mark">
            <AudioLines size={23} strokeWidth={1.8} />
          </span>
          <span>
            voice<span className="brand-light">workbench</span>
          </span>
        </a>
        <span className="edition">YOUR PERSONAL SPACE</span>
      </div>
      <button
        className="new-note"
        disabled={
          locked ||
          !settings ||
          !config?.providers.find((item) => item.id === provider)?.available ||
          libraryState.legacyPending
        }
        onClick={() => {
          setPanel(null);
          beginRecording();
        }}
      >
        <Plus size={19} />{" "}
        {libraryState.phase === "offline"
          ? "Record with cached words"
          : "New recording"}{" "}
        <span>＋</span>
      </button>
      <button
        className="import-entry"
        disabled={locked || libraryState.legacyPending}
        onClick={() => {
          setPanel(null);
          setImportOpen(true);
        }}
      >
        <Upload size={17} /> Import audio
      </button>
      <div className="library-title">
        <h2>Your notes</h2>
        <button
          className={`icon-button ${loading ? "spinning" : ""}`}
          onClick={refreshWorkspace}
          disabled={loading}
          aria-label="Refresh library"
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <label className="search">
        <Search size={16} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter titles & previews"
          aria-label="Filter loaded titles and previews"
        />
        {query && (
          <button
            className="icon-button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
          >
            <X size={14} />
          </button>
        )}
      </label>
      <div className="note-list">
        {listError && (
          <div className="small-error">
            {listError}
            <button className="text-button" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        )}
        {loading && !page.items.length ? (
          <p className="library-empty">
            <LoaderCircle className="spin" size={18} /> Loading your library
          </p>
        ) : !items.length ? (
          <div className="library-empty">
            <FileText size={25} strokeWidth={1.3} />
            <p>
              {query ? "No matching notes yet." : "A home for your thoughts."}
            </p>
            <small>
              {query
                ? "Only loaded titles and previews are searched."
                : "Record a thought or import your audio."}
            </small>
          </div>
        ) : (
          <>
            <span className="list-label">RECENTLY EDITED</span>
            {items.map((note) => (
              <button
                key={note.id}
                className={`note-card ${active?.snapshot().noteId === note.id ? "selected" : ""}`}
                onClick={() => void openNote(note.id)}
                disabled={locked}
              >
                <span className="note-card-heading">
                  {note.title || "Untitled"}
                </span>
                <span className="note-preview">
                  {note.preview || "Empty version"}
                </span>
                <span className="note-meta">
                  <span>{date(note.updatedAt)}</span>
                  <span>
                    {note.provider === "google" ? "Google" : "Mistral"}
                  </span>
                </span>
              </button>
            ))}
          </>
        )}
        {page.nextCursor && (
          <button
            className="text-button load-more"
            disabled={loading}
            onClick={() => void refresh(page.nextCursor!)}
          >
            Load more notes <ChevronDown size={14} />
          </button>
        )}
      </div>
      <div className="library-bottom">
        <button
          className="sidebar-link"
          onClick={() => {
            void refreshLocal();
            setPanel("local");
          }}
        >
          <FolderOpen size={17} />
          <span>Local audio & drafts</span>
          {attentionCount > 0 && (
            <span className="count">{attentionCount}</span>
          )}
        </button>
        <button className="sidebar-link" onClick={() => setPanel("settings")}>
          <Settings2 size={17} />
          <span>Vocabulary & models</span>
        </button>
        <div className="connection">
          <span className={`status-dot ${listError ? "amber" : ""}`} />
          <span>
            {listError
              ? "Cloud unavailable"
              : loading
                ? "Checking connection"
                : "Notes sync across computers"}
          </span>
          <button
            className="icon-button"
            aria-label="About your data and storage"
            onClick={() => setPanel("help")}
          >
            <CircleHelp size={15} />
          </button>
        </div>
      </div>
    </>
  );
  return (
    <div
      className={`app-shell ${processing && recording ? "processing-active" : ""} ${active ? "has-note" : ""} ${active && (active.snapshot().localIssue || ["conflict", "deleted", "error"].includes(active.snapshot().status)) ? "has-recovery" : ""} ${active?.snapshot().status === "conflict" ? "has-conflict" : ""}`}
    >
      <a className="skip-link" href="#main">
        Skip to workspace
      </a>
      <aside className="sidebar">{libraryNavigation}</aside>
      <main id="main" className="workspace">
        <header className="workspace-header">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open library"
              onClick={() => setPanel("library")}
            >
              <Menu size={21} />
              <span>Library</span>
            </button>
            <span className="breadcrumb-icon">
              <AudioLines size={18} />
            </span>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <span className="breadcrumb-current">
              {processing
                ? "Processing"
                : active
                  ? "Note"
                  : visibleRecording && !locked
                    ? "Recording"
                    : "New recording"}
            </span>
          </div>
          <button className="local-badge" onClick={() => setPanel("help")}>
            <span className="status-dot" /> Your private space{" "}
            <ShieldCheck size={15} />
          </button>
        </header>
        <div className="workspace-scroll" ref={workspaceScroll}>
          {libraryState.pending && (
            <section className="notice" role="alert">
              <div>
                <strong>
                  {libraryState.pending.phase === "acknowledged"
                    ? "Cloud cleared; device cleanup pending"
                    : "Library cleanup needs attention"}
                </strong>
                <p>
                  {libraryState.error ||
                    "Local content is protected while the previous operation is resolved."}
                </p>
              </div>
              <div className="notice-actions">
                <button
                  className="text-button"
                  onClick={() =>
                    void library.retryReset().catch((e) => setError(message(e)))
                  }
                >
                  Retry cleanup
                </button>
                {libraryState.pending.phase === "prepared" && (
                  <button
                    className="text-button"
                    onClick={() =>
                      void library
                        .cancelReset()
                        .catch((e) => setError(message(e)))
                    }
                  >
                    Resolve or stop
                  </button>
                )}
                {libraryState.repair && (
                  <button
                    className="text-button"
                    onClick={() => {
                      if (
                        window.confirm(
                          "Release this conflicting operation without deleting local copies?",
                        )
                      )
                        void library
                          .releaseConflictingClaim()
                          .catch((e) => setError(message(e)));
                    }}
                  >
                    Keep local copies and resolve
                  </button>
                )}
                <button
                  className="text-button"
                  onClick={() => {
                    void refreshLocal();
                    setPanel("local");
                  }}
                >
                  Download local copies
                </button>
              </div>
            </section>
          )}
          {!libraryState.pending && libraryState.error && (
            <p className="notice" role="status">
              {libraryState.error}
              <button
                className="text-button"
                onClick={() => void library.sync()}
              >
                Check library
              </button>
            </p>
          )}
          {libraryState.legacyPending && (
            <div className="notice" role="status">
              <span>
                Earlier audio is still saved in this browser. Download or remove
                it before starting a new recording. Texts and vocabulary remain
                available.
              </span>
              <button
                className="text-button"
                onClick={() => {
                  void refreshLocal();
                  setPanel("local");
                }}
              >
                Review earlier audio
              </button>
            </div>
          )}
          {(workspaceError || recorder.error) && (
            <div className="notice error-notice" role="alert">
              <span>{workspaceError || recorder.error}</span>
              <div className="notice-actions">
                {!config || !settings ? (
                  <button className="text-button" onClick={() => void setup()}>
                    Check connection
                  </button>
                ) : null}
                <button
                  className="icon-button"
                  aria-label="Dismiss message"
                  onClick={() => {
                    setError("");
                    recorder.clearError();
                  }}
                >
                  <X size={16} />
                </button>
              </div>
            </div>
          )}
          {localError && (
            <div className="notice" role="status">
              {localError}
            </div>
          )}
          {!active && !visibleRecording && unsaved.length > 0 && !locked && (
            <div className="notice recovery-notice" role="status">
              <span>Local text and audio copies are available.</span>
              <button
                className="text-button"
                onClick={() => {
                  void refreshLocal();
                  setPanel("local");
                }}
              >
                Open recovery space <ArrowRight size={14} />
              </button>
            </div>
          )}
          {opening && (
            <div className="opening" role="status">
              <LoaderCircle className="spin" size={16} /> Opening note
            </div>
          )}
          {processing && recording && (
            <ProcessingStatus
              key={recording.id}
              recording={recording}
              phase={recordingPhase}
              textDurable={recordingTextDurable}
              cancel={() => modelAbort.current?.abort()}
              downloadAudio={() => audioDownload(recording)}
              downloadTranscript={() => {
                if (recording.result)
                  exportText(recording.result, recording.createdAt);
              }}
            />
          )}
          {active ? (
            <Editor
              key={`${active.snapshot().draftId}:${libraryState.epoch}`}
              session={active}
              config={config}
              locked={locked || libraryState.phase !== "ready"}
              library={library}
              areaLabel={
                active.snapshot().input.areaId
                  ? (areas.find(
                      (area) => area.id === active.snapshot().input.areaId,
                    )?.name ?? "Earlier area")
                  : "General"
              }
              notify={setToast}
              onDelete={() => {
                forgetSession(active);
                const audioCopy = audio.read(active.snapshot().noteId);
                if (audioCopy) audio.remove(audioCopy);
                if (recording?.id === active.snapshot().noteId)
                  setRecording(null);
                active.dispose();
                setActive(null);
                void refresh();
                void refreshLocal();
              }}
              onDuplicate={(input) => {
                const session = new EditorSession(
                  {
                    kind: "draft",
                    draftId: crypto.randomUUID(),
                    editorInstanceId: crypto.randomUUID(),
                    noteId: crypto.randomUUID(),
                    input,
                    baseRevision: null,
                    updatedAt: new Date().toISOString(),
                    status: "local",
                    durable: false,
                  },
                  ports(),
                );
                activate(session);
                void session.save();
              }}
            />
          ) : visibleRecording ? (
            <section className="recording-heading">
              <div className="section-label">YOUR RECORDING</div>
              <h1>
                {processing ? processingCopy.title : "Recover your recording."}
              </h1>
              <p>
                {processing
                  ? processingCopy.detail
                  : "Listen, recover your transcript, or download the audio."}
              </p>
            </section>
          ) : (
            <section className="blank-workspace">
              <div className="section-label">
                <span className="tiny-line" /> NEW RECORDING
              </div>
              <div className="empty-composition">
                <div className={`voice-orbit ${locked ? "is-active" : ""}`}>
                  <Wave animated={locked} />
                </div>
                <h1>
                  {processing ? (
                    <>
                      Your words.
                      <br />
                      <span>Taking shape.</span>
                    </>
                  ) : recorder.phase === "recording" ? (
                    <>
                      A new note.
                      <br />
                      <span>Speak freely.</span>
                    </>
                  ) : (
                    <>
                      Record a new note.
                      <br />
                      <span>Make it your own.</span>
                    </>
                  )}
                </h1>
                <p>
                  {processing
                    ? processingCopy.detail
                    : recorder.phase === "recording"
                      ? "Take your time. You can shape your words when you’re done."
                      : "Record a thought. Edit the transcript. Copy it wherever you work."}
                </p>
                <div className="flow-hint">
                  <span>
                    <span>01</span> Speak
                  </span>
                  <span className="flow-line" />
                  <span>
                    <span>02</span> Edit
                  </span>
                  <span className="flow-line" />
                  <span>
                    <span>03</span> Copy
                  </span>
                </div>
              </div>
              <button
                className="empty-import"
                disabled={locked || libraryState.legacyPending}
                onClick={() => setImportOpen(true)}
              >
                <Upload size={17} /> Or import an audio file{" "}
                <ArrowRight size={15} />
              </button>
              <div className="empty-footer">
                <span>
                  <Headphones size={16} /> Your voice. Your pace.
                </span>
                <button
                  className="text-button"
                  onClick={() => setPanel("help")}
                >
                  What gets saved? <ChevronRight size={14} />
                </button>
              </div>
            </section>
          )}
          {visibleRecording && (
            <section className="recording-receipt" aria-label="Local recording">
              <div className="receipt-heading">
                <AudioLines size={19} />
                <div>
                  <strong>
                    {visibleRecording.result?.title || "Recorded thought"}
                  </strong>
                  <small>
                    {duration(
                      playbackDuration?.sourceKey ===
                        playbackSourceKey(visibleRecording)
                        ? playbackDuration.durationMs
                        : visibleRecording.durationMs,
                    )}{" "}
                    · Recorded with {recordingProvider(visibleRecording)} ·{" "}
                    {visibleRecording.cached ? "Cached vocabulary · " : ""}
                    {"legacy" in visibleRecording
                      ? "Earlier saved audio, remove after downloading"
                      : "Audio is temporary in this tab. Closing or reloading removes it."}
                  </small>
                </div>
              </div>
              {visibleRecording.error &&
                visibleRecording.error !== recoveryAction?.hint && (
                  <p className="recording-error" role="status">
                    {visibleRecording.error}
                  </p>
                )}
              {recoveryAction?.hint && (
                <p
                  role="status"
                  className={
                    visibleRecording.error ? "field-hint" : "recording-error"
                  }
                >
                  {recoveryAction.hint}
                </p>
              )}
              {["transcribing", "unknown"].includes(visibleRecording.state) && (
                <p className="field-hint">
                  The previous request’s outcome is unknown. A new attempt may
                  incur another charge.
                </p>
              )}
              <details className="audio-details">
                <summary>Listen to recording</summary>
                <AudioPlayer
                  key={playbackSourceKey(visibleRecording)}
                  blob={visibleRecording.blob}
                  sourceKey={playbackSourceKey(visibleRecording)}
                  onDuration={setPlaybackDuration}
                  authorize={() =>
                    library.audioAccess({
                      generation: visibleRecording.generation,
                      localResetId: visibleRecording.localResetId,
                    })
                  }
                />
              </details>
              {visibleRecording.result && !active && (
                <div className="rescued-text">
                  <h3>Your transcript</h3>
                  <pre>{visibleRecording.result.body}</pre>
                  <button
                    className={
                      !visibleRecordingTextDurable ? "primary" : "secondary"
                    }
                    onClick={() => {
                      void library
                        .localAccess()
                        .then(() =>
                          navigator.clipboard.writeText(
                            visibleRecording.result!.body,
                          ),
                        )
                        .then(() => setToast("Transcript copied."))
                        .catch(() =>
                          setError(
                            "Copy was blocked. Download the transcript instead.",
                          ),
                        );
                    }}
                  >
                    <Copy size={16} /> Copy transcript
                  </button>
                  <button
                    className="text-button"
                    onClick={() =>
                      exportText(
                        visibleRecording.result!,
                        visibleRecording.createdAt,
                      )
                    }
                  >
                    Download transcript
                  </button>
                </div>
              )}
              <div className="receipt-actions">
                {recoveryAction && recoveryAction.action !== "none" && (
                  <button
                    className="secondary"
                    disabled={locked || (!visibleRecording.result && !settings)}
                    onClick={() => {
                      if (
                        recoveryAction.action === "setup" &&
                        !window.confirm(recoveryAction.setupPrompt!)
                      )
                        return;
                      if (
                        ["transcribing", "unknown"].includes(
                          visibleRecording.state,
                        ) &&
                        !window.confirm(
                          "Transcribe again? The previous request may already have incurred a charge.",
                        )
                      )
                        return;
                      void transcribe(visibleRecording);
                    }}
                  >
                    {recoveryAction.label} ·{" "}
                    {recordingProvider(visibleRecording)}
                  </button>
                )}
                <button
                  className={
                    !visibleRecordingTextDurable && !visibleRecording.result
                      ? "primary"
                      : "text-button"
                  }
                  onClick={() => audioDownload(visibleRecording)}
                >
                  <ArrowDownToLine size={16} /> Download audio
                </button>
                <button
                  className="icon-button"
                  aria-label="Delete local recording"
                  disabled={locked}
                  onClick={() => void removeRecord(visibleRecording)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </section>
          )}
        </div>
        <footer
          style={captureOpen ? { visibility: "hidden" } : undefined}
          className={`recording-dock ${locked ? "dock-busy" : ""} ${recorder.phase === "recording" ? "dock-recording" : ""}`}
        >
          <div className="dock-detail">
            <span className="dock-mic">
              <Mic size={21} />
            </span>
            <div>
              <strong>
                {processing
                  ? processingCopy.title
                  : recorder.phase === "permission"
                    ? "Allow microphone access"
                    : recorder.phase === "stopping"
                      ? "Saving recording"
                      : recorder.phase === "recording"
                        ? "Recording new note"
                        : recorder.phase === "paused"
                          ? "Recording paused"
                          : "Ready when you are"}
              </strong>
              <small>
                {processing
                  ? processingCopy.detail
                  : recorder.phase === "recording"
                    ? `${duration(recorder.elapsed)} / ${duration(PROVIDERS[recorder.provider].maxRecordingSeconds * 1000)}`
                    : "One recording. One new note."}
              </small>
            </div>
          </div>
          <div className="dock-center">
            {!locked && (
              <span className="next-recording-label">
                General · Next recording
              </span>
            )}
            {locked ? (
              <Wave animated />
            ) : (
              <>
                {active ? (
                  <button
                    className="dock-options"
                    onClick={() => setPanel("recording-options")}
                  >
                    {provider === "google" ? "Google" : "Mistral"} ·{" "}
                    {mode === "verbatim" ? "Verbatim" : "Polished"}
                    <ChevronDown size={14} />
                  </button>
                ) : (
                  providerControls
                )}
              </>
            )}
          </div>
          {recorder.phase === "recording" ? (
            <button className="stop-button" onClick={recorder.stop}>
              <Square size={14} fill="currentColor" /> Finish recording
            </button>
          ) : recorder.phase === "permission" ? (
            <button
              className="dock-secondary"
              onClick={recorder.cancelPermission}
            >
              Cancel
            </button>
          ) : processing && processingCopy.canCancel ? (
            <button
              className="dock-secondary"
              onClick={() => modelAbort.current?.abort()}
            >
              <X size={17} /> Cancel
            </button>
          ) : processing ? (
            <span className="dock-secondary" role="status">
              <LoaderCircle className="spin" size={17} /> Saving
            </span>
          ) : (
            <button
              className="primary record-button"
              disabled={
                locked || !available || !settings || libraryState.legacyPending
              }
              onClick={() => void beginRecording()}
            >
              <Mic size={18} />
              <span>
                {libraryState.phase === "offline"
                  ? "Record with cached words"
                  : active
                    ? "New recording"
                    : "Record"}
              </span>
            </button>
          )}
        </footer>
        {!settings && !locked && (
          <div className="recording-setup-notice" role="status">
            <span>
              Recording is unavailable until vocabulary settings load.
            </span>
            <button className="text-button" onClick={() => void setup()}>
              Check connection
            </button>
          </div>
        )}
        <div className="workspace-footnote">
          <span>
            {available
              ? "Audio is sent to your selected provider"
              : "Set up a provider or select another in the recording bar"}
          </span>
          <span>
            VOICE WORKBENCH <span className="footnote-version">/ 01</span>
          </span>
        </div>
      </main>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
      {captureOpen && (
        <RecordingDialog
          state={recorder}
          receiving={receiving}
          stop={recorder.stop}
          requestDiscard={recorder.requestDiscard}
          pause={recorder.pause}
          resume={recorder.resume}
          continueCapture={recorder.continueCapture}
          dismissDiscard={recorder.dismissDiscard}
          discard={() => {
            recorder.discard();
            setCaptureOpen(false);
          }}
          retry={() => void beginRecording(recorder.provider, recorder.mode)}
        />
      )}
      {importOpen && (
        <ImportDialog
          config={config}
          settingsReady={!!settings}
          cachedWords={libraryState.phase === "offline"}
          retryConnection={setup}
          provider={provider}
          mode={mode}
          close={() => setImportOpen(false)}
          reserve={(bytes) => audio.reserve(bytes)}
          release={(token) => audio.release(token)}
          freeze={freezeCapture}
          transcribe={(item, token) => {
            void receiveAudio(item, false, token);
          }}
        />
      )}
      {panel === "library" && (
        <Modal title="Your library" close={() => setPanel(null)}>
          <div className="mobile-library">{libraryNavigation}</div>
        </Modal>
      )}
      {panel === "help" && (
        <Modal title="Your space. No guesswork." close={() => setPanel(null)}>
          <div className="help-grid">
            <div>
              <Cloud size={24} />
              <h3>Your words travel with you.</h3>
              <p>
                Notes and vocabulary live in your own Turso database. Use the
                same configuration to access them on another computer.
              </p>
            </div>
            <div>
              <Headphones size={24} />
              <h3>Audio stays in this tab.</h3>
              <p>
                Audio is sent to your selected transcription provider. New audio
                is kept only in tab memory, and closing or reloading removes it.
                Text drafts are saved separately in this browser. Download audio
                before leaving if you want a copy.
              </p>
            </div>
            <div>
              <Sparkles size={24} />
              <h3>You have the final word.</h3>
              <p>
                Transcription sends audio to Google or Mistral. Refining sends
                text to Fireworks and produces a suggestion. Always check names,
                conditions, and negations.
              </p>
            </div>
          </div>
          <p className="modal-footnote">
            The app runs locally and uses online services. A recording in
            progress may not survive a browser crash.
          </p>
        </Modal>
      )}
      {panel === "recording-options" && (
        <Modal title="Next recording" close={() => setPanel(null)}>
          <p className="modal-intro">
            Each recording creates a new note. Choose how the next one is
            transcribed.
          </p>
          <div className="recording-options-panel">{providerControls}</div>
          <p className="field-hint">
            Verbatim keeps the wording. Polished asks Google to smooth it during
            transcription. Separate refinement remains optional.
          </p>
          <div className="modal-actions">
            <button className="primary" onClick={() => setPanel(null)}>
              Done
            </button>
          </div>
        </Modal>
      )}
      {panel === "settings" && (
        <SettingsPanel
          key={settings ? "ready" : "waiting"}
          config={config}
          initial={settings}
          close={() => setPanel(null)}
          onSaved={(value, notice) => {
            setSettings(value);
            setToast(notice);
          }}
        />
      )}
      {panel === "local" && (
        <Modal
          title="Local audio & drafts"
          close={() => setPanel(null)}
          wide
          className="recovery-modal"
        >
          <div className="recovery-summary">
            <p>
              <AudioLines size={17} />
              <span>
                <strong>Audio stays in this tab</strong>
                <small>Download before closing or reloading.</small>
              </span>
            </p>
            <p>
              <FileText size={17} />
              <span>
                <strong>Text drafts stay in this browser</strong>
                <small>Cloud-saved notes sync across computers.</small>
              </span>
            </p>
          </div>
          <div className="recovery-inventory">
            <strong>
              {recoveryGroups.reduce((n, g) => n + g.entries.length, 0) +
                unknownRows.length}{" "}
              {recoveryGroups.reduce((n, g) => n + g.entries.length, 0) +
                unknownRows.length ===
              1
                ? "local item"
                : "local items"}
            </strong>
            <span>
              {audioRecords.length
                ? `${audioRecords.length} temporary audio ${audioRecords.length === 1 ? "file" : "files"} · ${audio.bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(audio.bytes / 1024))} KiB` : `${(audio.bytes / 1024 / 1024).toFixed(1)} MiB`}`
                : "No temporary audio"}
            </span>
          </div>
          <div
            role="region"
            className="recovery-scroll"
            tabIndex={0}
            aria-label="Local copies"
          >
            {(localError ||
              records.some((item) =>
                item.kind === "recording"
                  ? !("legacy" in item) && !item.textDurable
                  : !item.durable && item.status !== "saved",
              )) && (
              <p className="notice">
                {localError ||
                  "Some changes are only in this tab. Copy or download them before reloading or closing it."}
              </p>
            )}
            {!records.some(
              (item) => item.kind === "recording" || needsLocalAttention(item),
            ) && (
              <div className="panel-empty">
                <FolderOpen size={32} />
                <h3>Nothing left behind.</h3>
                <p>Completed recordings and pending drafts will appear here.</p>
              </div>
            )}
            {unknownRows.map((row, index) => (
              <div className="notice" key={index}>
                <span>Unreadable earlier entry. It has not been changed.</span>
                <button
                  className="text-button"
                  disabled={!!libraryState.pending}
                  onClick={() => {
                    if (window.confirm("Remove this unreadable local entry?"))
                      void removeUnknown(row)
                        .then(() => {
                          void refreshLocal();
                          void library.sync();
                        })
                        .catch((e) => setLocalError(message(e)));
                  }}
                >
                  Remove entry
                </button>
              </div>
            ))}
            <div className="local-list">
              {recoveryGroups.map((group) => (
                <section className="recovery-group" key={group.id}>
                  <div className="recovery-heading">
                    <h3>{group.title}</h3>
                    <span
                      className={
                        group.older
                          ? "historical"
                          : group.pending
                            ? "attention"
                            : "confirmed"
                      }
                    >
                      {group.older
                        ? "Earlier library"
                        : group.pending
                          ? "Needs attention"
                          : "Note saved"}
                    </span>
                  </div>
                  {group.older && (
                    <p className="recovery-context">
                      Kept after the library was cleared. Copy or download;
                      these versions will not sync.
                    </p>
                  )}
                  {group.entries.map((item) => {
                    const copies = group.entries.filter(
                      (entry): entry is Draft => entry.kind === "draft",
                    );
                    const copyNumber =
                      item.kind === "draft" ? copies.indexOf(item) + 1 : 0;
                    const sameText =
                      item.kind === "draft"
                        ? copies.findIndex(
                            (entry) => entry.input.body === item.input.body,
                          ) + 1
                        : 0;
                    return (
                      <div
                        className="local-row"
                        key={item.kind === "recording" ? item.id : item.draftId}
                      >
                        <span className="local-icon">
                          {item.kind === "recording" ? (
                            <AudioLines size={20} />
                          ) : (
                            <FileText size={20} />
                          )}
                        </span>
                        <div>
                          <strong>
                            {item.kind === "recording"
                              ? `Audio · ${duration(item.durationMs)}`
                              : `Text copy ${copyNumber} · ${item.input.body.trim() ? item.input.body.trim().split(/\s+/u).length : 0} words`}
                          </strong>
                          {item.kind === "draft" && (
                            <p className="recovery-preview">
                              {sameText < copyNumber
                                ? `Same working text as copy ${sameText}.`
                                : item.input.body.slice(0, 120) ||
                                  "Empty working text"}
                              {sameText === copyNumber &&
                              item.input.body.length > 120
                                ? "…"
                                : ""}
                            </p>
                          )}
                          <small>
                            {localDate(
                              item.kind === "recording"
                                ? item.createdAt
                                : item.updatedAt,
                            )}{" "}
                            ·{" "}
                            {item.kind === "recording"
                              ? `${recordingProvider(item)} · ${"legacy" in item ? "Earlier saved audio · " : "Temporary in this tab · "}${
                                  item.readOnly
                                    ? "Read-only"
                                    : item.state === "cloud_confirmed"
                                      ? "Note saved to cloud"
                                      : item.result
                                        ? "Transcript ready"
                                        : ["transcribing", "unknown"].includes(
                                              item.state,
                                            )
                                          ? "Processing outcome unknown"
                                          : "Audio available"
                                }`
                              : `Draft · ${item.status === "local" && !item.durable ? "Not saved" : statuses[item.status]}${!item.durable && item.status !== "saved" ? " · In memory only" : item.localIssue ? " · Local warning" : ""}`}
                          </small>
                        </div>
                        <div className="local-actions">
                          {item.kind === "recording" &&
                            "legacy" in item &&
                            item.result && (
                              <button
                                className="text-button"
                                disabled={!!libraryState.pending}
                                onClick={() =>
                                  void extractLegacy(item as LegacyRecording)
                                    .then(() => refreshLocal())
                                    .catch((e) => setLocalError(message(e)))
                                }
                              >
                                Keep transcript
                              </button>
                            )}

                          <button
                            className="text-button"
                            disabled={locked}
                            onClick={() => {
                              if (item.kind === "draft") void restore(item);
                              else {
                                void library
                                  .audioAccess({
                                    generation: item.generation,
                                    localResetId: item.localResetId,
                                  })
                                  .then(() => {
                                    openTicket.current++;
                                    setOpening(false);
                                    setRecording(item);
                                    setActive(null);
                                    setPanel(null);
                                  })
                                  .catch((e) => setError(message(e)));
                                if (item.state === "cloud_confirmed")
                                  void openNote(item.id);
                              }
                            }}
                          >
                            {item.kind === "draft"
                              ? item.readOnly
                                ? "Open copy"
                                : liveDrafts.some(
                                      (draft) => draft.draftId === item.draftId,
                                    )
                                  ? "Open draft"
                                  : "Restore"
                              : "Open audio"}
                          </button>
                          <button
                            className="text-button"
                            aria-label="Download local content"
                            onClick={() =>
                              item.kind === "recording"
                                ? audioDownload(item)
                                : void library
                                    .localAccess()
                                    .then(() =>
                                      exportText(item.input, item.updatedAt),
                                    )
                                    .catch((e) => setLocalError(message(e)))
                            }
                          >
                            <ArrowDownToLine size={16} /> Download
                          </button>
                          <button
                            className="icon-button"
                            aria-label="Delete local content"
                            onClick={() => void removeRecord(item)}
                            disabled={locked}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
          </div>
          <details className="recovery-storage">
            <summary>
              Storage & backups{" "}
              <span>
                {draftProtection === "protected"
                  ? "Text protected"
                  : draftProtection === "checking"
                    ? "Checking protection…"
                    : "Text protection not enabled"}
              </span>
            </summary>
            <button
              className="secondary"
              disabled={localUnavailable || draftProtection !== "available"}
              onClick={async () => {
                setDraftProtection("checking");
                try {
                  const granted = await navigator.storage?.persist?.();
                  setDraftProtection(granted ? "protected" : "available");
                  setToast(
                    granted
                      ? "Text drafts are protected from automatic cleanup. Audio remains temporary."
                      : "This browser could not protect text drafts. Download a backup; audio remains temporary.",
                  );
                } catch {
                  setDraftProtection("unavailable");
                  setToast(
                    "This browser cannot protect text drafts from cleanup. Download a backup; audio remains temporary.",
                  );
                }
              }}
            >
              {draftProtection === "protected"
                ? "Text drafts protected"
                : draftProtection === "checking"
                  ? "Checking…"
                  : "Protect text drafts"}
            </button>
            <p className="modal-footnote">
              Protection helps prevent automatic cleanup of text drafts. New
              audio remains temporary, even with protection enabled. Earlier
              saved audio is removed separately; other browsers keep their own
              local copies.
            </p>
          </details>
        </Modal>
      )}
    </div>
  );
}

function Editor({
  session,
  config,
  locked,
  library,
  areaLabel,
  notify,
  onDelete,
  onDuplicate,
}: {
  session: EditorSession;
  config: AppConfig | null;
  locked: boolean;
  library: LibraryController;
  areaLabel: string;
  notify: (s: string) => void;
  onDelete: () => void;
  onDuplicate: (input: CreateNote) => void;
}) {
  const draft = useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot,
  );
  const [enhanceOpen, setEnhanceOpen] = useState(false);
  const [preset, setPreset] = useState<Enhancement["preset"]>("clean");
  const [proposal, setProposal] = useState<{
    source: string;
    text: string;
    epoch: number;
  } | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [comparisonView, setComparisonView] = useState<"source" | "suggestion">(
    "suggestion",
  );
  const [error, setError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [cloudDeleted, setCloudDeleted] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [localRetrying, setLocalRetrying] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const words = draft.input.body.trim().split(/\s+/u).filter(Boolean).length;
  const tooLong =
    draft.input.body.length > (config?.limits.maxEnhanceLength ?? 12000);
  const readOnly =
    locked ||
    !!draft.readOnly ||
    ["deleting", "deleted", "archived"].includes(draft.status);
  const needsRecovery =
    !!draft.localIssue ||
    ["conflict", "deleted", "error"].includes(draft.status);
  const localRetryAction =
    draft.localIssue?.kind !== "discard" && draft.localIssue ? (
      <button
        className={
          ["local", "error"].includes(draft.status) ? "primary" : "text-button"
        }
        disabled={
          localRetrying ||
          locked ||
          ["deleting", "saving"].includes(draft.status)
        }
        onClick={async () => {
          setLocalRetrying(true);
          try {
            if (["local", "error"].includes(session.snapshot().status))
              await session.save();
            else await session.retryLocal();
          } finally {
            setLocalRetrying(false);
          }
        }}
      >
        {localRetrying
          ? "Retrying"
          : ["local", "error"].includes(draft.status)
            ? "Try saving again"
            : draft.status === "deleted"
              ? "Save a device copy"
              : draft.localIssue.kind === "cleanup"
                ? "Retry local cleanup"
                : "Retry local copy"}
      </button>
    ) : null;
  function closeActions(button: HTMLElement) {
    const menu = button.closest("details");
    if (menu) {
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
  }
  function exportCurrent(input: CreateNote, createdAt: string) {
    void library
      .localAccess()
      .then(() => exportNote(input, createdAt))
      .catch((e) => setError(message(e)));
  }
  async function copy(value: string) {
    try {
      await library.localAccess();
      await navigator.clipboard.writeText(value);
      notify("Copied. Ready for your next step.");
    } catch {
      setError(
        "The browser blocked copying. Select the text or download it instead.",
      );
    }
  }
  async function enhance() {
    if (enhancing || controller.current) return;
    setEnhancing(true);
    setProposal(null);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    try {
      const proposal = await session.proposeRefinement(async (source) => {
        const result = await library.execute(draft.input.generation, (signal) =>
          request("/enhance", enhancementResultSchema, {
            method: "POST",
            body: { text: source, preset, generation: draft.input.generation },
            operation: "model",
            signal: AbortSignal.any([abort.signal, signal]),
          }),
        );
        if (result.generation !== draft.input.generation)
          throw new ClientError(
            "This suggestion belongs to an earlier library.",
          );
        return result.text;
      });
      if (controller.current === abort && !abort.signal.aborted)
        setProposal(proposal);
    } catch (e) {
      if (controller.current === abort && !abort.signal.aborted)
        setError(message(e));
    } finally {
      if (controller.current === abort) {
        setEnhancing(false);
        controller.current = null;
      }
    }
  }
  async function deleteNote() {
    if (deleting) return;
    setDeleting(true);
    setError("");
    try {
      if (!cloudDeleted) {
        await session.prepareDelete();
        let revision = draft.baseRevision;
        if (revision === null) {
          try {
            const current = await library.execute(
              draft.input.generation,
              (signal) =>
                request(
                  `/notes/${draft.noteId}?generation=${draft.input.generation}`,
                  noteSchema,
                  { signal },
                ),
            );
            if (classifyCreateReplay(draft.input, current) !== "confirmed") {
              throw new ClientError(
                "The library has a different version. Review both before deleting.",
                409,
                "revision_conflict",
                { kind: "note", current },
              );
            }
            revision = current.revision;
          } catch (e) {
            if (
              !(e instanceof ClientError && [404, 410].includes(e.status ?? 0))
            )
              throw e;
          }
        }
        if (revision !== null)
          await library.execute(draft.input.generation, (signal) =>
            request(`/notes/${draft.noteId}`, z.undefined(), {
              signal,
              method: "DELETE",
              body: {
                expectedRevision: revision,
                generation: draft.input.generation,
              },
            }),
          );
        setCloudDeleted(true);
        session.removed();
      }
      await session.secure();
      await removeLocal(draft.draftId, draft.input.generation);
      onDelete();
    } catch (e) {
      if (!cloudDeleted && session.snapshot().status === "deleting")
        session.deleteFailed(e);
      setError(message(e));
    } finally {
      setDeleting(false);
    }
  }
  return (
    <article className="editor">
      <div className="editor-topline">
        <div className="section-label">
          <span className="tiny-line" /> YOUR NOTE
        </div>
        <span className={`save-status status-${draft.status}`} role="status">
          {draft.status === "saved" ? (
            <Check size={14} />
          ) : draft.status === "saving" ? (
            <LoaderCircle className="spin" size={14} />
          ) : (
            <span className="status-dot amber" />
          )}
          {!draft.durable && draft.status === "local"
            ? draft.localIssue?.kind === "persist"
              ? "Not saved yet"
              : "Saving on this device"
            : statuses[draft.status]}
        </span>
      </div>
      <label className="sr-only" htmlFor="note-title">
        Note title
      </label>
      <textarea
        rows={1}
        id="note-title"
        className="note-title"
        value={draft.input.title}
        onChange={(e) => session.edit({ title: e.target.value })}
        placeholder="An untitled thought"
        maxLength={160}
        readOnly={readOnly}
      />
      {draft.readOnly && (
        <p className="notice" role="status">
          This is a read-only copy from earlier local work. Copy or download it
          to keep it.
        </p>
      )}
      <div className="editor-metadata">
        <span>{areaLabel}</span>
        <span>·</span>
        <span>{date(draft.current?.createdAt ?? draft.updatedAt)}</span>
        <span>·</span>
        <span>
          <AudioLines size={13} /> {duration(draft.input.durationMs)}
        </span>
        <span>·</span>
        <span>
          {draft.input.provider === "google" ? "Google" : "Mistral"} /{" "}
          {draft.input.mode === "smart" ? "Polished" : "Verbatim"}
        </span>
      </div>
      <div className="editor-toolbar">
        <span className="text-version">
          <span className="status-dot" /> Your version
        </span>
        <div>
          <button
            className="tool-button enhance-trigger"
            disabled={readOnly || !draft.input.body.trim()}
            onClick={() => setEnhanceOpen(true)}
          >
            <Sparkles size={16} /> Refine
          </button>
          <span className="toolbar-separator" />
          <button
            className={`${needsRecovery ? "secondary" : "primary"} copy-action`}
            aria-label="Copy text"
            onClick={() => void copy(draft.input.body)}
            disabled={!draft.input.body}
          >
            <Copy size={16} />
            <span>Copy</span>
          </button>
          <details
            className="note-more"
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget))
                e.currentTarget.open = false;
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.currentTarget.open = false;
                e.currentTarget.querySelector("summary")?.focus();
              }
            }}
          >
            <summary>
              More <ChevronDown size={15} />
            </summary>
            <div className="note-more-panel">
              <button
                className="tool-button"
                onClick={(e) => {
                  exportCurrent(
                    draft.input,
                    draft.current?.createdAt ?? draft.updatedAt,
                  );
                  closeActions(e.currentTarget);
                }}
                aria-label="Download note as Markdown"
              >
                <ArrowDownToLine size={17} /> Download Markdown
              </button>
              <button
                className="tool-button delete-action"
                onClick={(e) => {
                  closeActions(e.currentTarget);
                  setDeleteOpen(true);
                }}
                disabled={readOnly || draft.status === "saving"}
                aria-label="Delete note"
              >
                <Trash2 size={16} /> Delete note
              </button>
            </div>
          </details>
        </div>
      </div>
      {draft.status === "conflict" && draft.current && (
        <section className="conflict-panel" aria-label="Resolve conflict">
          <div>
            <span className="eyebrow">
              {draft.durable ? "TWO VERSIONS TO REVIEW" : "KEEP THIS TAB OPEN"}
            </span>
            <h3>This note was edited elsewhere.</h3>
            <p>
              The cloud has a different version. Compare both before choosing.
              Your text remains in the editor below.
            </p>
          </div>
          <div className="conflict-comparison">
            <div>
              <strong>
                Your version · {draft.durable ? "this device" : "this tab only"}
              </strong>
              <small>{localDate(draft.updatedAt)}</small>
              <pre>
                {[...draft.input.body].slice(0, 180).join("")}
                {[...draft.input.body].length > 180 ? "…" : ""}
              </pre>
            </div>
            <div>
              <strong>Cloud version</strong>
              <small>{localDate(draft.current.updatedAt)}</small>
              <pre>
                {[...draft.current.body].slice(0, 180).join("")}
                {[...draft.current.body].length > 180 ? "…" : ""}
              </pre>
            </div>
          </div>
          <details>
            <summary>Read both full versions</summary>
            <strong>Your version</strong>
            <pre>{draft.input.body}</pre>
            <button
              className="text-button"
              onClick={() => void copy(draft.input.body)}
            >
              Copy my version
            </button>
            <strong>Cloud version · {draft.current.title}</strong>
            <pre>{draft.current.body}</pre>
            <button
              className="text-button"
              onClick={() => void copy(draft.current!.body)}
            >
              Copy cloud version
            </button>
          </details>
          <div className="button-row">
            <button
              className="secondary"
              onClick={() => {
                if (
                  window.confirm(
                    "Replace the cloud text with your version? Copy the cloud version first if you want to keep both.",
                  )
                )
                  session.resolve("local");
              }}
            >
              Replace cloud with my version
            </button>
            <button
              className="secondary"
              onClick={() => {
                if (
                  window.confirm(
                    "Replace this editor with the cloud version? Copy or download your version first if you want to keep both.",
                  )
                )
                  session.resolve("remote");
              }}
            >
              Keep cloud version
            </button>
          </div>
          {draft.localIssue && (
            <div className="local-warning-detail" role="alert">
              <p>{draft.localIssue.message}</p>
              {localRetryAction}
            </div>
          )}
        </section>
      )}
      {draft.status !== "conflict" && (draft.localIssue || draft.error) && (
        <div className="notice local-warning" role="alert">
          <span>
            {draft.status === "deleted" || draft.status === "error"
              ? draft.error
              : draft.localIssue
                ? draft.status === "saved"
                  ? "Saved to cloud. Recovery on this device needs attention."
                  : draft.localIssue.message
                : draft.error}
            {["deleted", "error"].includes(draft.status) &&
              draft.localIssue && (
                <small className="local-warning-detail">
                  {draft.localIssue.message}
                </small>
              )}
          </span>
          <div className="recovery-actions">
            {draft.status === "error" && !draft.localIssue && (
              <button className="primary" onClick={() => void session.save()}>
                Try saving again
              </button>
            )}
            {draft.status === "deleted" && (
              <button
                className="primary"
                onClick={() => onDuplicate(draft.input)}
              >
                Save as a new note
              </button>
            )}
            {localRetryAction}
          </div>
        </div>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <label className="sr-only" htmlFor="note-body">
        Your editable version
      </label>
      <textarea
        id="note-body"
        className="note-body"
        value={draft.input.body}
        onChange={(e) => session.edit({ body: e.target.value })}
        readOnly={readOnly}
        maxLength={100000}
        placeholder="A little room for your thoughts."
        spellCheck
      />
      <div className="editor-bottom">
        <span>
          {words} {words === 1 ? "word" : "words"}
          <span className="metadata-divider">/</span>
          {new Intl.NumberFormat("en").format(draft.input.body.length)}{" "}
          characters
        </span>
        <span>
          {draft.status === "saved" ? (
            "Changes sync automatically"
          ) : draft.status === "conflict" ? (
            "Choose a version to resume syncing"
          ) : draft.durable ? (
            "Recovery copy saved on this device"
          ) : (
            <>
              Only in this tab. Keep it open or{" "}
              <button
                className="text-button"
                onClick={() =>
                  exportCurrent(
                    draft.input,
                    draft.current?.createdAt ?? draft.updatedAt,
                  )
                }
              >
                download a copy
              </button>
              .
            </>
          )}
        </span>
      </div>
      {draft.refinement && (
        <details
          className="original previous-version"
          open={draft.input.body === draft.refinement.applied}
        >
          <summary>
            <Undo2 size={16} />
            <span>Before last refinement</span>
            <ChevronDown size={16} />
          </summary>
          <pre>{draft.refinement.before}</pre>
          <div className="button-row">
            <button
              className="secondary"
              disabled={
                readOnly || draft.input.body !== draft.refinement.applied
              }
              onClick={() => {
                if (session.undoRefinement())
                  notify("Previous working version restored.");
              }}
            >
              <Undo2 size={16} /> Undo refinement
            </button>
            <button
              className="text-button"
              onClick={() => void copy(draft.refinement!.before)}
            >
              Copy previous version
            </button>
          </div>
          {draft.input.body !== draft.refinement.applied && (
            <p className="field-hint">
              You have edited the text since refining. Copy the previous version
              to keep those newer edits safe.
            </p>
          )}
        </details>
      )}
      <details className="original">
        <summary>
          <FileText size={16} />
          <span>Initial transcription</span>
          <span className="original-hint">· Kept unchanged</span>
          <ChevronDown size={16} />
        </summary>
        <pre>{draft.input.originalText}</pre>
        <button
          className="text-button"
          onClick={() => void copy(draft.input.originalText)}
        >
          Copy initial transcription
        </button>
      </details>
      {enhanceOpen && (
        <Modal
          title="Refine your text"
          close={() => {
            controller.current?.abort();
            setEnhanceOpen(false);
          }}
          wide
        >
          <p className="modal-intro">GLM 5.3 Flash · Text sent to Fireworks.</p>
          <details
            className={`refinement-settings ${proposal ? "has-proposal" : ""}`}
            open={!proposal}
          >
            <summary>
              {preset === "clean"
                ? "Clean up wording"
                : preset === "bullets"
                  ? "Bullet points"
                  : "English translation"}
              <span>
                Change style <ChevronDown size={14} />
              </span>
            </summary>
            <div className="refinement-style">
              <label className="field-label" htmlFor="refinement-style">
                What should change?
              </label>
              <select
                id="refinement-style"
                value={preset}
                disabled={enhancing}
                onChange={(e) => {
                  setPreset(e.target.value as Enhancement["preset"]);
                  setProposal(null);
                }}
              >
                <option value="clean">Clean up the wording</option>
                <option value="bullets">Structure as bullet points</option>
                <option value="english">Translate into English</option>
              </select>
              <p className="field-hint">
                {preset === "clean"
                  ? "Remove filler while keeping your meaning."
                  : preset === "bullets"
                    ? "Organize your thoughts without dropping details."
                    : "Keep your meaning in natural English."}
              </p>
            </div>
          </details>
          {tooLong && (
            <p className="notice">
              Refining is limited to 12,000 characters. You can still save and
              export this note.
            </p>
          )}
          {!config?.enhancementAvailable && (
            <p className="notice">
              Set up Fireworks in your local configuration to refine text.
            </p>
          )}
          {error && (
            <p className="notice" role="alert">
              {error}
            </p>
          )}
          {proposal && (
            <section className="proposal" aria-label="Compare refinement">
              <div
                className="comparison-switch"
                role="group"
                aria-label="Compare versions"
              >
                <button
                  aria-pressed={comparisonView === "source"}
                  onClick={() => setComparisonView("source")}
                >
                  Before refinement
                </button>
                <button
                  aria-pressed={comparisonView === "suggestion"}
                  onClick={() => setComparisonView("suggestion")}
                >
                  Suggestion
                </button>
              </div>
              <div className={`comparison show-${comparisonView}`}>
                <div className="comparison-source">
                  <h3>Before refinement</h3>
                  <pre tabIndex={0} aria-label="Before refinement full text">
                    {proposal.source}
                  </pre>
                </div>
                <div className="comparison-suggestion">
                  <h3>Suggestion</h3>
                  <pre tabIndex={0} aria-label="Suggested full text">
                    {proposal.text}
                  </pre>
                </div>
              </div>
              <p className="comparison-hint">
                Long versions scroll inside each text panel.
              </p>
              <p className="proposal-disclaimer">
                Check meaning, order, and negations. Applying replaces your
                working text; you can undo this refinement.
              </p>
              {proposal.source !== draft.input.body && (
                <p className="notice">
                  Your text has changed. Generate a new suggestion or copy this
                  one.
                </p>
              )}
            </section>
          )}
          <div className="modal-actions">
            {proposal ? (
              <>
                <button
                  className="text-button"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(proposal.text)
                      .then(() => notify("Suggestion copied. Note unchanged."))
                      .catch(() =>
                        setError(
                          "Copy was blocked. Select the suggestion text instead.",
                        ),
                      );
                  }}
                >
                  <Copy size={16} /> Copy suggestion
                </button>
                <button
                  className="primary"
                  disabled={proposal.source !== draft.input.body || readOnly}
                  onClick={() => {
                    if (
                      !session.applyRefinement(
                        proposal.text,
                        proposal.source,
                        proposal.epoch,
                      )
                    )
                      return;
                    setEnhanceOpen(false);
                    setProposal(null);
                    notify(
                      "Refinement applied. You can undo it below the editor.",
                    );
                  }}
                >
                  <Check size={17} /> Apply to note
                </button>
              </>
            ) : (
              <>
                <button
                  className="primary"
                  onClick={() => void enhance()}
                  disabled={
                    enhancing ||
                    tooLong ||
                    !config?.enhancementAvailable ||
                    !draft.input.body.trim() ||
                    readOnly
                  }
                >
                  {enhancing ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <Sparkles size={17} />
                  )}
                  {enhancing ? "Refining" : "Create suggestion"}
                </button>
              </>
            )}
            {proposal && (
              <button
                className="text-button"
                onClick={() => void enhance()}
                disabled={enhancing || tooLong || readOnly}
              >
                Generate again
              </button>
            )}
          </div>
        </Modal>
      )}
      {deleteOpen && (
        <Modal
          title={cloudDeleted ? "Library note deleted" : "Delete this thought?"}
          close={() => {
            if (!deleting) setDeleteOpen(false);
          }}
        >
          <p className="modal-intro">
            {cloudDeleted
              ? "The note has been removed from your shared library. Local copies still need to be removed."
              : "This removes the note from your shared library, its current draft and temporary audio. Earlier saved audio and other local copies remain."}
          </p>
          {error && <p className="notice">{error}</p>}
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={deleting}
              onClick={() => setDeleteOpen(false)}
            >
              Go back
            </button>
            <button
              className="danger"
              disabled={deleting}
              onClick={() => void deleteNote()}
            >
              {deleting ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Trash2 size={16} />
              )}
              {cloudDeleted ? "Retry local deletion" : "Delete note"}
            </button>
          </div>
        </Modal>
      )}
    </article>
  );
}
function SettingsPanel({
  config,
  initial,
  close,
  onSaved,
}: {
  config: AppConfig | null;
  initial: Settings | null;
  close: () => void;
  onSaved: (s: Settings, notice: string) => void;
}) {
  const [value, setValue] = useState<VocabularyInput>({
    terms: initial?.vocabulary ?? [],
    pending: "",
    error: "",
    announcement: "",
  });
  const [base, setBase] = useState(initial);
  const [conflict, setConflict] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const conflictPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (conflict) {
      conflictPanel.current?.focus();
      conflictPanel.current?.scrollIntoView({ block: "nearest" });
    }
  }, [conflict]);
  const dirty =
    hasPendingVocabulary(value.pending) ||
    !sameVocabularyTerms(value.terms, base?.vocabulary ?? []);
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);
  function accept(saved: Settings, notice = "Vocabulary saved.") {
    setBase(saved);
    setValue({
      terms: saved.vocabulary,
      pending: "",
      error: "",
      announcement: notice,
    });
    setConflict(null);
    onSaved(saved, notice);
  }
  function closePanel() {
    if (saving.current) return;
    if (dirty && !window.confirm("Discard unsaved vocabulary changes?")) return;
    close();
  }
  async function save() {
    if (!base || saving.current || conflict) return;
    const { value: committed, write: body } = prepareVocabularySave(
      value.terms,
      value.pending,
      base,
    );
    setValue(committed);
    setError("");
    if (!body) return;
    saving.current = true;
    setBusy(true);
    try {
      accept(
        await request("/settings", settingsSchema, { method: "PUT", body }),
      );
    } catch (e) {
      if (e instanceof ClientError && e.conflict?.kind === "settings") {
        if (classifySettingsConflict(body, e.conflict.current) === "confirmed")
          accept(e.conflict.current);
        else setConflict(e.conflict.current);
      } else setError(message(e));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Words that sound like you."
      close={closePanel}
      className="vocabulary-settings"
    >
      <div className="vocabulary-settings-content">
        <p className="modal-intro">
          Names, projects and your own spellings. Included in every new
          recording.
        </p>
        {!base && (
          <p className="notice">
            Vocabulary is not available yet. Close this panel and check the
            connection.
          </p>
        )}
        {conflict && (
          <section
            ref={conflictPanel}
            tabIndex={-1}
            className="conflict-panel vocabulary-conflict"
            aria-label="Resolve vocabulary conflict"
          >
            <h3>Your vocabulary was changed elsewhere.</h3>
            <p>
              Your {value.terms.length} terms are kept. Review them, then save
              to replace the other version. Or use the other version now.
            </p>
            <details>
              <summary>
                Other version · {conflict.vocabulary.length}{" "}
                {conflict.vocabulary.length === 1 ? "term" : "terms"}
              </summary>
              {conflict.vocabulary.length ? (
                <ul
                  className="vocabulary-tags vocabulary-readonly"
                  aria-label="Other vocabulary terms"
                >
                  {sortedVocabulary(conflict.vocabulary).map((term) => (
                    <li key={term}>
                      <span>{term}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>Empty vocabulary</p>
              )}
            </details>
          </section>
        )}
        {!conflict && (
          <>
            <VocabularyEditor
              value={value}
              onChange={setValue}
              disabled={busy || !base}
            />
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
            <details className="vocabulary-models">
              <summary>
                Your models <ChevronDown size={15} aria-hidden="true" />
              </summary>
              <div className="provider-overview">
                {config?.providers.map((p) => (
                  <div key={p.id}>
                    <span>
                      {p.label}
                      <small>{p.model}</small>
                    </span>
                    <span
                      className={
                        p.available ? "provider-ready" : "provider-missing"
                      }
                    >
                      {p.available ? (
                        <Check size={14} />
                      ) : (
                        <CircleHelp size={14} />
                      )}
                      {p.available ? "Connected" : "Not configured"}
                    </span>
                  </div>
                ))}
                <p className="field-hint">
                  Select a provider in the recording bar. Credentials stay in
                  your local project configuration. Mistral receives spaces
                  within a term as underscores.
                </p>
              </div>
            </details>
          </>
        )}
      </div>
      <div className="modal-actions">
        {conflict ? (
          <>
            <div className="vocabulary-conflict-actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setBase(conflict);
                  setConflict(null);
                }}
              >
                Review terms
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  if (
                    !window.confirm(
                      "Replace your unsaved vocabulary with the other version?",
                    )
                  )
                    return;
                  accept(conflict, "Using the other vocabulary version.");
                }}
              >
                Use other version
              </button>
            </div>
            <p className="modal-footnote">Your changes are not saved.</p>
          </>
        ) : (
          <>
            <span className="modal-footnote">
              {dirty ? "Unsaved changes" : "Saved across your computers"}
            </span>
            <button
              type="button"
              className="primary"
              disabled={busy || !base || !dirty}
              onClick={() => void save()}
            >
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Check size={16} />
              )}
              {busy ? "Saving vocabulary" : "Save vocabulary"}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
