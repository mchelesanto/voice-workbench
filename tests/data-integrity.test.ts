import { describe, it, expect, afterEach } from "vitest";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { migrate } from "../scripts/migrations.mjs";
import { loadProjectConfig } from "../scripts/config.mjs";
import { Store } from "../src/server/store";
import { createModels } from "../src/server/models";
import { createNoteSchema } from "../src/shared/contracts";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const config = {
  origin: "http://localhost:3210",
  databaseUrl: "libsql://example.turso.io",
  databaseToken: "fixture",
  googleKey: "fixture",
  mistralKey: "fixture",
  fireworksKey: "fixture",
};
describe("Data and configuration integrity", () => {
  it("returns 140 complete Unicode characters in previews", async () => {
    const db = createClient({ url: ":memory:" });
    try {
      await migrate(db, "db/migrations");
      const store = new Store(db);
      await store.create(randomUUID(), {
        generation: 1,
        areaId: null,
        title: "Emoji",
        originalText: "Original",
        body: "a".repeat(139) + "😀Z",
        provider: "google",
        model: "gemini-3.5-transcribe",
        mode: "verbatim",
        durationMs: 1,
      });
      const preview = (await store.list(1)).items[0].preview;
      expect(preview.isWellFormed()).toBe(true);
      expect([...preview]).toHaveLength(140);
      expect(preview.endsWith("😀")).toBe(true);
    } finally {
      db.close();
    }
  });
  it("accepts historical model identifiers on reads and create replays", async () => {
    const db = createClient({ url: ":memory:" });
    try {
      await migrate(db, "db/migrations");
      const store = new Store(db);
      const id = randomUUID();
      const input = {
        generation: 1,
        areaId: null,
        title: "Alt",
        originalText: "Original",
        body: "Alt",
        provider: "mistral",
        model: "voxtral-mini-2602",
        mode: "verbatim",
        durationMs: 1,
      };
      const checked = createNoteSchema.parse(input);
      await store.create(id, checked);
      await store.update(id, {
        generation: 1,
        areaId: null,
        title: "Neu",
        body: "Neu",
        expectedRevision: 1,
      });
      expect((await store.get(id, 1)).model).toBe("voxtral-mini-2602");
      expect((await store.create(id, checked)).body).toBe("Neu");
      await expect(
        store.update(id, {
          generation: 1,
          areaId: null,
          title: "Alt",
          body: "Alt",
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({
        conflict: { kind: "note", current: { model: "voxtral-mini-2602" } },
      });
    } finally {
      db.close();
    }
  });
  it("uses the same Unicode length unit for output and storage", async () => {
    const text = "😀".repeat(50001);
    const models = createModels(config, {
      transcribe: async () => ({ text }),
      generateText: async () => ({ text, finishReason: "stop" }),
    });
    const result = await models.transcribe(
      {
        generation: 1,
        provider: "google",
        mode: "verbatim",
        vocabulary: [],
        audio: new Uint8Array(44),
      },
      new AbortController().signal,
    );
    expect([...result.text]).toHaveLength(50001);
  });
  it("rejects extra environment files and unknown keys before Next starts", async () => {
    await mkdir("temp/probes", { recursive: true });
    const dir = await mkdtemp(join(resolve("temp/probes"), "env-integrity-"));
    dirs.push(dir);
    const base =
      'TURSO_DATABASE_URL="libsql://example.turso.io"\nTURSO_AUTH_TOKEN="fixture"\nAPP_ORIGIN="http://localhost:3210"\n';
    await writeFile(join(dir, ".env.local"), base);
    await writeFile(join(dir, ".env.production"), 'EXTRA="fixture"\n');
    expect(() => loadProjectConfig(dir)).toThrow();
    await rm(join(dir, ".env.production"));
    for (const key of ["TURSO_API_KEY", "NEXT_PUBLIC_TOKEN", "UNEXPECTED"]) {
      await writeFile(join(dir, ".env.local"), base + key + '="fixture"\n');
      expect(() => loadProjectConfig(dir)).toThrow();
    }
  });
});
