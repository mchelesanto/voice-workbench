import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store";
import { withStorageOperation } from "../src/server/storage-operation";
import { migrate } from "../scripts/migrations.mjs";

const note = (generation = 1, areaId: string | null = null) => ({
  title: "Synthetic note",
  body: "Working text",
  originalText: "Initial text",
  provider: "google" as const,
  model: "gemini-3.5-transcribe",
  mode: "verbatim" as const,
  durationMs: 1800000,
  generation,
  areaId,
});
let db: Client, store: Store;
beforeEach(async () => {
  db = createClient({ url: "file::memory:" });
  await migrate(db, "db/migrations");
  store = new Store(db);
});
afterEach(() => db.close());

describe("Library generations and reset receipts", () => {
  it("clears notes once while retaining exact vocabulary and area state", async () => {
    const areaId = randomUUID();
    await store.createArea(areaId, {
      name: "Project",
      vocabulary: ["Project term"],
    });
    await store.saveSettings({
      vocabulary: ["Global term"],
      expectedRevision: 1,
    });
    const id = randomUUID();
    await store.create(id, note(1, areaId));
    const words = await db.execute("SELECT * FROM settings");
    const areas = await db.execute("SELECT * FROM areas");
    const input = { operationId: randomUUID(), expectedGeneration: 1 };
    const receipt = await store.resetLibrary(input);
    expect(receipt).toMatchObject({
      operationId: input.operationId,
      fromGeneration: 1,
      generation: 2,
      deletedNoteCount: 1,
    });
    const current = await store.create(randomUUID(), note(2));
    expect(await store.resetLibrary(input)).toEqual(receipt);
    expect((await store.list(2)).items.map((n) => n.id)).toEqual([current.id]);
    expect((await db.execute("SELECT * FROM settings")).rows).toEqual(
      words.rows,
    );
    expect((await db.execute("SELECT * FROM areas")).rows).toEqual(areas.rows);
    expect(
      (
        await db.execute({
          sql: "SELECT id FROM deleted_notes WHERE id=?",
          args: [id],
        })
      ).rows,
    ).toHaveLength(1);
    await expect(store.get(id, 1)).rejects.toMatchObject({
      code: "library_reset",
    });
    await expect(store.create(id, note(2))).rejects.toMatchObject({
      code: "note_deleted",
    });
    await expect(
      store.resetLibrary({ ...input, expectedGeneration: 2 }),
    ).rejects.toMatchObject({ code: "reset_conflict" });
  });

  it("makes cancellation and completed reset mutually exclusive and replayable", async () => {
    const id = randomUUID();
    await store.create(id, note());
    const cancelled = { operationId: randomUUID(), expectedGeneration: 1 };
    expect(await store.cancelReset(cancelled)).toEqual({
      state: "cancelled",
      ...cancelled,
    });
    await expect(store.resetLibrary(cancelled)).rejects.toMatchObject({
      code: "reset_cancelled",
    });
    expect((await store.get(id, 1)).id).toBe(id);
    expect(await store.cancelReset(cancelled)).toEqual({
      state: "cancelled",
      ...cancelled,
    });
    const completed = { operationId: randomUUID(), expectedGeneration: 1 };
    const receipt = await store.resetLibrary(completed);
    expect(await store.cancelReset(completed)).toEqual({
      state: "completed",
      receipt,
    });
    expect(await store.libraryState()).toMatchObject({ generation: 2 });
  });

  it("rejects every stale content operation before a note-specific result", async () => {
    const id = randomUUID();
    await store.create(id, note());
    await store.resetLibrary({
      operationId: randomUUID(),
      expectedGeneration: 1,
    });
    for (const work of [
      () => store.get(id, 1),
      () => store.list(1),
      () => store.create(randomUUID(), note()),
      () =>
        store.update(id, {
          title: "X",
          body: "X",
          areaId: null,
          generation: 1,
          expectedRevision: 1,
        }),
      () => store.delete(id, 1, 1),
    ])
      await expect(work()).rejects.toMatchObject({
        code: "library_reset",
        conflict: { kind: "library", current: { generation: 2 } },
      });
    expect((await store.list(2)).items).toEqual([]);
  });

  it("does not delete at generation overflow", async () => {
    await db.execute(
      "UPDATE library_state SET generation=9007199254740991 WHERE id=1",
    );
    const id = randomUUID();
    await store.create(id, note(Number.MAX_SAFE_INTEGER));
    await expect(
      store.resetLibrary({
        operationId: randomUUID(),
        expectedGeneration: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toMatchObject({ code: "generation_exhausted" });
    expect((await store.get(id, Number.MAX_SAFE_INTEGER)).id).toBe(id);
  });
});

describe("Areas", () => {
  it("binds immutable create identity while allowing rename, archive and note movement", async () => {
    const id = randomUUID();
    const input = { name: "  Project   One  ", vocabulary: [" Café "] };
    const area = await store.createArea(id, input);
    expect(area).toMatchObject({
      name: "Project One",
      vocabulary: ["Café"],
      revision: 1,
    });
    const updated = await store.updateArea(id, {
      name: "Renamed",
      vocabulary: ["Other"],
      archived: true,
      expectedRevision: 1,
    });
    expect(await store.createArea(id, input)).toEqual(updated);
    await expect(
      store.createArea(id, { ...input, vocabulary: ["Different"] }),
    ).rejects.toMatchObject({ code: "id_conflict" });
    const n = await store.create(randomUUID(), note(1, id));
    const moved = await store.update(n.id, {
      title: n.title,
      body: n.body,
      areaId: null,
      generation: 1,
      expectedRevision: 1,
    });
    expect(moved.areaId).toBeNull();
    expect((await store.create(n.id, note(1, id))).areaId).toBeNull();
    await expect(
      store.create(randomUUID(), note(1, randomUUID())),
    ).rejects.toMatchObject({ code: "area_not_found" });
  });

  it("enforces active-name uniqueness and revision CAS", async () => {
    const a = await store.createArea(randomUUID(), {
      name: "Café",
      vocabulary: [],
    });
    await expect(
      store.createArea(randomUUID(), { name: " CAFÉ ", vocabulary: [] }),
    ).rejects.toMatchObject({ code: "area_name_conflict" });
    await store.updateArea(a.id, {
      name: a.name,
      vocabulary: [],
      archived: true,
      expectedRevision: 1,
    });
    await store.createArea(randomUUID(), { name: "café", vocabulary: [] });
    await expect(
      store.updateArea(a.id, {
        name: a.name,
        vocabulary: [],
        archived: false,
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "area_name_conflict" });
    await expect(
      store.updateArea(a.id, {
        name: "Other",
        vocabulary: [],
        archived: false,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({
      code: "revision_conflict",
      conflict: { kind: "area" },
    });
  });
});

it("migrates existing content exactly and makes legacy SQL read-only", async () => {
  const legacy = createClient({ url: "file::memory:" });
  try {
    await legacy.executeMultiple(
      await readFile("db/migrations/0001_notes.sql", "utf8"),
    );
    const id = randomUUID();
    await legacy.execute({
      sql: "INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      args: [
        id,
        "Title",
        "Original",
        "Body",
        "google",
        "gemini-3.5-transcribe",
        "verbatim",
        30000,
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
        7,
      ],
    });
    const before = await legacy.execute("SELECT * FROM notes");
    const tx = await legacy.transaction("write");
    await tx.executeMultiple(
      await readFile("db/migrations/0002_workspace.sql", "utf8"),
    );
    await tx.commit();
    tx.close();
    expect((await legacy.execute("SELECT * FROM notes")).rows).toEqual(
      before.rows,
    );
    expect(await new Store(legacy).get(id, 1)).toMatchObject({
      generation: 1,
      areaId: null,
      revision: 7,
    });
    for (const sql of [
      "DELETE FROM notes",
      "UPDATE notes SET body='changed'",
      "INSERT INTO notes SELECT * FROM notes",
    ])
      await expect(legacy.execute(sql)).rejects.toMatchObject({
        code: "SQLITE_ERROR",
      });
    await expect(
      legacy.execute({
        sql: "UPDATE library_notes SET generation=2 WHERE id=?",
        args: [id],
      }),
    ).rejects.toBeDefined();
  } finally {
    legacy.close();
  }
});

it("binds cursors to their generation and area filter", async () => {
  const a = await store.createArea(randomUUID(), {
    name: "Scoped",
    vocabulary: [],
  });
  for (let i = 0; i < 51; i++) await store.create(randomUUID(), note(1, a.id));
  const page = await store.list(1, a.id);
  expect(page.nextCursor).toBeTruthy();
  expect((await store.list(1, a.id, page.nextCursor!)).items).toHaveLength(1);
  await expect(
    store.list(1, "general", page.nextCursor!),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await store.resetLibrary({
    operationId: randomUUID(),
    expectedGeneration: 1,
  });
  await expect(store.list(2, a.id, page.nextCursor!)).rejects.toMatchObject({
    code: "library_reset",
  });
});
it("rolls back a deliberately interrupted workspace migration", async () => {
  const legacy = createClient({ url: "file::memory:" });
  try {
    await legacy.executeMultiple(
      await readFile("db/migrations/0001_notes.sql", "utf8"),
    );
    await legacy.execute(
      "UPDATE settings SET vocabulary_json='[\"Kept\"]',revision=7",
    );
    const tx = await legacy.transaction("write");
    await tx.executeMultiple(
      await readFile("db/migrations/0002_workspace.sql", "utf8"),
    );
    await expect(
      tx.execute("INSERT INTO missing_migration_probe VALUES (1)"),
    ).rejects.toBeDefined();
    await tx.rollback();
    tx.close();
    expect(
      (
        await legacy.execute(
          "SELECT type FROM sqlite_schema WHERE name='notes'",
        )
      ).rows[0].type,
    ).toBe("table");
    expect(
      (await legacy.execute("SELECT revision,vocabulary_json FROM settings"))
        .rows[0],
    ).toMatchObject({ revision: 7, vocabulary_json: '["Kept"]' });
    expect(
      (
        await legacy.execute(
          "SELECT name FROM sqlite_schema WHERE name='library_state'",
        )
      ).rows,
    ).toEqual([]);
  } finally {
    legacy.close();
  }
});

it("serializes reset versus cancellation across isolated request connections", async () => {
  const { mkdir, mkdtemp, rm } = await import("node:fs/promises");
  const { resolve, join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  await mkdir("temp/probes", { recursive: true });
  const directory = await mkdtemp(join(resolve("temp/probes"), "m2-race-"));
  const url = pathToFileURL(join(directory, "library.db")).href;
  const clients: Client[] = [];
  const run = <T>(work: (store: Store) => Promise<T>) =>
    withStorageOperation(
      new AbortController().signal,
      () => {
        const client = createClient({ url });
        clients.push(client);
        return new Store(client, () => client.close());
      },
      work,
    );
  try {
    const bootstrap = createClient({ url });
    await migrate(bootstrap, "db/migrations");
    await new Store(bootstrap).create(randomUUID(), note());
    bootstrap.close();
    const operation = { operationId: randomUUID(), expectedGeneration: 1 };
    const outcomes = await Promise.allSettled([
      run((store) => store.resetLibrary(operation)),
      run((store) => store.cancelReset(operation)),
    ]);
    expect(outcomes.some((result) => result.status === "fulfilled")).toBe(true);
    for (const result of outcomes)
      if (result.status === "rejected")
        expect(["storage_unavailable", "reset_cancelled"]).toContain(
          result.reason.code,
        );
    expect(clients.every((client) => client.closed)).toBe(true);
    const resolution = await run((store) => store.cancelReset(operation));
    if (resolution.state === "completed") {
      expect(await run((store) => store.resetLibrary(operation))).toEqual(
        resolution.receipt,
      );
      expect((await run((store) => store.list(2))).items).toEqual([]);
    } else {
      await expect(
        run((store) => store.resetLibrary(operation)),
      ).rejects.toMatchObject({ code: "reset_cancelled" });
      expect((await run((store) => store.list(1))).items).toHaveLength(1);
    }
  } finally {
    clients.forEach((client) => client.close());
    await rm(directory, { recursive: true, force: true }).catch((error) => {
      if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
    });
  }
});
