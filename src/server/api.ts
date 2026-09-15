import "server-only";
import { randomUUID } from "node:crypto";
import { ApiError } from "./errors";
import { guard, readJson, parseInput } from "./http";
import { readTranscription } from "./uploads";
import { withModelSlot } from "./model-slots";
import type { RuntimeConfig } from "./config";
import type { Store } from "./store";
import type { Models } from "./models";
import {
  PROVIDERS,
  LIMITS,
  supportsMode,
  idSchema,
  createNoteSchema,
  editSchema,
  deleteSchema,
  settingsEditSchema,
  enhancementSchema,
  type Provider,
} from "../shared/contracts";

export type RequestLog = {
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  code?: string;
};
export type Dependencies = {
  getConfig: () => RuntimeConfig;
  getStore: () => Store;
  getModels: () => Models;
  log?: (entry: RequestLog) => void;
  modelSlots?: { active: number };
};
const ROUTES = [
  { path: "/api/config", name: "/config", methods: ["GET"] },
  { path: "/api/notes", name: "/notes", methods: ["GET"] },
  { path: "/api/settings", name: "/settings", methods: ["GET", "PUT"] },
  { path: "/api/transcribe", name: "/transcribe", methods: ["POST"] },
  { path: "/api/enhance", name: "/enhance", methods: ["POST"] },
] as const;
const NOTE_ROUTE = {
  name: "/notes/:id",
  methods: ["GET", "PUT", "PATCH", "DELETE"],
} as const;
export function createApi(deps: Dependencies) {
  const slots = deps.modelSlots ?? { active: 0 };
  let prepared: { config: RuntimeConfig; origin: URL } | undefined;
  return async function handle(request: Request): Promise<Response> {
    const requestId = randomUUID(),
      began = Date.now();
    let route = "unknown",
      status = 200,
      code: string | undefined;
    const headers = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-request-id": requestId,
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    };
    try {
      if (!prepared) {
        const config = deps.getConfig();
        prepared = { config, origin: new URL(config.origin) };
      }
      const { config } = prepared;
      const url = guard(request, prepared.origin);
      const normalized = url.pathname.replace(/\/$/, "");
      const match = /^\/api\/notes\/([^/]+)$/.exec(normalized);
      const descriptor = match
        ? NOTE_ROUTE
        : ROUTES.find((item) => item.path === normalized);
      if (!descriptor) throw new ApiError("api_not_found");
      route = descriptor.name;
      if (!(descriptor.methods as readonly string[]).includes(request.method))
        throw new ApiError("method_not_allowed");
      if (
        [...url.searchParams.keys()].some(
          (key) => route !== "/notes" || key !== "cursor",
        ) ||
        url.searchParams.getAll("cursor").length > 1
      )
        throw new ApiError("invalid_input");
      let result: unknown;
      if (route === "/config") {
        result = {
          providers: (Object.keys(PROVIDERS) as Provider[]).map((id) => {
            const definition = PROVIDERS[id];
            return {
              id,
              label: definition.label,
              model: definition.model,
              available: !!config[definition.key],
              smartMode: supportsMode(id, "smart"),
              vocabulary: definition.vocabulary,
            };
          }),
          enhancementAvailable: !!config.mistralKey,
          limits: {
            maxAudioBytes: LIMITS.maxAudioBytes,
            maxRecordingSeconds: LIMITS.maxRecordingSeconds,
            maxEnhanceLength: LIMITS.maxEnhanceLength,
          },
        };
      } else if (route === "/notes") {
        result = await deps
          .getStore()
          .list(url.searchParams.get("cursor") ?? undefined);
      } else if (match) {
        const id = parseInput(idSchema, match[1]);
        if (request.method === "GET") result = await deps.getStore().get(id);
        else {
          const body = await readJson(request);
          if (request.method === "PUT")
            result = await deps
              .getStore()
              .create(id, parseInput(createNoteSchema, body));
          else if (request.method === "PATCH")
            result = await deps
              .getStore()
              .update(id, parseInput(editSchema, body));
          else {
            await deps
              .getStore()
              .delete(id, parseInput(deleteSchema, body).expectedRevision);
            status = 204;
          }
        }
      } else if (route === "/settings") {
        if (request.method === "GET") result = await deps.getStore().settings();
        else {
          const input = parseInput(settingsEditSchema, await readJson(request));
          result = await deps.getStore().saveSettings(input);
        }
      } else {
        result = await withModelSlot(slots, async (lease) => {
          if (route === "/transcribe")
            return deps
              .getModels()
              .transcribe(
                await readTranscription(request),
                request.signal,
                lease,
              );
          const body = await readJson(request);
          if (
            typeof body === "object" &&
            body !== null &&
            "text" in body &&
            typeof body.text === "string" &&
            body.text.length > LIMITS.maxEnhanceLength
          )
            throw new ApiError("enhancement_input_too_long");
          return deps
            .getModels()
            .enhance(
              parseInput(enhancementSchema, body),
              request.signal,
              lease,
            );
        });
      }
      return status === 204
        ? new Response(null, { status, headers })
        : Response.json(result, { status, headers });
    } catch (error) {
      const failure =
        error instanceof ApiError ? error : new ApiError("internal_error");
      status = failure.status;
      code = failure.code;
      return Response.json(
        {
          error: {
            code,
            message: failure.message,
            ...(failure.issues ? { issues: failure.issues } : {}),
          },
          ...(failure.current === undefined
            ? {}
            : { current: failure.current }),
        },
        { status, headers },
      );
    } finally {
      try {
        deps.log?.({
          requestId,
          method: [
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "OPTIONS",
            "HEAD",
          ].includes(request.method)
            ? request.method
            : "unknown",
          route,
          status,
          durationMs: Date.now() - began,
          ...(code ? { code } : {}),
        });
      } catch {
        /* Diagnosefehler ändern keine bestätigten Writes. */
      }
    }
  };
}
