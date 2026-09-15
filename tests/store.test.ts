import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store";
import { migrate } from "../scripts/migrations.mjs";

let client: Client;
let store: Store;
const original = {
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

describe("Notizen als gemeinsamer Datenbestand", () => {
  it("erhält Original und fremde Edits bei wiederholtem Erstellen", async () => {
    const id = randomUUID();
    expect((await store.create(id, original)).revision).toBe(1);
    const changed = await store.update(id, {
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
  it("liefert die aktuelle Fassung bei veralteter Revision, ohne sie zu ändern", async () => {
    const id = randomUUID();
    await store.create(id, original);
    await store.update(id, {
      title: "Rechner A",
      body: "A",
      expectedRevision: 1,
    });
    await expect(
      store.update(id, { title: "Rechner B", body: "B", expectedRevision: 1 }),
    ).rejects.toMatchObject({
      code: "revision_conflict",
      current: { body: "A", revision: 2 },
    });
    expect((await store.get(id)).body).toBe("A");
  });
  it("bestätigt auch unveränderte Edits anhand RETURNING und erhöht die Revision", async () => {
    const id = randomUUID();
    await store.create(id, original);
    expect(
      (
        await store.update(id, {
          title: original.title,
          body: original.body,
          expectedRevision: 1,
        })
      ).revision,
    ).toBe(2);
  });
  it("entfernt Inhalte und verhindert verspätete Wiederanlage dauerhaft", async () => {
    const id = randomUUID();
    await store.create(id, original);
    await expect(store.delete(id, 2)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    await store.delete(id, 1);
    await store.delete(id, 1);
    await expect(store.create(id, original)).rejects.toMatchObject({
      status: 410,
      code: "note_deleted",
    });
    await expect(
      store.update(id, { title: "Alt", body: "Alt", expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "note_deleted" });
    expect((await client.execute("SELECT * FROM notes")).rows).toHaveLength(0);
    const marker = (await client.execute("SELECT * FROM deleted_notes"))
      .rows[0];
    expect(Object.keys(marker).sort()).toEqual(["deleted_at", "id"]);
    expect((await store.list()).items).toHaveLength(0);
  });
  it("unterscheidet unbekannte IDs von gelöschten IDs", async () => {
    await expect(store.get(randomUUID())).rejects.toMatchObject({
      status: 404,
    });
    await expect(store.delete(randomUUID(), 1)).rejects.toMatchObject({
      code: "note_not_found",
    });
  });
  it("paginiert ohne doppelte IDs und begrenzt Vorschautexte", async () => {
    // Gleiche Zeitwerte prüfen die UUID als zweiten Sortierschlüssel.
    const stamp = "2026-01-01T00:00:00.000Z";
    for (let n = 0; n < 53; n++) {
      await store.create(randomUUID(), { ...original, body: "x".repeat(200) });
    }
    await client.execute({
      sql: "UPDATE notes SET updated_at=?",
      args: [stamp],
    });
    const first = await store.list();
    expect(first.items).toHaveLength(50);
    expect(first.items[0].preview).toHaveLength(140);
    const next = await store.list(first.nextCursor!);
    expect(next.items).toHaveLength(3);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...first.items, ...next.items].map((x) => x.id)).size).toBe(
      53,
    );
    await expect(store.list("invalid")).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
  it("erlaubt keine Änderung der unveränderlichen Ursprungsfelder durch SQL", async () => {
    const id = randomUUID();
    await store.create(id, original);
    await expect(
      client.execute({
        sql: "UPDATE notes SET original_text=? WHERE id=?",
        args: ["Falsch", id],
      }),
    ).rejects.toBeDefined();
    expect((await store.get(id)).originalText).toBe(original.originalText);
  });
});

describe("Gemeinsames Vokabular", () => {
  it("beginnt leer und erkennt konkurrierende Änderungen", async () => {
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
      current: { vocabulary: ["Eigener Begriff"], revision: 2 },
    });
  });
  it("behandelt fehlende Singletonzeile als Schemafehler", async () => {
    await client.execute("DELETE FROM settings");
    await expect(store.settings()).rejects.toMatchObject({
      code: "schema_unavailable",
    });
  });
  it("übersetzt Datenbankausfälle in abstrakte Fehler", async () => {
    await client.execute("DROP TABLE notes");
    await expect(store.list()).rejects.toMatchObject({
      code: "storage_unavailable",
    });
  });
});
