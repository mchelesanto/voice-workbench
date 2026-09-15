import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  loadProjectConfig,
  applicationEnvironment,
  buildEnvironment,
} from "./config.mjs";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2];
if (
  !["dev", "start", "build"].includes(mode ?? "") ||
  process.argv.length !== 3
) {
  console.error("Usage: npm run dev, npm start, or npm run build");
  process.exit(1);
}
try {
  const env =
    mode === "build"
      ? buildEnvironment(root, process.env)
      : applicationEnvironment(loadProjectConfig(root), process.env);
  const require = createRequire(join(root, "package.json"));
  const next = require.resolve("next/dist/bin/next");
  const child = spawn(
    process.execPath,
    [
      next,
      mode,
      ...(mode === "build"
        ? []
        : ["--hostname", "127.0.0.1", "--port", "3210"]),
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...env, NODE_ENV: mode === "dev" ? "development" : "production" },
    },
  );
  let requestedStop = false;
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
    process.on(signal, () => {
      requestedStop = true;
      child.kill(signal);
    });
  }
  child.on("error", () => {
    console.error("The local server could not start.");
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode =
      requestedStop &&
      (signal === "SIGINT" || signal === "SIGTERM" || code === 0)
        ? 0
        : (code ?? 1);
  });
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Invalid configuration.",
  );
  process.exitCode = 1;
}
