import "server-only";
import { z } from "zod";
import {
  cancelResponseBody,
  readResponseWithSizeLimit,
  DownloadError,
} from "@ai-sdk/provider-utils";
import { LIMITS, MODELS } from "../shared/contracts";
import { ApiError } from "./errors";

export type TextRequest = {
  system: string;
  prompt: string;
  abortSignal: AbortSignal;
};
const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({
          role: z.literal("assistant"),
          content: z.string().nullable(),
          tool_calls: z.array(z.unknown()).nullish(),
          function_call: z.unknown().optional(),
        }),
      }),
    )
    .length(1),
});

export async function fireworksText(
  key: string,
  input: TextRequest,
  fetcher: typeof fetch = fetch,
): Promise<{ text: string }> {
  const response = await fetcher(
    "https://api.fireworks.ai/inference/v1/chat/completions",
    {
      method: "POST",
      redirect: "error",
      signal: input.abortSignal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODELS.enhancement,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt },
        ],
        max_tokens: LIMITS.maxOutputTokens,
        reasoning_effort: "low",
        stream: false,
        n: 1,
      }),
    },
  );
  if (!response.ok) {
    await cancelResponseBody(response);
    // Never retain the upstream body, headers, or credential-bearing request.
    throw Object.assign(new Error("Text provider request failed."), {
      statusCode: response.status,
    });
  }
  if (!response.body) throw new ApiError("enhancement_failed");
  let bytes: Uint8Array;
  try {
    bytes = await readResponseWithSizeLimit({
      response,
      url: "https://api.fireworks.ai/inference/v1/chat/completions",
      maxBytes: 2 * 1024 * 1024,
    });
  } catch (error) {
    if (DownloadError.isInstance(error)) throw new ApiError("output_too_large");
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError("enhancement_failed");
  }
  const parsed = completionSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError("enhancement_failed");
  const choice = parsed.data.choices[0];
  if (
    choice.finish_reason !== "stop" ||
    choice.message.tool_calls?.length ||
    choice.message.function_call != null
  )
    throw new ApiError("enhancement_incomplete");
  if (choice.message.content === null) throw new ApiError("enhancement_failed");
  // Reasoning is intentionally excluded from the public suggestion.
  return {
    text: choice.message.content,
  };
}
