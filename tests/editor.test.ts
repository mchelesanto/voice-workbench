import { describe, expect, it, vi } from "vitest";
import { EditorSession, type EditorPorts } from "../src/client/editor";
import type { Note } from "../src/shared/contracts";
import { ClientError } from "../src/client/api";
const note: Note = {
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
    expect(session.snapshot().status).toBe("local_error");
    expect(session.snapshot().input.body).toBe("Wertvoll");
    session.dispose();
  });
  it("preserves the local version across repeated conflicts", async () => {
    const { session, ports } = setup();
    ports.write = vi.fn(async () => {
      throw new ClientError("Konflikt", 409, "revision_conflict", {
        ...note,
        body: "Remote",
        revision: 4,
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
        ...note,
        body: "Neu",
        revision: 2,
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
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const discarded = session.discard();
  await Promise.resolve();
  await Promise.resolve();
  expect(ports.remove).not.toHaveBeenCalled();
  release();
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
  expect(session.applyRefinement(proposal.text, proposal.source)).toBe(false);
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
  expect(session.applyRefinement("Proposal", "Old source")).toBe(false);
  expect(
    session.applyRefinement("Proposal", "My carefully edited version"),
  ).toBe(true);
  expect(session.snapshot().input.originalText).toBe("Original");
  expect(session.undoRefinement()).toBe(true);
  expect(session.snapshot().input.body).toBe("My carefully edited version");
  session.applyRefinement("Another proposal", "My carefully edited version");
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
