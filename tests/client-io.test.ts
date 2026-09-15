import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { request, ClientError, modelFailureState } from "../src/client/api";
import { filename, markdown } from "../src/client/export";
afterEach(() => vi.unstubAllGlobals());
it("distinguishes definitive model failures from an unknown interrupted outcome", () => {
  expect(
    modelFailureState(new ClientError("Bad format", 415, "unsupported_audio")),
  ).toBe("error");
  expect(modelFailureState(new ClientError("Busy", 429, "busy"))).toBe("error");
  expect(
    modelFailureState(new ClientError("Timeout", 504, "provider_timeout")),
  ).toBe("unknown");
  expect(modelFailureState(new TypeError("Network"))).toBe("unknown");
});
it("retries a failed save once with exactly the same payload and headers", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("network"))
    .mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", fetch);
  await request("/notes/test", z.object({ ok: z.boolean() }), {
    method: "PATCH",
    body: { body: "Preserve me", expectedRevision: 3 },
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
  expect(fetch.mock.calls[0][1].headers).toMatchObject({
    "X-Voice-Workbench": "1",
    "Content-Type": "application/json",
  });
});
it("never retries a billable model request or silently accepts malformed success", async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError("network"));
  vi.stubGlobal("fetch", fetch);
  await expect(
    request("/enhance", z.string(), {
      operation: "model",
      method: "POST",
      body: {},
    }),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValue(new Response(JSON.stringify({ unexpected: true })));
  await expect(request("/notes", z.array(z.string()))).rejects.toThrow(
    "unexpected format",
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("ends a write after two retryable failures even if a third attempt would succeed", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("network"))
    .mockRejectedValueOnce(new TypeError("network"))
    .mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", fetch);
  await expect(
    request("/notes/test", z.object({ ok: z.boolean() }), {
      method: "PATCH",
      body: { body: "Keep me" },
    }),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("keeps raw text literal and quotes frontmatter without unsafe filenames", () => {
  const title = 'é../My note:\n"injected"';
  expect(filename(title)).toBe("e-my-note-injected.md");
  expect(filename("x".repeat(200))).toHaveLength(79);
  const exported = markdown(
    { title, body: "<script>literal</script>" },
    "2026-09-15",
  );
  expect(exported).toContain(`title: ${JSON.stringify(title)}\n`);
  expect(exported).toContain("<script>literal</script>");
});
