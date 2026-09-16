import { expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { Store } from "../src/server/store";
import { createApi } from "../src/server/api";
import { migrate } from "../scripts/migrations.mjs";
import { classifyEditConflict } from "../src/shared/responses";

it("replays a timed-out committed write through a fresh client after closing the first", async () => {
  const base = resolve("temp/probes");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "storage-replay-"));
  const url = pathToFileURL(join(directory, "notes.db")).href;
  const clients: Client[] = [];
  let release!: () => void;
  vi.useFakeTimers();
  try {
    const bootstrap = createClient({ url });
    await migrate(bootstrap, "db/migrations");
    const id = "11111111-1111-4111-8111-111111111111";
    await new Store(bootstrap).create(id, {
      title: "Before",
      body: "Before",
      originalText: "Before",
      provider: "google",
      model: "gemini-3.5-transcribe",
      mode: "verbatim",
      durationMs: 1,
    });
    bootstrap.close();
    let committed = false;
    const api = createApi({
      getConfig: () => ({
        origin: "http://localhost:3210",
        databaseUrl: "https://fixture.invalid",
        databaseToken: "fixture",
        googleKey: "",
        mistralKey: "",
        fireworksKey: "",
      }),
      getModels: vi.fn(),
      getStore: () => {
        const db = createClient({ url });
        clients.push(db);
        const store = new Store(db, () => db.close());
        if (clients.length === 1) {
          const update = store.update.bind(store);
          vi.spyOn(store, "update").mockImplementation(async (...args) => {
            const note = await update(...args);
            committed = true;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return note;
          });
        }
        return store;
      },
    });
    const body = { title: "After", body: "After", expectedRevision: 1 };
    const request = () =>
      new Request("http://localhost:3210/api/notes/" + id, {
        method: "PATCH",
        headers: {
          host: "localhost:3210",
          origin: "http://localhost:3210",
          "content-type": "application/json",
          "x-voice-workbench": "1",
        },
        body: JSON.stringify(body),
      });
    const first = api(request());
    await vi.waitFor(() => expect(committed).toBe(true));
    await vi.advanceTimersByTimeAsync(12001);
    const firstResponse = await first;
    expect(firstResponse.status).toBe(504);
    expect(clients[0].closed).toBe(true);
    const replay = await api(request());
    expect(replay.status).toBe(409);
    expect(classifyEditConflict(body, (await replay.json()).current)).toBe(
      "confirmed",
    );
    expect(clients).toHaveLength(2);
    expect(clients[1]).not.toBe(clients[0]);
    expect(clients[1].closed).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    release?.();
    clients.forEach((client) => client.close());
    vi.useRealTimers();
    const child = relative(base, resolve(directory));
    if (!child || child.startsWith("..") || isAbsolute(child))
      throw new Error("Unexpected cleanup path");
    await rm(directory, { recursive: true, force: true }).catch((error) => {
      // Native SQLite may retain a Windows file handle until worker exit.
      if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
    });
  }
});
