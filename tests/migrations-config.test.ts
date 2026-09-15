import { describe, it, expect, afterEach } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createClient } from "@libsql/client";
import {
  loadProjectConfig,
  applicationEnvironment,
} from "../scripts/config.mjs";
import { migrate } from "../scripts/migrations.mjs";
const folders: string[] = [];
async function folder() {
  await mkdir("temp", { recursive: true });
  const dir = await mkdtemp(join(resolve("temp"), "spec-"));
  folders.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of folders.splice(0))
    await rm(dir, { recursive: true, force: true });
});
describe("Projektkonfiguration", () => {
  it("liest ausschließlich die eigene Datei und ersetzt geerbte fremde Werte", async () => {
    const dir = await folder();
    await writeFile(
      join(dir, ".env.local"),
      'TURSO_DATABASE_URL="libsql://example.turso.io"\nTURSO_AUTH_TOKEN="own-db-token"\nAPP_ORIGIN="http://localhost:3210"\n',
    );
    const config = loadProjectConfig(dir);
    const env = applicationEnvironment(config, {
      NODE_ENV: "test",
      TURSO_DATABASE_URL: "libsql://different.turso.io",
      TURSO_AUTH_TOKEN: "different",
      TURSO_API_KEY: "platform",
      MISTRAL_API_KEY: "inherited",
      NEXT_PUBLIC_TOKEN: "private",
      PATH: "keep-path",
    });
    expect(env.TURSO_AUTH_TOKEN).toBe("own-db-token");
    expect(env.MISTRAL_API_KEY).toBe("");
    expect(env.PATH).toBe("keep-path");
    expect(env).not.toHaveProperty("TURSO_API_KEY");
    expect(env).not.toHaveProperty("NEXT_PUBLIC_TOKEN");
  });
  it("nennt bei kaputter Konfiguration keine Secretwerte", async () => {
    const dir = await folder();
    await writeFile(
      join(dir, ".env.local"),
      'TURSO_DATABASE_URL="http://invalid.test/private-value"\nTURSO_AUTH_TOKEN="private-value"\nAPP_ORIGIN="http://localhost:3210"\n',
    );
    expect(() => loadProjectConfig(dir)).toThrow("TURSO_DATABASE_URL");
    try {
      loadProjectConfig(dir);
    } catch (e) {
      expect(String(e)).not.toContain("private-value");
    }
  });
});
describe("Versionierte Migrationen", () => {
  it("ist wiederholbar und prüft den gespeicherten Checksum", async () => {
    const dir = await folder();
    const db = createClient({ url: ":memory:" });
    try {
      await writeFile(
        join(dir, "0001_initial.sql"),
        "CREATE TABLE example(id TEXT);",
      );
      expect(await migrate(db, dir)).toEqual(["0001_initial.sql"]);
      expect(await migrate(db, dir)).toEqual([]);
      await writeFile(
        join(dir, "0001_initial.sql"),
        "CREATE TABLE changed(id TEXT);",
      );
      await expect(migrate(db, dir)).rejects.toThrow("verändert");
    } finally {
      db.close();
    }
  });
  it("rollt eine teilweise fehlgeschlagene Migration vollständig zurück", async () => {
    const dir = await folder();
    const db = createClient({ url: ":memory:" });
    try {
      await writeFile(
        join(dir, "0001_invalid.sql"),
        "CREATE TABLE temporary_table(id TEXT); INSERT INTO missing_table VALUES (1);",
      );
      await expect(migrate(db, dir)).rejects.toBeDefined();
      expect(
        (
          await db.execute(
            "SELECT name FROM sqlite_schema WHERE name='temporary_table'",
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (await db.execute("SELECT * FROM schema_migrations")).rows,
      ).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
