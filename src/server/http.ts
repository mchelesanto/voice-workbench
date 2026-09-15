import "server-only";
import { z } from "zod";
import { ApiError } from "./errors";
import { LIMITS } from "../shared/contracts";

export function guard(request: Request, expected: URL): URL {
  const url = new URL(request.url);
  if (
    request.headers.get("host") !== expected.host ||
    url.host !== expected.host
  )
    throw new ApiError("forbidden_origin");
  const supplied = request.headers.get("origin");
  if (supplied !== null && supplied !== expected.origin)
    throw new ApiError("forbidden_origin");
  const site = request.headers.get("sec-fetch-site");
  if (
    site === "cross-site" ||
    (site === "same-site" && supplied !== expected.origin)
  )
    throw new ApiError("forbidden_origin");
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    (supplied !== expected.origin ||
      request.headers.get("x-voice-workbench") !== "1")
  )
    throw new ApiError("forbidden_origin");
  return url;
}
export function requireType(request: Request, expected: string) {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() !== expected
  )
    throw new ApiError("unsupported_content_type");
}
export async function withBoundedBody<T>(
  request: Request,
  maximum: number,
  consume: (body: ReadableStream<Uint8Array>) => Promise<T>,
  timeoutMs: number = LIMITS.bodyTimeoutMs,
  maximumChunks: number = LIMITS.maxBodyChunks,
): Promise<T> {
  const length = request.headers.get("content-length");
  let early: ApiError | undefined;
  if (
    length !== null &&
    (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))
  )
    early = new ApiError("invalid_input");
  else if (length !== null && Number(length) > maximum)
    early = new ApiError("request_too_large");
  else if (request.signal.aborted) early = new ApiError("request_aborted");
  if (early) {
    void request.body?.cancel().catch(() => {});
    throw early;
  }
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  let fault: ApiError | undefined;
  let total = 0,
    chunks = 0;
  const source =
    request.body ??
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  const limited = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        chunks++;
        if (total > maximum || chunks > maximumChunks) {
          fault = new ApiError(
            total > maximum ? "request_too_large" : "request_too_fragmented",
          );
          throw fault;
        }
        controller.enqueue(chunk);
      },
    }),
    { signal },
  );
  try {
    return await consume(limited);
  } catch (error) {
    if (fault) throw fault;
    if (signal.aborted)
      throw new ApiError(
        request.signal.aborted ? "request_aborted" : "request_timeout",
      );
    throw error;
  } finally {
    clearTimeout(timeout);
    // Beendet auch einen Parser, der bereits vor dem vollständigen Lesen abgebrochen ist.
    deadline.abort();
    if (!limited.locked) void limited.cancel().catch(() => {});
  }
}
export async function readBody(
  request: Request,
  maximum: number,
  timeoutMs: number = LIMITS.bodyTimeoutMs,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await withBoundedBody(
      request,
      maximum,
      async (body) => new Uint8Array(await new Response(body).arrayBuffer()),
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("request_aborted");
  }
}
export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(
      "invalid_input",
      undefined,
      result.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.map(String),
        reason: issue.code,
      })),
    );
  return result.data;
}
export async function readJson(request: Request): Promise<unknown> {
  requireType(request, "application/json");
  const bytes = await readBody(request, LIMITS.maxJsonBytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError("invalid_input");
  }
}
