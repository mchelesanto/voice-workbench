import { describe, it, expect, vi } from "vitest";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { migrate } from "../scripts/migrations.mjs";
import { Store } from "../src/server/store";
import { createModels } from "../src/server/models";
import { withBoundedBody } from "../src/server/http";
import { createApi } from "../src/server/api";
const config = {
  origin: "http://localhost:3210",
  databaseUrl: "libsql://example.turso.io",
  databaseToken: "fixture",
  googleKey: "fixture",
  mistralKey: "fixture",
};
describe("Exact contract boundaries", () => {
  it("preserves Unicode on subsequent cursor pages", async () => {
    const db = createClient({ url: ":memory:" });
    try {
      await migrate(db, "db/migrations");
      const store = new Store(db),
        id = randomUUID();
      const data = {
        title: "Notiz",
        body: "Text",
        originalText: "Original",
        provider: "google" as const,
        model: "gemini-3.5-transcribe",
        mode: "verbatim" as const,
        durationMs: 1,
      };
      await store.create(id, { ...data, body: "a".repeat(139) + "😀Z" });
      for (let i = 0; i < 50; i++) await store.create(randomUUID(), data);
      await db.execute(
        "UPDATE notes SET updated_at='2026-02-01T00:00:00.000Z'",
      );
      await db.execute({
        sql: "UPDATE notes SET updated_at='2026-01-01T00:00:00.000Z' WHERE id=?",
        args: [id],
      });
      const first = await store.list();
      expect(first.items).toHaveLength(50);
      const next = await store.list(first.nextCursor!);
      expect(next.items).toHaveLength(1);
      const text = next.items[0].preview;
      expect(text.isWellFormed()).toBe(true);
      expect([...text]).toHaveLength(140);
      expect(text.endsWith("😀")).toBe(true);
    } finally {
      db.close();
    }
  });
  it.each([
    [403, "provider_auth_failed"],
    [408, "provider_timeout"],
  ] as const)(
    "klassifiziert Anbieterstatus %s in beiden Modellpfaden",
    async (statusCode, code) => {
      const rejected = () =>
        Promise.reject(
          Object.assign(new Error("Synthetischer Anbieterfehler"), {
            statusCode,
          }),
        );
      const service = createModels(config, {
        transcribe: rejected,
        generateText: rejected,
      });
      await expect(
        service.transcribe(
          {
            provider: "google",
            mode: "verbatim",
            vocabulary: [],
            audio: new Uint8Array(44),
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code });
      await expect(
        service.enhance(
          { text: "Text", preset: "clean" },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code });
    },
  );
  it("accepts exactly the allowed chunk count", async () => {
    let n = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
        if (++n === 3) controller.close();
      },
    });
    const request = new Request(config.origin, {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    const data = await withBoundedBody(
      request,
      100,
      (body) => new Response(body).arrayBuffer(),
      1000,
      3,
    );
    expect(data.byteLength).toBe(3);
  });
  it("accepts 12000 UTF-16 units and rejects 12001 before calling the model", async () => {
    const enhance = vi.fn().mockResolvedValue({
      text: "Vorschlag",
      provider: "mistral",
      model: "mistral-small-latest",
      preset: "clean",
    });
    const api = createApi({
      getConfig: () => config,
      getStore: vi.fn(),
      getModels: () => ({ transcribe: vi.fn(), enhance }),
    });
    const request = (text: string) =>
      new Request(config.origin + "/api/enhance", {
        method: "POST",
        headers: {
          host: "localhost:3210",
          origin: config.origin,
          "x-voice-workbench": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ text, preset: "clean" }),
      });
    expect((await api(request("a".repeat(12000)))).status).toBe(200);
    expect((await api(request("😀".repeat(6000)))).status).toBe(200);
    const over = await api(request("a".repeat(12001)));
    expect(over.status).toBe(400);
    expect((await over.json()).error.code).toBe("enhancement_input_too_long");
    expect(enhance).toHaveBeenCalledTimes(2);
  });
});
