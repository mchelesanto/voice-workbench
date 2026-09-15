import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
/**
 * @param {import('@libsql/client').Client} client
 * @param {string} directory
 */
export async function migrate(client, directory) {
  await client.execute(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (names.some((name) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name)))
    throw new Error("Ungültiger Migrationsname.");
  const appliedNames = (
    await client.execute("SELECT name FROM schema_migrations")
  ).rows.map((row) => String(row.name));
  if (appliedNames.some((name) => !names.includes(name)))
    throw new Error("Eine angewendete Migration fehlt im Projekt.");
  const applied = [];
  for (const name of names) {
    const sql = await readFile(join(directory, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const tx = await client.transaction("write");
    try {
      const existing = await tx.execute({
        sql: "SELECT checksum FROM schema_migrations WHERE name=?",
        args: [name],
      });
      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error("Eine angewendete Migration wurde verändert.");
      } else {
        const later = await tx.execute({
          sql: "SELECT name FROM schema_migrations WHERE name > ? LIMIT 1",
          args: [name],
        });
        if (later.rows.length)
          throw new Error(
            "Migrationen müssen in aufsteigender Reihenfolge ergänzt werden.",
          );
        await tx.executeMultiple(sql);
        await tx.execute({
          sql: "INSERT INTO schema_migrations VALUES (?,?,?)",
          args: [name, checksum, new Date().toISOString()],
        });
        applied.push(name);
      }
      await tx.commit();
    } catch (error) {
      try {
        await tx.rollback();
      } catch {
        /* Die ursprüngliche Ursache bleibt erhalten. */
      }
      throw error;
    } finally {
      tx.close();
    }
  }
  return applied;
}
