import {
  type CreateNote,
  type Note,
  createNoteSchema,
} from "../shared/contracts";
import {
  classifyCreateReplay,
  classifyEditConflict,
} from "../shared/responses";
import { ClientError, message } from "./api";
export type EditorStatus =
  | "saved"
  | "local"
  | "saving"
  | "local_error"
  | "error"
  | "conflict"
  | "deleted"
  | "deleting"
  | "archived";
export type Draft = {
  kind: "draft";
  draftId: string;
  editorInstanceId: string;
  noteId: string;
  input: CreateNote;
  baseRevision: number | null;
  updatedAt: string;
  status: EditorStatus;
  current?: Note;
  error?: string;
  durable: boolean;
  readOnly?: boolean;
  archiveToken?: string;
  localIssue?: { kind: "persist" | "cleanup" | "discard"; message: string };
  restoredFrom?: { draftId: string; updatedAt: string; input: CreateNote };
  recoveryAncestors?: {
    draftId: string;
    updatedAt: string;
    input: CreateNote;
  }[];
  refinement?: { before: string; applied: string };
};
export type EditorPorts = {
  persist: (draft: Draft) => Promise<void>;
  remove: (id: string, generation: number) => Promise<void>;
  retire?: (source: NonNullable<Draft["restoredFrom"]>) => Promise<void>;
  write: (
    id: string,
    input: CreateNote,
    revision: number | null,
  ) => Promise<Note>;
  changed: () => void;
  confirmed?: (note: Note) => void;
  localChanged?: () => void;
};
export class EditorSession {
  private state: Draft;
  private listeners = new Set<() => void>();
  private queue = Promise.resolve();
  private version = 0;
  private busy = false;
  private timer?: ReturnType<typeof setTimeout>;
  private alive = true;
  private discarded = false;
  private fenced = false;
  private paused = false;
  private epoch = 0;
  private archiveToken?: string;
  private localWrite = 0;
  private localBusy = false;
  private refreshAfter?: Note;
  constructor(
    draft: Draft,
    private ports: EditorPorts,
  ) {
    this.state =
      draft.status === "local_error"
        ? {
            ...draft,
            status: "local",
            error: undefined,
            localIssue: {
              kind: "persist",
              message: draft.error ?? "The local copy could not be saved.",
            },
          }
        : draft;
  }
  static fromNote(note: Note, ports: EditorPorts) {
    return new EditorSession(
      {
        kind: "draft",
        draftId: crypto.randomUUID(),
        editorInstanceId: crypto.randomUUID(),
        noteId: note.id,
        input: createNoteSchema.parse({
          generation: note.generation,
          areaId: note.areaId,
          title: note.title,
          body: note.body,
          originalText: note.originalText,
          provider: note.provider,
          model: note.model,
          mode: note.mode,
          durationMs: note.durationMs,
        }),
        baseRevision: note.revision,
        updatedAt: note.updatedAt,
        status: "saved",
        durable: false,
        current: note,
      },
      ports,
    );
  }
  static restore(draft: Draft, ports: EditorPorts) {
    return new EditorSession(
      {
        ...draft,
        draftId: crypto.randomUUID(),
        editorInstanceId: crypto.randomUUID(),
        status:
          draft.status === "saved" && draft.localIssue
            ? "saved"
            : draft.status === "deleted"
              ? "deleted"
              : draft.status === "conflict"
                ? "conflict"
                : "local",
        durable: false,
        restoredFrom: {
          draftId: draft.draftId,
          updatedAt: draft.updatedAt,
          input: { ...draft.input },
        },
        recoveryAncestors: [
          ...(draft.recoveryAncestors ?? []),
          ...(draft.restoredFrom ? [draft.restoredFrom] : []),
        ],
      },
      ports,
    );
  }
  private inactive() {
    return (
      this.discarded || this.fenced || this.paused || !!this.state.readOnly
    );
  }
  pause() {
    this.epoch++;
    this.localWrite++;
    this.paused = true;
    this.busy = false;
    this.localBusy = false;
    this.refreshAfter = undefined;
    clearTimeout(this.timer);
    if (this.state.status === "saving")
      this.update({
        status: "error",
        error:
          "Saving was interrupted. Check the current library before retrying.",
      });
  }
  resume() {
    if (!this.fenced && !this.discarded) this.paused = false;
  }
  fence(): Draft {
    this.pause();
    this.fenced = true;
    this.archiveToken ??= crypto.randomUUID();
    this.update({
      readOnly: true,
      status: "archived",
      archiveToken: this.archiveToken,
    });
    return {
      ...this.state,
      input: { ...this.state.input },
      draftId: this.archiveToken,
      archiveToken: this.archiveToken,
      readOnly: true,
      status: "archived",
    };
  }
  historicallySecured(token: string) {
    if (this.archiveToken === token)
      this.update({ durable: true, localIssue: undefined });
  }
  get saving() {
    return this.busy || this.localBusy;
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<Draft>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((f) => f());
  }
  private schedule() {
    clearTimeout(this.timer);
    if (
      !this.inactive() &&
      this.alive &&
      this.state.status === "local" &&
      this.state.localIssue?.kind !== "persist"
    )
      this.timer = setTimeout(() => {
        void this.save();
      }, 700);
  }
  private cannotSave() {
    return this.inactive() || this.state.status === "deleted";
  }
  private persist() {
    if (this.inactive()) return Promise.resolve();
    const ticket = ++this.localWrite;
    const epoch = this.epoch;
    this.update({ durable: false });
    const value = {
      ...this.state,
      input: { ...this.state.input },
      durable: true,
      localIssue:
        this.state.localIssue?.kind === "persist"
          ? undefined
          : this.state.localIssue,
    };
    const version = this.version;
    const work = this.queue
      .catch(() => {})
      .then(() =>
        this.inactive() || epoch !== this.epoch
          ? undefined
          : this.ports.persist(value),
      );
    this.queue = work;
    return work.then(
      () => {
        if (
          !this.inactive() &&
          ticket === this.localWrite &&
          version === this.version
        )
          this.update({
            durable: true,
            localIssue:
              this.state.localIssue?.kind === "persist"
                ? undefined
                : this.state.localIssue,
          });
      },
      (e) => {
        if (
          !this.inactive() &&
          ticket === this.localWrite &&
          version === this.version
        )
          this.update({
            durable: false,
            localIssue: {
              kind: "persist",
              message:
                "The local copy could not be saved. Your text is still available in this session.",
            },
          });
        throw e;
      },
    );
  }
  edit(patch: Partial<Pick<CreateNote, "title" | "body" | "areaId">>) {
    if (this.inactive() || ["deleting", "deleted"].includes(this.state.status))
      return;
    this.version++;
    this.update({
      input: { ...this.state.input, ...patch },
      updatedAt: new Date().toISOString(),
      durable: false,
      status: this.state.status === "conflict" ? "conflict" : "local",
      error: undefined,
    });
    void this.persist()
      .then(() => this.schedule())
      .catch(() => {});
  }
  async secure() {
    await this.persist();
  }
  private async finishLocal() {
    const epoch = this.epoch;
    try {
      await this.persist();
    } catch {
      return;
    }
    if (
      this.inactive() ||
      epoch !== this.epoch ||
      this.state.status !== "saved" ||
      !this.state.restoredFrom ||
      !this.ports.retire
    )
      return;
    const sources = [
      this.state.restoredFrom,
      ...(this.state.recoveryAncestors ?? []),
    ];
    try {
      for (const source of sources) {
        if (
          this.inactive() ||
          epoch !== this.epoch ||
          this.state.status !== "saved"
        )
          return;
        await this.ports.retire(source);
      }
    } catch {
      if (!(this.inactive() || epoch !== this.epoch)) {
        this.update({
          localIssue: {
            kind: "cleanup",
            message: "Older recovery copies could not be removed.",
          },
        });
        await this.persist().catch(() => {});
      }
      return;
    }
    if (this.inactive() || epoch !== this.epoch) return;
    this.update({
      restoredFrom: undefined,
      recoveryAncestors: undefined,
      localIssue:
        this.state.localIssue?.kind === "cleanup"
          ? undefined
          : this.state.localIssue,
    });
    await this.persist().catch(() => {});
  }
  async retryLocal() {
    if (this.inactive() || this.busy || this.localBusy) return;
    const version = this.version,
      epoch = this.epoch;
    this.localBusy = true;
    try {
      await this.finishLocal();
    } finally {
      if (epoch === this.epoch) {
        this.localBusy = false;
        if (this.version !== version) this.schedule();
        try {
          this.ports.localChanged?.();
        } catch {
          /* View refresh does not change local persistence. */
        }
      }
    }
  }
  async proposeRefinement(generate: (source: string) => Promise<string>) {
    if (this.inactive()) throw new ClientError("This version is read-only.");
    const source = this.state.input.body,
      epoch = this.epoch;
    const text = await generate(source);
    if (this.inactive() || epoch !== this.epoch)
      throw new ClientError("This suggestion belongs to an earlier library.");
    return { source, text, epoch };
  }
  applyRefinement(text: string, source: string, epoch: number) {
    if (
      this.inactive() ||
      ["deleting", "deleted"].includes(this.state.status) ||
      this.state.input.body !== source ||
      epoch !== this.epoch
    )
      return false;
    this.update({ refinement: { before: source, applied: text } });
    this.edit({ body: text });
    return true;
  }
  undoRefinement() {
    const previous = this.state.refinement;
    if (
      this.inactive() ||
      ["deleting", "deleted"].includes(this.state.status) ||
      !previous ||
      this.state.input.body !== previous.applied
    )
      return false;
    this.update({ refinement: undefined });
    this.edit({ body: previous.before });
    return true;
  }
  async discard() {
    const epoch = this.epoch;
    this.discarded = true;
    this.alive = false;
    clearTimeout(this.timer);
    await this.queue.catch(() => {});
    if (epoch !== this.epoch) return;
    try {
      await this.ports.remove(this.state.draftId, this.state.input.generation);
      this.listeners.clear();
    } catch (error) {
      this.discarded = false;
      this.alive = true;
      this.update({
        localIssue: {
          kind: "discard",
          message: "Local deletion failed. Your draft is still available.",
        },
      });
      throw error;
    }
  }
  async save() {
    clearTimeout(this.timer);
    if (
      this.inactive() ||
      this.localBusy ||
      this.busy ||
      ["saved", "conflict", "deleted", "deleting"].includes(this.state.status)
    )
      return;
    this.busy = true;
    const epoch = this.epoch;
    const version = this.version,
      sent = { ...this.state.input },
      revision = this.state.baseRevision;
    try {
      try {
        await this.persist();
      } catch {
        return;
      }
      if (this.cannotSave() || epoch !== this.epoch) return;
      this.update({ status: "saving", error: undefined });
      let note: Note;
      try {
        note = await this.ports.write(this.state.noteId, sent, revision);
      } catch (error) {
        if (
          error instanceof ClientError &&
          error.conflict?.kind === "note" &&
          classifyEditConflict(
            {
              generation: sent.generation,
              areaId: sent.areaId,
              title: sent.title,
              body: sent.body,
              expectedRevision: revision ?? 1,
            },
            error.conflict.current,
          ) === "confirmed" &&
          revision !== null
        )
          note = error.conflict.current;
        else throw error;
      }
      if (this.cannotSave() || epoch !== this.epoch) return;
      try {
        this.ports.confirmed?.(note);
      } catch {
        // Recording bookkeeping cannot reverse a cloud confirmation.
      }
      if (
        revision === null &&
        classifyCreateReplay(sent, note) !== "confirmed"
      ) {
        this.update({
          status: "conflict",
          current: note,
          error:
            "This note already has another version. Both versions are preserved.",
        });
        await this.persist();
        return;
      }
      this.update({
        baseRevision: note.revision,
        current: note,
        status: version === this.version ? "saved" : "local",
      });
      // Local bookkeeping cannot reverse an already confirmed cloud write.
      await this.finishLocal();
      if (!this.inactive()) {
        try {
          this.ports.changed();
        } catch {
          /* View refresh cannot undo a cloud confirmation. */
        }
      }
    } catch (error) {
      if (this.cannotSave() || epoch !== this.epoch) return;
      if (error instanceof ClientError && error.code === "library_reset") {
        this.fence();
        return;
      }
      if (error instanceof ClientError && error.conflict?.kind === "note")
        this.update({
          status: "conflict",
          current: error.conflict.current,
          error: error.message,
        });
      else if (
        error instanceof ClientError &&
        ["note_deleted", "note_not_found", "id_conflict"].includes(
          error.code ?? "",
        )
      )
        this.update({ status: "deleted", error: error.message });
      else this.update({ status: "error", error: message(error) });
      await this.persist().catch(() => {});
    } finally {
      if (epoch !== this.epoch) return;
      this.busy = false;
      if (this.refreshAfter) {
        const n = this.refreshAfter;
        this.refreshAfter = undefined;
        this.revalidate(n);
      }
      this.schedule();
    }
  }
  revalidate(note: Note) {
    if (note.id !== this.state.noteId) return;
    if (note.generation !== this.state.input.generation) {
      this.fence();
      return;
    }
    if (this.inactive() || ["deleted", "deleting"].includes(this.state.status))
      return;
    if (this.busy) {
      this.refreshAfter = note;
      return;
    }
    try {
      this.ports.confirmed?.(note);
    } catch {
      // A local recording acknowledgement is independent of the cloud note.
    }
    if (note.revision <= (this.state.baseRevision ?? 0)) return;
    if (this.state.status === "saved") {
      this.update({
        input: {
          ...this.state.input,
          title: note.title,
          body: note.body,
          areaId: note.areaId,
        },
        baseRevision: note.revision,
        current: note,
        durable: false,
        error: undefined,
      });
    } else if (
      note.title === this.state.input.title &&
      note.body === this.state.input.body &&
      note.areaId === this.state.input.areaId
    )
      this.update({
        baseRevision: note.revision,
        current: note,
        status: "saved",
        durable: false,
        error: undefined,
      });
    else
      this.update({
        current: note,
        status: "conflict",
        error: "This note was changed elsewhere.",
      });
    void this.persist().catch(() => {});
  }
  removed() {
    if (this.inactive()) return;
    clearTimeout(this.timer);
    this.update({
      status: "deleted",
      error: "This note was deleted. Your local version is still available.",
    });
    void this.persist().catch(() => {});
  }
  resolve(choice: "local" | "remote") {
    const current = this.state.current;
    if (this.inactive() || !current || this.state.status !== "conflict") return;
    this.version++;
    this.update({
      input:
        choice === "remote"
          ? {
              ...this.state.input,
              title: current.title,
              body: current.body,
              areaId: current.areaId,
            }
          : this.state.input,
      baseRevision: current.revision,
      status: "local",
      error: undefined,
      durable: false,
    });
    void this.persist()
      .then(() => this.schedule())
      .catch(() => {});
  }
  async prepareDelete() {
    if (this.inactive()) throw new ClientError("This version is read-only.");
    if (this.busy)
      throw new ClientError(
        "A save is still in progress. Wait for it to finish before deleting.",
      );
    clearTimeout(this.timer);
    this.update({ status: "deleting" });
  }
  deleteFailed(error: unknown) {
    if (error instanceof ClientError && error.conflict?.kind === "note")
      this.update({
        status: "conflict",
        current: error.conflict.current,
        error: error.message,
      });
    else this.update({ status: "error", error: message(error) });
    void this.persist().catch(() => {});
  }
  dispose() {
    this.pause();
    this.fenced = true;
    this.alive = false;
    clearTimeout(this.timer);
    this.listeners.clear();
  }
}
