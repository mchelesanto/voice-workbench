import { describe, expect, it, vi } from "vitest";
import {
  AUTOSAVE_DELAY_MS,
  EditorSession,
  type EditorPorts,
} from "../src/client/editor";
import type { Note } from "../src/shared/contracts";
import { ClientError } from "../src/client/api";
const note: Note = {
  generation: 1,
  areaId: null,
  id: "11111111-1111-4111-8111-111111111111",
  title: "Gedanke",
  body: "Original",
  originalText: "Original",
  provider: "google",
  model: "gemini-3.5-transcribe",
  mode: "verbatim",
  durationMs: 1000,
  revision: 1,
  createdAt: "2026-09-15T10:00:00.000Z",
  updatedAt: "2026-09-15T10:00:00.000Z",
};
function setup() {
  const ports: EditorPorts = {
    persist: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    write: vi.fn(async (_id, input) => ({ ...note, ...input, revision: 2 })),
    changed: vi.fn(),
  };
  const session = EditorSession.fromNote(note, ports);
  return { session, ports };
}
describe("Editor reliability", () => {
  it("persists locally first and preserves edits during a pending cloud request", async () => {
    const { session, ports } = setup();
    let complete!: (n: Note) => void;
    ports.write = vi.fn(
      () =>
        new Promise<Note>((r) => {
          complete = r;
        }),
    );
    session.edit({ body: "Fassung A" });
    const save = session.save();
    await vi.waitFor(() => expect(ports.write).toHaveBeenCalledTimes(1));
    expect(ports.persist).toHaveBeenCalled();
    session.edit({ body: "Fassung B" });
    complete({ ...note, body: "Fassung A", revision: 2 });
    await save;
    expect(session.snapshot().input.body).toBe("Fassung B");
    expect(session.snapshot().baseRevision).toBe(2);
    expect(session.snapshot().status).toBe("local");
    expect(ports.remove).not.toHaveBeenCalled();
    session.dispose();
  });
  it("does not write to the cloud when local persistence fails", async () => {
    const { session, ports } = setup();
    ports.persist = vi.fn(async () => {
      throw new Error("quota");
    });
    session.edit({ body: "Wertvoll" });
    await session.save();
    expect(ports.write).not.toHaveBeenCalled();
    expect(session.snapshot().status).toBe("local");
    expect(session.snapshot().localIssue?.kind).toBe("persist");
    expect(session.snapshot().input.body).toBe("Wertvoll");
    session.dispose();
  });
  it("preserves the local version across repeated conflicts", async () => {
    const { session, ports } = setup();
    ports.write = vi.fn(async () => {
      throw new ClientError("Konflikt", 409, "revision_conflict", {
        kind: "note",
        current: {
          ...note,
          body: "Remote",
          revision: 4,
        },
      });
    });
    session.edit({ body: "Lokal" });
    await session.save();
    expect(session.snapshot().status).toBe("conflict");
    session.resolve("local");
    await session.save();
    expect(session.snapshot().input.body).toBe("Lokal");
    expect(session.snapshot().current?.body).toBe("Remote");
    session.dispose();
  });
  it("never recreates deleted notes through autosave", async () => {
    const { session, ports } = setup();
    ports.write = vi.fn(async () => {
      throw new ClientError("Entfernt", 410, "note_deleted");
    });
    session.edit({ body: "Lokal" });
    await session.save();
    await session.save();
    expect(ports.write).toHaveBeenCalledTimes(1);
    expect(session.snapshot().status).toBe("deleted");
    session.dispose();
  });
  it("isolates instances of one note and recognizes lost save responses", async () => {
    const { session, ports } = setup();
    const other = EditorSession.fromNote(note, ports);
    expect(session.snapshot().draftId).not.toBe(other.snapshot().draftId);
    ports.write = vi.fn(async () => {
      throw new ClientError("Konflikt", 409, "revision_conflict", {
        kind: "note",
        current: {
          ...note,
          body: "Neu",
          revision: 2,
        },
      });
    });
    session.edit({ body: "Neu" });
    await session.save();
    expect(session.snapshot().status).toBe("saved");
    expect(other.snapshot().input.body).toBe("Original");
    session.dispose();
    other.dispose();
  });
});

it.each(["deleted", "deleting", "conflict"] as const)(
  "preserves %s when local persistence fails",
  async (status) => {
    const { session: initial, ports } = setup();
    ports.persist = vi.fn(async () => {
      throw new Error("quota");
    });
    const session = new EditorSession(
      {
        ...initial.snapshot(),
        status,
        current: { ...note, body: "Remote", revision: 2 },
      },
      ports,
    );
    await expect(session.secure()).rejects.toThrow();
    expect(session.snapshot()).toMatchObject({
      status,
      durable: false,
      localIssue: { kind: "persist" },
    });
    await session.save();
    expect(ports.write).not.toHaveBeenCalled();
    session.edit({ body: "Edited" });
    expect(session.snapshot().status).toBe(status);
    if (status !== "conflict")
      expect(session.snapshot().input.body).toBe("Original");
    session.dispose();
    initial.dispose();
  },
);

it("preserves cloud confirmation when the local confirmation write fails", async () => {
  const { session: initial, ports } = setup();
  const session = EditorSession.restore(
    { ...initial.snapshot(), status: "error" },
    ports,
  );
  let count = 0;
  ports.persist = vi.fn(async () => {
    if (++count > 1) throw new Error("quota");
  });
  await session.save();
  expect(session.snapshot()).toMatchObject({
    status: "saved",
    baseRevision: 2,
    durable: false,
    localIssue: { kind: "persist" },
  });
  expect(ports.changed).toHaveBeenCalledTimes(1);
  ports.persist = vi.fn(async () => {});
  await session.retryLocal();
  expect(session.snapshot()).toMatchObject({ status: "saved", durable: true });
  expect(session.snapshot().localIssue).toBeUndefined();
  expect(ports.write).toHaveBeenCalledTimes(1);
  session.dispose();
  initial.dispose();
});

it("retries recovery cleanup locally without another cloud write", async () => {
  const { session: initial, ports } = setup();
  const session = EditorSession.restore(
    { ...initial.snapshot(), status: "error" },
    ports,
  );
  ports.retire = vi
    .fn()
    .mockRejectedValueOnce(new Error("cleanup"))
    .mockResolvedValue(undefined);
  await session.save();
  expect(session.snapshot()).toMatchObject({
    status: "saved",
    baseRevision: 2,
    localIssue: { kind: "cleanup" },
  });
  await session.retryLocal();
  expect(ports.retire).toHaveBeenCalledTimes(2);
  expect(ports.write).toHaveBeenCalledTimes(1);
  expect(session.snapshot().localIssue).toBeUndefined();
  session.dispose();
  initial.dispose();
});

it("does not claim an older local write secured a newer revalidated version", async () => {
  const { session, ports } = setup();
  const pending: Array<() => void> = [];
  ports.persist = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
      }),
  );
  const old = session.secure();
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  session.revalidate({ ...note, body: "New remote version", revision: 2 });
  pending[0]();
  await old;
  expect(session.snapshot().durable).toBe(false);
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending[1]();
  await vi.waitFor(() => expect(session.snapshot().durable).toBe(true));
  session.dispose();
});

it("keeps newer edits and a cloud failure separate from local retry", async () => {
  const { session, ports } = setup();
  ports.write = vi.fn(async () => {
    throw new ClientError("Cloud unavailable");
  });
  session.edit({ body: "Pending cloud version" });
  await session.save();
  await session.retryLocal();
  expect(session.snapshot()).toMatchObject({
    status: "error",
    input: { body: "Pending cloud version" },
    error: "Cloud unavailable",
  });
  expect(ports.write).toHaveBeenCalledTimes(1);
  session.dispose();
});

it("does not attach an obsolete local failure to a newer queued snapshot", async () => {
  const { session, ports } = setup();
  const pending: Array<{ resolve: () => void; reject: (e: Error) => void }> =
    [];
  ports.persist = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => pending.push({ resolve, reject })),
  );
  const old = session.secure().catch(() => {});
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  session.revalidate({ ...note, body: "New remote content", revision: 2 });
  pending[0].reject(new Error("Old write failed"));
  await old;
  expect(session.snapshot().localIssue).toBeUndefined();
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending[1].resolve();
  await vi.waitFor(() => expect(session.snapshot().durable).toBe(true));
  session.dispose();
});

it("restores cloud-confirmed drafts with local warnings without another cloud write", async () => {
  const { session: initial, ports } = setup();
  const restored = EditorSession.restore(
    {
      ...initial.snapshot(),
      localIssue: { kind: "persist", message: "Local write failed" },
    },
    ports,
  );
  expect(restored.snapshot().status).toBe("saved");
  await restored.retryLocal();
  await restored.save();
  expect(ports.write).not.toHaveBeenCalled();
  expect(restored.snapshot().durable).toBe(true);
  restored.dispose();
  initial.dispose();
});

it("normalizes a legacy local_error draft without discarding its text", () => {
  const { session: initial, ports } = setup();
  const session = new EditorSession(
    {
      ...initial.snapshot(),
      status: "local_error",
      error: "Old local failure",
      durable: false,
    },
    ports,
  );
  expect(session.snapshot()).toMatchObject({
    status: "local",
    localIssue: { kind: "persist" },
    input: { body: "Original" },
  });
  expect(session.snapshot().error).toBeUndefined();
  session.dispose();
  initial.dispose();
});

it("does not turn a failed view refresh into a failed cloud save", async () => {
  const { session, ports } = setup();
  ports.changed = vi.fn(() => {
    throw new Error("View refresh failed");
  });
  session.edit({ body: "Cloud confirmed" });
  await session.save();
  expect(session.snapshot()).toMatchObject({
    status: "saved",
    input: { body: "Cloud confirmed" },
  });
  expect(ports.write).toHaveBeenCalledTimes(1);
  session.dispose();
});

it("notifies recording recovery after a later successful save despite edits while saving", async () => {
  const { session, ports } = setup();
  ports.confirmed = vi.fn();
  ports.write = vi.fn().mockRejectedValueOnce(new ClientError("Offline"));
  session.edit({ body: "First version" });
  await session.save();
  expect(ports.confirmed).not.toHaveBeenCalled();
  let finish!: (note: Note) => void;
  ports.write = vi.fn(
    () =>
      new Promise<Note>((resolve) => {
        finish = resolve;
      }),
  );
  const saving = session.save();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  session.edit({ body: "Still newer work" });
  finish({ ...note, body: "First version", revision: 2 });
  await saving;
  expect(ports.confirmed).toHaveBeenCalledWith(
    expect.objectContaining({ body: "First version", revision: 2 }),
  );
  expect(session.snapshot().input.body).toBe("Still newer work");
  expect(session.snapshot().status).toBe("local");
  session.dispose();
});

it("notifies recording recovery when a lost save response is confirmed by conflict replay", async () => {
  const { session, ports } = setup();
  ports.confirmed = vi.fn();
  ports.write = vi.fn(async () => {
    throw new ClientError("Conflict", 409, "revision_conflict", {
      kind: "note",
      current: {
        ...note,
        body: "Saved words",
        revision: 2,
      },
    });
  });
  session.edit({ body: "Saved words" });
  await session.save();
  expect(ports.confirmed).toHaveBeenCalledWith(
    expect.objectContaining({ body: "Saved words", revision: 2 }),
  );
  session.dispose();
});

it("resumes autosave for edits made during a slow local-only cleanup", async () => {
  vi.useFakeTimers();
  const { session: initial, ports } = setup();
  const session = new EditorSession(
    {
      ...initial.snapshot(),
      restoredFrom: {
        draftId: initial.snapshot().draftId,
        updatedAt: note.updatedAt,
        input: initial.snapshot().input,
      },
      localIssue: { kind: "cleanup", message: "Cleanup pending" },
    },
    ports,
  );
  let release!: () => void;
  ports.retire = vi.fn(
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  try {
    const local = session.retryLocal();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    session.edit({ body: "New work during cleanup" });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 100);
    expect(ports.write).not.toHaveBeenCalled();
    release();
    await local;
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 100);
    expect(ports.write).toHaveBeenCalledTimes(1);
    expect(session.snapshot()).toMatchObject({
      status: "saved",
      input: { body: "New work during cleanup" },
    });
  } finally {
    session.dispose();
    initial.dispose();
    vi.useRealTimers();
  }
});

it("does not replace local text with a revalidation arriving during a save", async () => {
  const { session, ports } = setup();
  let complete!: (n: Note) => void;
  ports.write = vi.fn(
    () =>
      new Promise<Note>((r) => {
        complete = r;
      }),
  );
  session.edit({ body: "Local" });
  const saving = session.save();
  await vi.waitFor(() => expect(ports.write).toHaveBeenCalled());
  session.edit({ body: "New local" });
  session.revalidate({ ...note, body: "Other computer", revision: 4 });
  complete({ ...note, body: "Local", revision: 2 });
  await saving;
  expect(session.snapshot()).toMatchObject({
    input: { body: "New local" },
    current: { body: "Other computer" },
    status: "conflict",
  });
  session.dispose();
});
it("keeps a newer create-replay response as a conflict", async () => {
  const { session: original, ports } = setup();
  const session = new EditorSession(
    { ...original.snapshot(), baseRevision: null, status: "local" },
    ports,
  );
  ports.write = vi.fn(async () => ({
    ...note,
    body: "Edited elsewhere",
    revision: 4,
  }));
  await session.save();
  expect(session.snapshot()).toMatchObject({
    input: { body: "Original" },
    current: { body: "Edited elsewhere" },
    status: "conflict",
  });
  session.dispose();
  original.dispose();
});

it("does not resurrect a discarded draft when a pending cloud save completes", async () => {
  const { session, ports } = setup();
  let complete!: (n: Note) => void;
  const stored = new Map<string, unknown>();
  ports.persist = vi.fn(async (d) => {
    stored.set(d.draftId, d);
  });
  ports.remove = vi.fn(async (id) => {
    stored.delete(id);
  });
  ports.write = vi.fn(
    () =>
      new Promise<Note>((r) => {
        complete = r;
      }),
  );
  session.edit({ body: "Discard this draft" });
  const saving = session.save();
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  await session.discard();
  complete({ ...note, body: "Discard this draft", revision: 2 });
  await saving;
  session.edit({ body: "Late input" });
  await session.secure();
  expect(stored.size).toBe(0);
  expect(ports.write).toHaveBeenCalledTimes(1);
  expect(ports.changed).not.toHaveBeenCalled();
  expect(session.snapshot().baseRevision).toBe(1);
});

it("waits for an already started local write before deleting its draft", async () => {
  const { session, ports } = setup();
  let release!: () => void;
  ports.persist = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  session.edit({ body: "Pending local write" });
  const securing = session.secure();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const discarded = session.discard();
  await Promise.resolve();
  await Promise.resolve();
  expect(ports.remove).not.toHaveBeenCalled();
  release();
  await securing;
  await discarded;
  expect(ports.remove).toHaveBeenCalledTimes(1);
});

it("does not retire a restored source while a newer edit still needs saving", async () => {
  const { session: original, ports } = setup();
  const session = EditorSession.restore(
    { ...original.snapshot(), status: "error" },
    ports,
  );
  ports.retire = vi.fn(async () => {});
  let complete!: (note: Note) => void;
  ports.write = vi.fn(
    () =>
      new Promise<Note>((resolve) => {
        complete = resolve;
      }),
  );
  const saving = session.save();
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  session.edit({ body: "New local edit" });
  complete({ ...note, revision: 2 });
  await saving;
  expect(session.snapshot().status).toBe("local");
  expect(ports.retire).not.toHaveBeenCalled();
  session.dispose();
  original.dispose();
});

it("keeps a known remote deletion when an older save response arrives late", async () => {
  const { session, ports } = setup();
  let complete!: (note: Note) => void;
  ports.write = vi.fn(
    () =>
      new Promise<Note>((resolve) => {
        complete = resolve;
      }),
  );
  session.edit({ body: "Local version" });
  const saving = session.save();
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  session.removed();
  complete({ ...note, body: "Local version", revision: 2 });
  await saving;
  expect(session.snapshot().status).toBe("deleted");
  await session.save();
  expect(ports.write).toHaveBeenCalledTimes(1);
  session.dispose();
});

it("binds an asynchronous refinement to its original source", async () => {
  const { session } = setup();
  let complete!: (text: string) => void;
  session.edit({ body: "Original working version" });
  const generate = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        complete = resolve;
      }),
  );
  const pending = session.proposeRefinement(generate);
  session.edit({ body: "Changed while waiting" });
  complete("Generated text");
  const proposal = await pending;
  expect(generate).toHaveBeenCalledWith("Original working version");
  expect(proposal.source).toBe("Original working version");
  expect(session.applyRefinement(proposal.text, proposal.source, 0)).toBe(
    false,
  );
  session.dispose();
});

it("retires a recovery source only after the restored version is confirmed", async () => {
  const { session: original, ports } = setup();
  const source = { ...original.snapshot(), status: "error" as const };
  ports.retire = vi.fn(async () => {});
  ports.write = vi.fn(async () => {
    throw new ClientError("Offline");
  });
  const restored = EditorSession.restore(source, ports);
  await restored.save();
  expect(ports.retire).not.toHaveBeenCalled();
  ports.write = vi.fn(async (_id, input) => ({
    ...note,
    ...input,
    revision: 2,
  }));
  await restored.save();
  expect(ports.retire).toHaveBeenCalledWith(
    expect.objectContaining({ draftId: source.draftId, input: source.input }),
  );
  restored.dispose();
  original.dispose();
});

it("can undo a refinement to the edited source and rejects stale replacement", () => {
  const { session } = setup();
  session.edit({ body: "My carefully edited version" });
  expect(session.applyRefinement("Proposal", "Old source", 0)).toBe(false);
  expect(
    session.applyRefinement("Proposal", "My carefully edited version", 0),
  ).toBe(true);
  expect(session.snapshot().input.originalText).toBe("Original");
  expect(session.undoRefinement()).toBe(true);
  expect(session.snapshot().input.body).toBe("My carefully edited version");
  session.applyRefinement("Another proposal", "My carefully edited version", 0);
  session.edit({ body: "Newer manual work" });
  expect(session.undoRefinement()).toBe(false);
  expect(session.snapshot().input.body).toBe("Newer manual work");
  expect(session.snapshot().refinement?.before).toBe(
    "My carefully edited version",
  );
  session.dispose();
});

it("retires the full unchanged recovery lineage after a second restore", async () => {
  const { session: original, ports } = setup();
  const source = { ...original.snapshot(), status: "error" as const };
  ports.retire = vi.fn(async () => {});
  const first = EditorSession.restore(source, ports);
  const second = EditorSession.restore(first.snapshot(), ports);
  await second.save();
  expect(ports.retire).toHaveBeenCalledWith(
    expect.objectContaining({ draftId: source.draftId }),
  );
  expect(ports.retire).toHaveBeenCalledWith(
    expect.objectContaining({ draftId: first.snapshot().draftId }),
  );
  second.dispose();
  first.dispose();
  original.dispose();
});

it("fences queued local and late cloud writes while preserving the latest visible text", async () => {
  const { session, ports } = setup();
  let complete!: (note: Note) => void;
  ports.write = vi.fn(
    () =>
      new Promise<Note>((resolve) => {
        complete = resolve;
      }),
  );
  session.edit({ body: "Before request" });
  const pending = session.save();
  await vi.waitFor(() => expect(ports.write).toHaveBeenCalled());
  session.edit({ body: "Newest visible text" });
  const frozen = session.fence();
  expect(frozen).toMatchObject({
    status: "archived",
    readOnly: true,
    input: { body: "Newest visible text", generation: 1 },
  });
  expect(frozen.archiveToken).toBeTruthy();
  const writes = vi.mocked(ports.persist).mock.calls.length;
  complete({ ...note, body: "Before request", revision: 2 });
  await pending;
  session.edit({ body: "Must not replace" });
  await session.save();
  await session.secure();
  expect(session.snapshot().input.body).toBe("Newest visible text");
  expect(ports.changed).not.toHaveBeenCalled();
  expect(vi.mocked(ports.persist).mock.calls.length).toBe(writes);
  expect(session.fence().archiveToken).toBe(frozen.archiveToken);
  session.dispose();
});

it("does not let a paused old save complete into a resumed editor", async () => {
  const { session, ports } = setup();
  let old!: (note: Note) => void;
  ports.write = vi.fn(
    () =>
      new Promise<Note>((resolve) => {
        old = resolve;
      }),
  );
  session.edit({ body: "Before pause" });
  const pending = session.save();
  await vi.waitFor(() => expect(old).toBeTypeOf("function"));
  session.pause();
  session.resume();
  session.edit({ body: "After resume" });
  old({ ...note, body: "Before pause", revision: 2 });
  await pending;
  expect(session.snapshot().input.body).toBe("After resume");
  expect(session.snapshot().baseRevision).toBe(1);
  expect(ports.confirmed).toBeUndefined();
  session.dispose();
});

it("rejects a refinement from a previous terminal epoch even with equal source text", async () => {
  const { session } = setup();
  const proposal = await session.proposeRefinement(async () => "Proposal");
  session.pause();
  session.resume();
  expect(
    session.applyRefinement(proposal.text, proposal.source, proposal.epoch),
  ).toBe(false);
  let resolve!: (value: string) => void;
  const old = session.proposeRefinement(
    () =>
      new Promise<string>((r) => {
        resolve = r;
      }),
  );
  session.fence();
  resolve("Late proposal");
  await expect(old).rejects.toThrow("earlier library");
  session.dispose();
});

it("coalesces typing locally and syncs only after three seconds without edits", async () => {
  vi.useFakeTimers();
  const { session, ports } = setup();
  try {
    for (const body of ["A", "AB", "ABC"]) {
      session.edit({ body });
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(ports.persist).not.toHaveBeenCalled();
    expect(ports.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(ports.persist).toHaveBeenCalledTimes(1);
    expect(session.snapshot()).toMatchObject({
      durable: true,
      input: { body: "ABC" },
    });
    await vi.advanceTimersByTimeAsync(2000);
    session.edit({ title: "New title" });
    await vi.advanceTimersByTimeAsync(2999);
    expect(ports.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ports.write).toHaveBeenCalledTimes(1);
    expect(ports.write).toHaveBeenCalledWith(
      note.id,
      expect.objectContaining({ body: "ABC", title: "New title" }),
      1,
    );
  } finally {
    session.dispose();
    vi.useRealTimers();
  }
});
it("keeps local recovery current during continuous typing without cloud writes", async () => {
  vi.useFakeTimers();
  const { session, ports } = setup();
  try {
    for (let i = 0; i < 100; i++) {
      session.edit({ body: `Long typing burst ${i}` });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(ports.write).not.toHaveBeenCalled();
    expect(vi.mocked(ports.persist).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(ports.persist).mock.calls.length).toBeLessThan(50);
    await vi.advanceTimersByTimeAsync(300);
    expect(session.snapshot()).toMatchObject({
      durable: true,
      input: { body: "Long typing burst 99" },
    });
  } finally {
    session.dispose();
    vi.useRealTimers();
  }
});
it.each(["discard", "fence"] as const)(
  "cancels delayed local and cloud writes on %s",
  async (action) => {
    vi.useFakeTimers();
    const { session, ports } = setup();
    try {
      session.edit({ body: "Never publish after cancellation" });
      await session[action]();
      await vi.advanceTimersByTimeAsync(5000);
      expect(ports.persist).not.toHaveBeenCalled();
      expect(ports.write).not.toHaveBeenCalled();
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  },
);
it("does not send an obsolete snapshot when typing resumes during local persistence", async () => {
  vi.useFakeTimers();
  const { session, ports } = setup();
  let release!: () => void;
  ports.persist = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    )
    .mockResolvedValue(undefined);
  try {
    session.edit({ body: "Earlier" });
    const saving = session.save();
    await vi.advanceTimersByTimeAsync(0);
    session.edit({ body: "Latest" });
    release();
    await saving;
    await vi.advanceTimersByTimeAsync(2999);
    expect(ports.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ports.write).toHaveBeenCalledTimes(1);
    expect(ports.write).toHaveBeenCalledWith(
      note.id,
      expect.objectContaining({ body: "Latest" }),
      1,
    );
  } finally {
    session.dispose();
    vi.useRealTimers();
  }
});
