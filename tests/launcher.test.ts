import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildEnvironment } from "../scripts/config.mjs";
const folders: string[] = [];
async function fixture() {
  await mkdir("temp/probes", { recursive: true });
  const root = await mkdtemp(join(resolve("temp/probes"), "launcher-"));
  folders.push(root);
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "node_modules/next/dist/bin"), { recursive: true });
  await copyFile("scripts/serve.mjs", join(root, "scripts/serve.mjs"));
  await copyFile("scripts/config.mjs", join(root, "scripts/config.mjs"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(
    join(root, ".env.local"),
    'TURSO_DATABASE_URL="libsql://example.turso.io"\nTURSO_AUTH_TOKEN="fixture-only"\nAPP_ORIGIN="http://localhost:3210"\n',
  );
  await writeFile(
    join(root, "node_modules/next/dist/bin/next"),
    'setInterval(()=>{},1000);console.log("READY");',
  );
  return root;
}
afterEach(async () => {
  for (const dir of folders.splice(0))
    await rm(dir, { recursive: true, force: true });
});
describe("Real process boundaries", () => {
  // Windows child.kill terminates a process; it does not deliver POSIX signals.
  it.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM"] as const)(
    "treats a forwarded %s as a controlled stop on POSIX",
    async (signal) => {
      const root = await fixture();
      const result = await new Promise<number | null>(
        (resolveResult, reject) => {
          const child = spawn(
            process.execPath,
            [join(root, "scripts/serve.mjs"), "start"],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          const timer = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error("Launcher timeout"));
          }, 2500);
          child.stdout.on("data", (data) => {
            if (data.toString().includes("READY")) child.kill(signal);
          });
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("exit", (code) => {
            clearTimeout(timer);
            resolveResult(code);
          });
        },
      );
      expect(result).toBe(0);
    },
  );
  it.each([0, 7])(
    "propagates child exit code %s on every platform",
    async (code) => {
      const root = await fixture();
      await writeFile(
        join(root, "node_modules/next/dist/bin/next"),
        `process.exit(${code});`,
      );
      const actual = await new Promise<number | null>(
        (resolveResult, reject) => {
          const child = spawn(
            process.execPath,
            [join(root, "scripts/serve.mjs"), "start"],
            {
              stdio: "ignore",
            },
          );
          child.once("error", reject);
          child.once("exit", resolveResult);
        },
      );
      expect(actual).toBe(code);
    },
  );
  it("keeps credentials out of builds after real Next environment resolution", async () => {
    const root = await fixture();
    const environment = buildEnvironment(root, {
      ...process.env,
      TURSO_AUTH_TOKEN: "inherited-fixture",
      TURSO_API_KEY: "platform-fixture",
      NEXT_PUBLIC_TOKEN: "public-fixture",
    });
    const nextEnvPath = resolve("node_modules/@next/env/dist/index.js");
    const script =
      "const env=require(" +
      JSON.stringify(nextEnvPath) +
      ");env.loadEnvConfig(process.cwd(),false);console.log(JSON.stringify({db:process.env.TURSO_AUTH_TOKEN,platform:process.env.TURSO_API_KEY,public:process.env.NEXT_PUBLIC_TOKEN}));";
    const result = await promisify(execFile)(process.execPath, ["-e", script], {
      cwd: root,
      env: { ...environment, NODE_ENV: "production" },
    });
    expect(JSON.parse(result.stdout.trim())).toEqual({ db: "" });
  });
});
