import "server-only";
import { loadProjectConfig } from "../../scripts/config.mjs";
import { ApiError } from "./errors";
export type RuntimeConfig = ReturnType<typeof loadProjectConfig>;
export function getConfig(): RuntimeConfig {
  try {
    return loadProjectConfig(process.cwd());
  } catch {
    throw new ApiError("configuration_unavailable");
  }
}
