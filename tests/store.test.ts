import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store";
import { migrate } from "../scripts/migrations.mjs";

let client: Client;
let store: Store;
const original = {
  generation: 1,
  areaId: null,
  title: "Architektur",
  originalText: "Zuerst prüfen, noch nicht veröffentlichen.",
  body: "Zuerst prüfen, noch nicht veröffentlichen.",
  provider: "google" as const,
  model: "gemini-3.5-transcribe",
  mode: "verbatim" as const,
  durationMs: 12000,
};
beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client, "db/migrations");
  store = new Store(client);
});
afterEach(() => client.close());

describe("Shared note storage", () => {
  it("preserves originals and concurrent edits on repeated creation", async () => {
    const id = randomUUID();
    expect((await store.create(id, original)).revision).toBe(1);
    const changed = await store.update(id, {
      generation: 1,
      areaId: null,
      title: "Geprüft",
      body: "Neue Fassung",
      expectedRevision: 1,
    });
    expect(changed.revision).toBe(2);
    const replay = await store.create(id, original);
    expect(replay.body).toBe("Neue Fassung");
    expect(replay.originalText).toBe(original.originalText);
    await expect(
      store.create(id, { ...original, originalText: "Anderer Ursprung" }),
    ).rejects.toMatchObject({ code: "id_conflict", status: 409 });
  });
  it("returns the current version for stale revisions without changing it", async () => {
    const id = randomUUID();
    await store.create(id, original);
    await store.update(id, {
      generation: 1,
      areaId: null,
      title: "Rechner A",
      body: "A",
      expectedRevision: 1,
    });
    await expect(
      store.update(id, {
        generation: 1,
        areaId: null,
        title: "Rechner B",
        body: "B",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({
      code: "revision_conflict",
      conflict: { kind: "note", current: { body: "A", revision: 2 } },
    });
    expect((await store.get(id, 1)).body).toBe("A");
  });
  it("confirms unchanged edits through RETURNING and increments the revision", async () => {
    const id = randomUUID();
    await store.create(id, original);
    expect(
      (
        await store.update(id, {
          generation: 1,
          areaId: null,
          title: original.title,
          body: original.body,
          expectedRevision: 1,
        })
      ).revision,
    ).toBe(2);
  });
  it("removes content and permanently blocks late recreation", async () => {
    const id = randomUUID();
    await store.create(id, original);
    await expect(store.delete(id, 2, 1)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    await store.delete(id, 1, 1);
    await store.delete(id, 1, 1);
    await expect(store.create(id, original)).rejects.toMatchObject({
      status: 410,
      code: "note_deleted",
    });
    await expect(
      store.update(id, {
        generation: 1,
        areaId: null,
        title: "Alt",
        body: "Alt",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "note_deleted" });
    expect((await client.execute("SELECT * FROM notes")).rows).toHaveLength(0);
    const marker = (await client.execute("SELECT * FROM deleted_notes"))
      .rows[0];
    expect(Object.keys(marker).sort()).toEqual(["deleted_at", "id"]);
    expect((await store.list(1)).items).toHaveLength(0);
  });
  it("distinguishes unknown IDs from deleted IDs", async () => {
    await expect(store.get(randomUUID(), 1)).rejects.toMatchObject({
      status: 404,
    });
    await expect(store.delete(randomUUID(), 1, 1)).rejects.toMatchObject({
      code: "note_not_found",
    });
  });
  it("paginates without duplicate IDs and bounds previews", async () => {
    // Equal timestamps exercise the UUID as the secondary sort key.
    const stamp = "2026-01-01T00:00:00.000Z";
    for (let n = 0; n < 53; n++) {
      await store.create(randomUUID(), { ...original, body: "x".repeat(200) });
    }
    await client.execute({
      sql: "UPDATE library_notes SET updated_at=?",
      args: [stamp],
    });
    const first = await store.list(1);
    expect(first.items).toHaveLength(50);
    expect(first.items[0].preview).toHaveLength(140);
    const next = await store.list(1, "all", first.nextCursor!);
    expect(next.items).toHaveLength(3);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...first.items, ...next.items].map((x) => x.id)).size).toBe(
      53,
    );
    await expect(store.list(1, "all", "invalid")).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
  it("prevents SQL changes to immutable origin fields", async () => {
    const id = randomUUID();
    await store.create(id, original);
    await expect(
      client.execute({
        sql: "UPDATE library_notes SET original_text=? WHERE id=?",
        args: ["Falsch", id],
      }),
    ).rejects.toBeDefined();
    expect((await store.get(id, 1)).originalText).toBe(original.originalText);
  });
});

describe("Shared vocabulary", () => {
  it("starts empty and detects concurrent changes", async () => {
    expect(await store.settings()).toEqual({ vocabulary: [], revision: 1 });
    await store.saveSettings({
      vocabulary: ["Eigener Begriff"],
      expectedRevision: 1,
    });
    await expect(
      store.saveSettings({
        vocabulary: ["Andere Fassung"],
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({
      code: "revision_conflict",
      conflict: {
        kind: "settings",
        current: { vocabulary: ["Eigener Begriff"], revision: 2 },
      },
    });
  });
  it("treats missing singleton rows as schema errors", async () => {
    await client.execute("DELETE FROM settings");
    await expect(store.settings()).rejects.toMatchObject({
      code: "schema_unavailable",
    });
  });
  it("maps missing schema tables to an actionable setup error", async () => {
    await client.execute("DROP TABLE library_notes");
    await expect(store.list(1)).rejects.toMatchObject({
      code: "schema_unavailable",
    });
  });
  it("keeps non-schema database failures sanitized", async () => {
    client.close();
    await expect(store.settings()).rejects.toMatchObject({
      code: "storage_unavailable",
    });
  });
});
