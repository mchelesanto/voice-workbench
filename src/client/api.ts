import { z } from "zod";
import {
  apiErrorSchema,
  retryDecision,
  type ErrorCode,
  type RetryOperation,
} from "../shared/responses";
import type { Note, Settings } from "../shared/contracts";
export class ClientError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: ErrorCode,
    public current?: Note | Settings,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: {
    method?: string;
    body?: unknown;
    operation?: RetryOperation;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const body =
    options.body instanceof FormData
      ? options.body
      : options.body === undefined
        ? undefined
        : JSON.stringify(options.body);
  const operation = options.operation ?? (method === "GET" ? "read" : "write");
  const signal = AbortSignal.any([
    AbortSignal.timeout(operation === "model" ? 150000 : 20000),
    ...(options.signal ? [options.signal] : []),
  ]);
  for (let attempt = 0; ; attempt++) {
    try {
      signal.throwIfAborted();
      const response = await fetch(`/api${path}`, {
        method,
        body,
        cache: "no-store",
        signal,
        headers: {
          "X-Voice-Workbench": "1",
          ...(body && !(body instanceof FormData)
            ? { "Content-Type": "application/json" }
            : {}),
        },
      });
      if (response.status === 204) return schema.parse(undefined);
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new ClientError(
          "The response could not be read. Your content is still here.",
          response.status,
        );
      }
      if (!response.ok) {
        const failure = apiErrorSchema.safeParse(value);
        if (failure.success)
          throw new ClientError(
            failure.data.error.message,
            response.status,
            failure.data.error.code,
            failure.data.current,
          );
        throw new ClientError(
          "The request failed. Please try again.",
          response.status,
        );
      }
      const result = schema.safeParse(value);
      if (!result.success)
        throw new ClientError(
          "The response has an unexpected format. Your content is still here.",
        );
      return result.data;
    } catch (e) {
      const error =
        e instanceof ClientError
          ? e
          : new ClientError(
              options.signal?.aborted
                ? "Canceled. The model request may already have incurred a charge."
                : e instanceof DOMException &&
                    ["TimeoutError", "AbortError"].includes(e.name)
                  ? "The request timed out. Please try again manually."
                  : "Unable to connect. Your content stays on this device.",
              undefined,
              e instanceof DOMException ? "request_timeout" : undefined,
            );
      if (
        retryDecision({
          operation,
          attempt,
          status: error.status,
          code: error.code,
          networkFailure: e instanceof TypeError,
        }) === "once_same_payload"
      )
        continue;
      throw error;
    }
  }
}
export function message(error: unknown) {
  return error instanceof ClientError
    ? error.message
    : "Could not save on this device. Download your content, then try again.";
}
export function modelFailureState(error: unknown): "error" | "unknown" {
  if (
    error instanceof ClientError &&
    error.status &&
    error.code &&
    ![
      "request_timeout",
      "request_aborted",
      "provider_timeout",
      "internal_error",
    ].includes(error.code)
  )
    return "error";
  return "unknown";
}
