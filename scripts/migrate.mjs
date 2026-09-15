import { createClient } from "@libsql/client";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectConfig, ConfigurationError } from "./config.mjs";
import { migrate } from "./migrations.mjs";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
/** @type {import('@libsql/client').Client | undefined} */
let client;
try {
  const config = loadProjectConfig(root);
  client = createClient({
    url: config.databaseUrl,
    authToken: config.databaseToken,
  });
  const names = await migrate(client, join(root, "db/migrations"));
  console.log(
    names.length
      ? `Migrationen angewendet: ${names.join(", ")}`
      : "Datenbankschema ist aktuell.",
  );
} catch (error) {
  console.error(
    error instanceof ConfigurationError
      ? error.message
      : "Migration fehlgeschlagen. Schema oder Verbindung prüfen; keine Fehlerdetails mit Zugangsdaten ausgegeben.",
  );
  process.exitCode = 1;
} finally {
  client?.close();
}
