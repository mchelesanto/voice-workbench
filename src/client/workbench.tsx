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
  createNoteSchema,
  noteSchema,
  settingsSchema,
  vocabularySchema,
  type CreateNote,
  type Mode,
  type NotePage,
  type Provider,
  type Settings,
  type Enhancement,
  type Note,
} from "../shared/contracts";
import {
  configSchema,
  enhancementResultSchema,
  notePageSchema,
  transcriptionResultSchema,
  classifySettingsConflict,
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
  confirmRecording,
  type LocalRecord,
  type Recording,
} from "./local-store";
import { download, duration, exportNote } from "./export";
import { useRecorder } from "./use-recorder";
import {
  recordingConfirmation,
  recordingRecovery,
  recordingProvider,
  selectLocalRecording,
} from "./recording-recovery";

const emptyPage: NotePage = { items: [], nextCursor: null };
const statuses = {
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
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
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
      className={`modal ${wide ? "modal-wide" : ""}`}
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
function AudioPlayer({ blob }: { blob: Blob }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const element = ref.current;
    const url = URL.createObjectURL(blob);
    if (element) element.src = url;
    return () => {
      if (element) {
        element.pause();
        element.removeAttribute("src");
        element.load();
      }
      URL.revokeObjectURL(url);
    };
  }, [blob]);
  return (
    <audio
      ref={ref}
      controls
      preload="metadata"
      aria-label="Play this local recording"
    />
  );
}
export function Workbench() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [page, setPage] = useState<NotePage>(emptyPage);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<EditorSession | null>(null);
  const [provider, setProvider] = useState<Provider>("google");
  const [mode, setMode] = useState<Mode>("verbatim");
  const [panel, setPanel] = useState<
    "local" | "settings" | "help" | "library" | "recording-options" | null
  >(null);
  const [local, setLocal] = useState<LocalRecord[]>([]);
  const [localError, setLocalError] = useState("");
  const [localUnavailable, setLocalUnavailable] = useState(false);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [recordingDurable, setRecordingDurable] = useState(false);
  const [processing, setProcessing] = useState(false);
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
    try {
      const result = await listLocal();
      setLocalUnavailable(false);
      setLocal(result.records);
      setLocalError(
        result.invalid
          ? `${result.invalid} local entries could not be read. They have not been changed.`
          : "",
      );
    } catch {
      setLocalUnavailable(true);
      setLocalError(
        "Local storage is unavailable. Copy or download unsaved text and recordings before leaving.",
      );
    }
  }, []);
  const refresh = useCallback(async (cursor?: string) => {
    const ticket = ++listTicket.current;
    setLoading(true);
    try {
      const result = await request(
        `/notes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        notePageSchema,
      );
      if (ticket !== listTicket.current) return;
      setPage((previous) =>
        cursor
          ? {
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
  }, []);
  const acknowledgeRecording = useCallback(
    (note: Note) => {
      void confirmRecording(note)
        .then((confirmed) => {
          if (!confirmed) return;
          setRecording((current) =>
            current
              ? (recordingConfirmation(current, note) ?? current)
              : current,
          );
          void refreshLocal();
        })
        .catch(() => {
          setError(
            "Saved to cloud. The recording status on this device could not be updated. Open the cloud note again to retry.",
          );
        });
    },
    [refreshLocal],
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
        request(`/notes/${id}`, noteSchema, {
          method: revision === null ? "PUT" : "PATCH",
          body:
            revision === null
              ? input
              : {
                  title: input.title,
                  body: input.body,
                  expectedRevision: revision,
                },
        }),
    }),
    [refresh, refreshLocal, acknowledgeRecording],
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
    ]);
    if (results[0].status === "fulfilled") setConfig(results[0].value);
    else setError(message(results[0].reason));
    if (results[1].status === "fulfilled") setSettings(results[1].value);
    else setError(message(results[1].reason));
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      void setup();
      void refresh();
      void refreshLocal();
    }, 0);
    return () => clearTimeout(timer);
  }, [setup, refresh, refreshLocal]);
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
    async (item: Recording) => {
      if (!item.result) return;
      const session = new EditorSession(
        {
          kind: "draft",
          draftId: crypto.randomUUID(),
          editorInstanceId: crypto.randomUUID(),
          noteId: item.id,
          input: item.result,
          baseRevision: null,
          updatedAt: item.createdAt,
          status: "local",
          durable: true,
        },
        ports(),
      );
      await session.secure();
      activate(session);
      await session.save();
      await refreshLocal();
    },
    [ports, activate, refreshLocal],
  );
  const transcribe = useCallback(
    async (item: Recording) => {
      if (processingRef.current || (!item.result && !settings)) return;
      processingRef.current = true;
      setProcessing(true);
      setError("");
      setRecording(item);
      const controller = new AbortController();
      modelAbort.current = controller;
      let progress: Recording = item;
      try {
        const recovery = recordingRecovery(item);
        const stored: Recording =
          item.blob.size > 25 * 1024 * 1024 && !item.result
            ? {
                ...item,
                state: "error",
                errorCode: "audio_too_large",
                error: recovery.hint,
              }
            : item;
        setRecording(stored);
        setRecordingDurable(false);
        await putLocal(stored);
        setRecordingDurable(true);
        if (recovery.action === "none") {
          setError(
            recovery.hint ?? "This recording is already saved to cloud.",
          );
          return;
        }
        if (item.result) {
          await createFromRecording(item);
          return;
        }
        const pending: Recording = {
          ...item,
          state: "transcribing",
          error: undefined,
          errorCode: undefined,
        };
        await putLocal(pending);
        progress = pending;
        setRecording(pending);
        const form = new FormData();
        const essence = item.mime.split(";")[0];
        const extension =
          essence === "audio/mp4"
            ? "m4a"
            : essence === "audio/ogg"
              ? "ogg"
              : "webm";
        form.set("audio", item.blob, `recording.${extension}`);
        form.set("provider", item.provider);
        form.set("mode", item.mode);
        form.set("vocabulary", JSON.stringify(settings!.vocabulary));
        const result = await request("/transcribe", transcriptionResultSchema, {
          method: "POST",
          body: form,
          operation: "model",
          signal: controller.signal,
        });
        const input = createNoteSchema.parse({
          title: transcriptTitle(result.text),
          originalText: result.text,
          body: result.text,
          provider: result.provider,
          model: result.model,
          mode: result.mode,
          durationMs: item.durationMs,
        });
        const done: Recording = {
          ...item,
          state: "transcribed",
          result: input,
          error: undefined,
          errorCode: undefined,
        };
        progress = done;
        setRecording(done);
        setRecordingDurable(false);
        await putLocal(done);
        setRecordingDurable(true);
        await createFromRecording(done);
      } catch (e) {
        setError(message(e));
        // Preserve a successful result if only the subsequent local save failed.
        if (progress.state === "transcribing") {
          const failed: Recording = {
            ...progress,
            state: modelFailureState(e),
            error: message(e),
            errorCode: e instanceof ClientError ? e.code : undefined,
          };
          setRecording(failed);
          await putLocal(failed).catch(() => {});
        }
      } finally {
        processingRef.current = false;
        setProcessing(false);
        modelAbort.current = null;
        void refreshLocal();
      }
    },
    [settings, createFromRecording, refreshLocal],
  );
  const recorder = useRecorder((item, damaged) => {
    openTicket.current++;
    setOpening(false);
    setRecording(item);
    setRecordingDurable(false);
    setActive(null);
    if (damaged) {
      void putLocal(item)
        .then(() => {
          setRecordingDurable(true);
          void refreshLocal();
        })
        .catch((e) => setError(message(e)));
    } else void transcribe(item);
  });
  const locked = recorder.phase !== "idle" || processing;
  const beginRecording = () => {
    if (recording && !recordingDurable) {
      setError(
        "Save this recording on this device first. Or download a backup, then remove this in-memory copy to continue.",
      );
      return;
    }
    openTicket.current++;
    setOpening(false);
    setActive(null);
    setRecording(null);
    void recorder.start(provider, mode);
  };
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => {
      if (
        locked ||
        (recording && !recordingDurable) ||
        [...sessions.current.values()].some((s) =>
          warnBeforeLeaving(s.snapshot()),
        )
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [locked, recording, recordingDurable]);
  const refreshWorkspace = useCallback(() => {
    void refresh();
    void refreshLocal();
    if (active)
      void request(`/notes/${active.snapshot().noteId}`, noteSchema)
        .then((n) => active.revalidate(n))
        .catch((e) => {
          if (e instanceof ClientError && [404, 410].includes(e.status ?? 0))
            active.removed();
          else setError(message(e));
        });
  }, [active, refresh, refreshLocal]);
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
      const note = await request(`/notes/${id}`, noteSchema);
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
    if (locked) return;
    const live = sessions.current.get(draft.draftId);
    if (live) {
      activate(live);
      return;
    }
    const session = EditorSession.restore(draft, ports());
    activate(session);
    const ticket = openTicket.current;
    try {
      await session.secure();
      if (ticket !== openTicket.current) return;
      if (session.snapshot().status === "saved") await session.retryLocal();
      else if (draft.status !== "conflict" && draft.status !== "deleted")
        await session.save();
      if (ticket === openTicket.current)
        setToast("Draft restored as a separate version.");
    } catch {
      // The active draft carries its local warning and recovery actions.
    }
  }
  async function removeRecord(item: LocalRecord) {
    if (
      !window.confirm(
        item.kind === "recording"
          ? "Delete this recording from this device? The library note will remain."
          : "Delete this local draft? The library note will remain.",
      )
    )
      return;
    try {
      const session =
        item.kind === "draft" ? sessions.current.get(item.draftId) : undefined;
      if (session) {
        await session.discard();
        forgetSession(session);
        setActive((current) => (current === session ? null : current));
      } else
        await removeLocal(item.kind === "recording" ? item.id : item.draftId);
      if (item.kind === "recording" && recording?.id === item.id)
        setRecording(null);
      await refreshLocal();
    } catch (e) {
      setError(message(e));
    }
  }
  function audioDownload(item: Recording) {
    const type = item.mime.split(";")[0];
    download(
      item.blob,
      `recording-${item.createdAt.replace(/[:.]/g, "-")}.${type === "audio/mp4" ? "m4a" : type === "audio/ogg" ? "ogg" : "webm"}`,
    );
  }
  const records = mergeLocalRecords(local, liveDrafts);
  const unsaved = records.filter(needsLocalAttention);
  const attentionCount = new Set(
    unsaved.map((x) => (x.kind === "draft" ? x.noteId : x.id)),
  ).size;
  const visibleRecording = active
    ? recording?.id === active.snapshot().noteId
      ? recording
      : records.find(
          (x): x is Recording =>
            x.kind === "recording" && x.id === active.snapshot().noteId,
        )
    : recording;
  const visibleRecordingDurable =
    visibleRecording?.id === recording?.id ? recordingDurable : true;
  const recoveryAction = visibleRecording
    ? recordingRecovery(visibleRecording)
    : null;
  async function secureRecording(item: Recording) {
    try {
      await putLocal(item);
      if (recording?.id === item.id) setRecordingDurable(true);
      setError("");
      await refreshLocal();
      setToast("Recording saved in this browser.");
    } catch (e) {
      setError(message(e));
    }
  }
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
      return { id, entries, title, pending };
    })
    .filter((g) => g.entries.length)
    .sort((a, b) => Number(b.pending) - Number(a.pending));
  const library = (
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
        disabled={locked}
        onClick={() => {
          openTicket.current++;
          setOpening(false);
          setActive(null);
          setPanel(null);
          if (recordingDurable) setRecording(null);
        }}
      >
        <Plus size={19} /> New recording <span>＋</span>
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
                : "Your first note starts with your voice."}
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
          disabled={locked}
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
      className={`app-shell ${active ? "has-note" : ""} ${active && (active.snapshot().localIssue || ["conflict", "deleted", "error"].includes(active.snapshot().status)) ? "has-recovery" : ""} ${active?.snapshot().status === "conflict" ? "has-conflict" : ""}`}
    >
      <a className="skip-link" href="#main">
        Skip to workspace
      </a>
      <aside className="sidebar">{library}</aside>
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
              {active
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
          {(error || recorder.error) && (
            <div className="notice error-notice" role="alert">
              <span>{error || recorder.error}</span>
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
              <span>Your unfinished thoughts are still here.</span>
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
          {active ? (
            <Editor
              key={active.snapshot().draftId}
              session={active}
              config={config}
              locked={locked}
              notify={setToast}
              onDelete={() => {
                forgetSession(active);
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
          ) : visibleRecording && !locked ? (
            <section className="recording-heading">
              <div className="section-label">YOUR RECORDING</div>
              <h1>Recover your recording.</h1>
              <p>Listen, recover your transcript, or download the audio.</p>
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
                    ? "Your recording is safe on this device. Your transcript is taking shape."
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
          {visibleRecording && !processing && (
            <section className="recording-receipt" aria-label="Local recording">
              <div className="receipt-heading">
                <AudioLines size={19} />
                <div>
                  <strong>
                    {visibleRecording.result?.title || "Recorded thought"}
                  </strong>
                  <small>
                    {duration(visibleRecording.durationMs)} · Recorded with{" "}
                    {recordingProvider(visibleRecording)} ·{" "}
                    {visibleRecordingDurable
                      ? "Audio saved in this browser"
                      : "In memory only. Save or download before leaving."}
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
                <AudioPlayer blob={visibleRecording.blob} />
              </details>
              {visibleRecording.result && !active && (
                <div className="rescued-text">
                  <h3>Your transcript</h3>
                  <pre>{visibleRecording.result.body}</pre>
                  <button
                    className="secondary"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(visibleRecording.result!.body)
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
                      exportNote(
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
                {!visibleRecordingDurable && (
                  <button
                    className="secondary"
                    disabled={locked}
                    onClick={() => void secureRecording(visibleRecording)}
                  >
                    Save on this device
                  </button>
                )}
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
                  className="text-button"
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
              {!visibleRecordingDurable && (
                <p className="field-hint">
                  After downloading your backup, remove this in-memory copy to
                  start another recording.
                </p>
              )}
            </section>
          )}
        </div>
        <footer
          className={`recording-dock ${locked ? "dock-busy" : ""} ${recorder.phase === "recording" ? "dock-recording" : ""}`}
        >
          <div className="dock-detail">
            <span className="dock-mic">
              <Mic size={21} />
            </span>
            <div>
              <strong>
                {processing
                  ? recording?.result
                    ? "Saving transcript"
                    : "Transcribing new note"
                  : recorder.phase === "permission"
                    ? "Allow microphone access"
                    : recorder.phase === "stopping"
                      ? "Saving recording"
                      : recorder.phase === "recording"
                        ? "Recording new note"
                        : "Ready when you are"}
              </strong>
              <small>
                {processing
                  ? recording?.result
                    ? "Your words are saved locally before syncing"
                    : `With ${recording?.provider === "mistral" ? "Mistral" : "Google"} · local audio copy retained`
                  : recorder.phase === "recording"
                    ? `${duration(recorder.elapsed)} / 10:00`
                    : "One recording. One new note."}
              </small>
            </div>
          </div>
          <div className="dock-center">
            {!locked && (
              <span className="next-recording-label">Next recording</span>
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
          ) : processing ? (
            <button
              className="dock-secondary"
              onClick={() => modelAbort.current?.abort()}
            >
              <X size={17} /> Cancel
            </button>
          ) : (
            <button
              className="primary record-button"
              disabled={locked || !available || !settings}
              onClick={beginRecording}
            >
              <Mic size={18} />
              <span>{active ? "New recording" : "Record"}</span>
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
      {panel === "library" && (
        <Modal title="Your library" close={() => setPanel(null)}>
          <div className="mobile-library">{library}</div>
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
              <h3>A local copy of your audio.</h3>
              <p>
                Audio is sent to your selected transcription provider.
                Recordings and pending drafts are stored in this browser
                profile. Clearing browser data removes them too. Download audio
                for a separate backup.
              </p>
            </div>
            <div>
              <Sparkles size={24} />
              <h3>You have the final word.</h3>
              <p>
                Transcription sends audio to Google or Mistral. Refining sends
                text to Mistral and produces a suggestion. Always check names,
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
          config={config}
          initial={settings}
          close={() => setPanel(null)}
          onSaved={(value) => {
            setSettings(value);
            setToast("Vocabulary saved.");
          }}
        />
      )}
      {panel === "local" && (
        <Modal title="Local audio & drafts" close={() => setPanel(null)} wide>
          <p className="modal-intro">
            Audio recordings and unfinished drafts stored in this browser. They
            are not synced to your other computers.
          </p>
          {(localError ||
            records.some(
              (item) =>
                item.kind === "draft" &&
                !item.durable &&
                item.status !== "saved",
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
          <div className="local-list">
            {recoveryGroups.map((group) => (
              <section className="recovery-group" key={group.id}>
                <div className="recovery-heading">
                  <h3>{group.title}</h3>
                  <span>
                    {group.pending ? "Needs attention" : "Saved recording"}
                  </span>
                </div>
                {group.entries.map((item) => (
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
                          : item.input.title || "Untitled draft"}
                      </strong>
                      <small>
                        {localDate(
                          item.kind === "recording"
                            ? item.createdAt
                            : item.updatedAt,
                        )}{" "}
                        ·{" "}
                        {item.kind === "recording"
                          ? `${recordingProvider(item)} · ${
                              item.state === "cloud_confirmed"
                                ? "Saved to cloud"
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
                      <button
                        className="text-button"
                        disabled={locked}
                        onClick={() => {
                          if (item.kind === "draft") void restore(item);
                          else {
                            const selection = selectLocalRecording(
                              recording,
                              recordingDurable,
                              item,
                            );
                            if (!selection) {
                              setLocalError(
                                "Save or download the recording held in this tab, then explicitly remove that in-memory copy before opening another recording.",
                              );
                              return;
                            }
                            openTicket.current++;
                            setOpening(false);
                            setRecording(selection.recording);
                            setRecordingDurable(selection.durable);
                            setActive(null);
                            setPanel(null);
                            if (item.state === "cloud_confirmed")
                              void openNote(item.id);
                          }
                        }}
                      >
                        {item.kind === "draft"
                          ? liveDrafts.some(
                              (draft) => draft.draftId === item.draftId,
                            )
                            ? "Open draft"
                            : "Restore"
                          : "Open"}
                      </button>
                      <button
                        className="text-button"
                        aria-label="Download local content"
                        onClick={() =>
                          item.kind === "recording"
                            ? audioDownload(item)
                            : exportNote(item.input, item.updatedAt)
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
                ))}
              </section>
            ))}
          </div>
          <button
            className="secondary"
            disabled={localUnavailable}
            onClick={async () => {
              try {
                const granted = await navigator.storage?.persist?.();
                setToast(
                  granted
                    ? "Local copies are protected from automatic cleanup. Keep downloads as your backup."
                    : "This browser could not protect local copies. Download anything you want to keep.",
                );
              } catch {
                setToast(
                  "This browser cannot protect local copies from cleanup. Download a backup.",
                );
              }
            }}
          >
            Protect local copies
          </button>
          <p className="modal-footnote">
            Protection helps prevent automatic browser cleanup. Clearing browser
            data still removes local copies. Other tabs keep their own drafts;
            deleting a cloud note does not remove their audio.
          </p>
        </Modal>
      )}
    </div>
  );
}

function Editor({
  session,
  config,
  locked,
  notify,
  onDelete,
  onDuplicate,
}: {
  session: EditorSession;
  config: AppConfig | null;
  locked: boolean;
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
  const readOnly = locked || ["deleting", "deleted"].includes(draft.status);
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
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify("Copied. Ready for your next step.");
    } catch {
      setError(
        "The browser blocked copying. Select the text or download it instead.",
      );
    }
  }
  async function enhance() {
    if (enhancing) return;
    setEnhancing(true);
    setProposal(null);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    try {
      const proposal = await session.proposeRefinement(async (source) => {
        const result = await request("/enhance", enhancementResultSchema, {
          method: "POST",
          body: { text: source, preset },
          operation: "model",
          signal: abort.signal,
        });
        return result.text;
      });
      setProposal(proposal);
    } catch (e) {
      setError(message(e));
    } finally {
      setEnhancing(false);
      controller.current = null;
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
            const current = await request(`/notes/${draft.noteId}`, noteSchema);
            if (classifyCreateReplay(draft.input, current) !== "confirmed") {
              throw new ClientError(
                "The library has a different version. Review both before deleting.",
                409,
                "revision_conflict",
                current,
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
          await request(`/notes/${draft.noteId}`, z.undefined(), {
            method: "DELETE",
            body: { expectedRevision: revision },
          });
        setCloudDeleted(true);
        session.removed();
      }
      await session.secure();
      await removeLocal(draft.draftId);
      await removeLocal(draft.noteId);
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
      <div className="editor-metadata">
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
                  exportNote(
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
                disabled={locked || draft.status === "saving"}
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
                  exportNote(
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
          <span>Original transcript</span>
          <span className="original-hint">Always preserved</span>
          <ChevronDown size={16} />
        </summary>
        <pre>{draft.input.originalText}</pre>
        <button
          className="text-button"
          onClick={() => void copy(draft.input.originalText)}
        >
          Copy original
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
          {!proposal && (
            <p className="modal-intro">
              Mistral suggests a change. Compare it with your words before
              applying.
            </p>
          )}
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
              Set up Mistral in your local configuration to refine text.
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
                      !session.applyRefinement(proposal.text, proposal.source)
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
                <span className="modal-footnote">Text is sent to Mistral.</span>
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
              : "This removes the note from your shared library on every computer, plus this local recording and draft. Other local copies remain."}
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
  onSaved: (s: Settings) => void;
}) {
  const [text, setText] = useState(initial?.vocabulary.join("\n") ?? "");
  const [base, setBase] = useState(initial);
  const [conflict, setConflict] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!base || busy) return;
    const result = vocabularySchema.safeParse(
      text.split("\n").filter((s) => s.trim()),
    );
    if (!result.success) {
      setError(
        "Use up to 100 terms, each at most 80 characters. One per line, without commas or control characters.",
      );
      return;
    }
    const body = { vocabulary: result.data, expectedRevision: base.revision };
    setBusy(true);
    setError("");
    try {
      const saved = await request("/settings", settingsSchema, {
        method: "PUT",
        body,
      });
      setBase(saved);
      setText(saved.vocabulary.join("\n"));
      setConflict(null);
      onSaved(saved);
    } catch (e) {
      if (e instanceof ClientError && e.current && "vocabulary" in e.current) {
        if (classifySettingsConflict(body, e.current) === "confirmed") {
          setBase(e.current);
          setText(e.current.vocabulary.join("\n"));
          onSaved(e.current);
          setConflict(null);
        } else setConflict(e.current);
      } else setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Words that sound like you."
      close={() => {
        if (busy) return;
        if (
          text !== (base?.vocabulary.join("\n") ?? "") &&
          !window.confirm("Discard unsaved vocabulary changes?")
        )
          return;
        close();
      }}
    >
      <p className="modal-intro">
        Names, specialist terms, and your own spellings help the models
        understand you.
      </p>
      {!base && (
        <p className="notice">
          Vocabulary is not available yet. Close this panel and check the
          connection.
        </p>
      )}
      <label className="field-label" htmlFor="vocabulary">
        Your vocabulary <span>One term per line</span>
      </label>
      <textarea
        id="vocabulary"
        className="vocabulary"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"For example:\nProject name\nSpecialist term"}
        disabled={busy || !base}
      />
      <p className="field-hint">
        Up to 100 terms. When sent to Mistral, spaces within a term are
        converted to underscores.
      </p>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {conflict && (
        <div className="conflict-panel">
          <h3>Your vocabulary was changed elsewhere.</h3>
          <pre>{conflict.vocabulary.join("\n") || "Empty vocabulary"}</pre>
          <div className="button-row">
            <button
              className="secondary"
              onClick={() => {
                setBase(conflict);
                setConflict(null);
              }}
            >
              Keep my terms and unlock saving
            </button>
            <button
              className="text-button"
              onClick={() => {
                setText(conflict.vocabulary.join("\n"));
                setBase(conflict);
                setConflict(null);
              }}
            >
              Use the other version
            </button>
          </div>
        </div>
      )}
      <div className="modal-actions">
        <span className="modal-footnote">Shared across your computers.</span>
        <button
          className="primary"
          disabled={busy || !base || !!conflict}
          onClick={() => void save()}
        >
          {busy ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <Check size={16} />
          )}{" "}
          Save vocabulary
        </button>
      </div>
      <div className="provider-overview">
        <h3>Your models</h3>
        {config?.providers.map((p) => (
          <div key={p.id}>
            <span>
              {p.label}
              <small>{p.model}</small>
            </span>
            <span
              className={p.available ? "provider-ready" : "provider-missing"}
            >
              {p.available ? <Check size={14} /> : <CircleHelp size={14} />}
              {p.available ? "Connected" : "Not configured"}
            </span>
          </div>
        ))}
        <p className="field-hint">
          Select a provider in the recording bar. Credentials stay in your local
          project configuration.
        </p>
      </div>
    </Modal>
  );
}
