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
  | "deleting";
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
  remove: (id: string) => Promise<void>;
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
      this.alive &&
      this.state.status === "local" &&
      this.state.localIssue?.kind !== "persist"
    )
      this.timer = setTimeout(() => {
        void this.save();
      }, 700);
  }
  private cannotSave() {
    return this.discarded || this.state.status === "deleted";
  }
  private persist() {
    if (this.discarded) return Promise.resolve();
    const ticket = ++this.localWrite;
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
      .then(() => (this.discarded ? undefined : this.ports.persist(value)));
    this.queue = work;
    return work.then(
      () => {
        if (
          !this.discarded &&
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
          !this.discarded &&
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
  edit(patch: Partial<Pick<CreateNote, "title" | "body">>) {
    if (this.discarded || ["deleting", "deleted"].includes(this.state.status))
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
    try {
      await this.persist();
    } catch {
      return;
    }
    if (
      this.discarded ||
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
        if (this.discarded || this.state.status !== "saved") return;
        await this.ports.retire(source);
      }
    } catch {
      if (!this.discarded) {
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
    if (this.discarded) return;
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
    if (this.discarded || this.busy || this.localBusy) return;
    const version = this.version;
    this.localBusy = true;
    try {
      await this.finishLocal();
    } finally {
      this.localBusy = false;
      if (this.version !== version) this.schedule();
      try {
        this.ports.localChanged?.();
      } catch {
        /* View refresh does not change local persistence. */
      }
    }
  }
  async proposeRefinement(generate: (source: string) => Promise<string>) {
    const source = this.state.input.body;
    const text = await generate(source);
    return { source, text };
  }
  applyRefinement(text: string, source: string) {
    if (
      this.discarded ||
      ["deleting", "deleted"].includes(this.state.status) ||
      this.state.input.body !== source
    )
      return false;
    this.update({ refinement: { before: source, applied: text } });
    this.edit({ body: text });
    return true;
  }
  undoRefinement() {
    const previous = this.state.refinement;
    if (
      this.discarded ||
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
    this.discarded = true;
    this.alive = false;
    clearTimeout(this.timer);
    await this.queue.catch(() => {});
    try {
      await this.ports.remove(this.state.draftId);
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
      this.discarded ||
      this.localBusy ||
      this.busy ||
      ["saved", "conflict", "deleted", "deleting"].includes(this.state.status)
    )
      return;
    this.busy = true;
    const version = this.version,
      sent = { ...this.state.input },
      revision = this.state.baseRevision;
    try {
      try {
        await this.persist();
      } catch {
        return;
      }
      if (this.cannotSave()) return;
      this.update({ status: "saving", error: undefined });
      let note: Note;
      try {
        note = await this.ports.write(this.state.noteId, sent, revision);
      } catch (error) {
        if (
          error instanceof ClientError &&
          error.current &&
          "body" in error.current &&
          classifyEditConflict(
            {
              title: sent.title,
              body: sent.body,
              expectedRevision: revision ?? 1,
            },
            error.current,
          ) === "confirmed" &&
          revision !== null
        )
          note = error.current;
        else throw error;
      }
      if (this.cannotSave()) return;
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
      if (!this.discarded) {
        try {
          this.ports.changed();
        } catch {
          /* View refresh cannot undo a cloud confirmation. */
        }
      }
    } catch (error) {
      if (this.cannotSave()) return;
      if (
        error instanceof ClientError &&
        error.current &&
        "body" in error.current
      )
        this.update({
          status: "conflict",
          current: error.current,
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
    if (this.discarded || ["deleted", "deleting"].includes(this.state.status))
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
        input: { ...this.state.input, title: note.title, body: note.body },
        baseRevision: note.revision,
        current: note,
        durable: false,
        error: undefined,
      });
    } else if (
      note.title === this.state.input.title &&
      note.body === this.state.input.body
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
    if (this.discarded) return;
    clearTimeout(this.timer);
    this.update({
      status: "deleted",
      error: "This note was deleted. Your local version is still available.",
    });
    void this.persist().catch(() => {});
  }
  resolve(choice: "local" | "remote") {
    const current = this.state.current;
    if (this.discarded || !current || this.state.status !== "conflict") return;
    this.version++;
    this.update({
      input:
        choice === "remote"
          ? { ...this.state.input, title: current.title, body: current.body }
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
    if (this.busy)
      throw new ClientError(
        "A save is still in progress. Wait for it to finish before deleting.",
      );
    clearTimeout(this.timer);
    this.update({ status: "deleting" });
  }
  deleteFailed(error: unknown) {
    if (
      error instanceof ClientError &&
      error.current &&
      "body" in error.current
    )
      this.update({
        status: "conflict",
        current: error.current,
        error: error.message,
      });
    else this.update({ status: "error", error: message(error) });
    void this.persist().catch(() => {});
  }
  dispose() {
    this.alive = false;
    clearTimeout(this.timer);
    this.listeners.clear();
  }
}
