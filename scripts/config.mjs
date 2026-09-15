import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
export class ConfigurationError extends Error {
  /** @param {string} field */
  constructor(field) {
    super(`Project configuration is missing or invalid: ${field}`);
    this.name = "ConfigurationError";
  }
}
/** @param {string} value */
export function validateOrigin(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.port !== "3210" ||
      url.origin !== value ||
      url.username ||
      url.password
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new ConfigurationError("APP_ORIGIN (http://localhost:3210)");
  }
}
export const CONFIG_KEYS = [
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "MISTRAL_API_KEY",
  "APP_ORIGIN",
];
/** @param {string} root @param {boolean} required */
export function readProjectEnvironment(root, required = true) {
  for (const name of [
    ".env",
    ".env.production",
    ".env.production.local",
    ".env.development",
    ".env.development.local",
    ".env.test",
    ".env.test.local",
  ]) {
    if (existsSync(join(root, name)))
      throw new ConfigurationError(
        "Only .env.local is allowed; remove the additional environment file.",
      );
  }
  if (!required && !existsSync(join(root, ".env.local"))) return {};
  let values;
  try {
    values = parseEnv(readFileSync(join(root, ".env.local"), "utf8"));
  } catch {
    throw new ConfigurationError(".env.local");
  }
  if (Object.keys(values).some((key) => !CONFIG_KEYS.includes(key)))
    throw new ConfigurationError(".env.local contains unknown keys.");
  return values;
}
/** @param {string} root */
export function loadProjectConfig(root) {
  const values = readProjectEnvironment(root);
  for (const name of ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "APP_ORIGIN"])
    if (!values[name]?.trim()) throw new ConfigurationError(name);
  const databaseUrl = values.TURSO_DATABASE_URL;
  const databaseToken = values.TURSO_AUTH_TOKEN;
  const origin = values.APP_ORIGIN;
  if (!databaseUrl || !databaseToken || !origin)
    throw new ConfigurationError(".env.local");
  try {
    const url = new URL(databaseUrl);
    if (
      !["libsql:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/")
    )
      throw new Error();
  } catch {
    throw new ConfigurationError("TURSO_DATABASE_URL");
  }
  return {
    origin: validateOrigin(origin),
    databaseUrl,
    databaseToken,
    googleKey: values.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || "",
    mistralKey: values.MISTRAL_API_KEY?.trim() || "",
  };
}
/** @param {ReturnType<typeof loadProjectConfig>} config @param {NodeJS.ProcessEnv} inherited */
export function applicationEnvironment(config, inherited) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...inherited,
    TURSO_DATABASE_URL: config.databaseUrl,
    TURSO_AUTH_TOKEN: config.databaseToken,
    GOOGLE_GENERATIVE_AI_API_KEY: config.googleKey,
    MISTRAL_API_KEY: config.mistralKey,
    APP_ORIGIN: config.origin,
  };
  delete env.TURSO_API_KEY;
  // Do not inherit automatically exposed secrets from the parent shell.
  for (const key of Object.keys(env))
    if (key.startsWith("NEXT_PUBLIC_")) delete env[key];
  return env;
}

/** @param {string} root @param {NodeJS.ProcessEnv} inherited */
export function buildEnvironment(root, inherited) {
  readProjectEnvironment(root, false);
  // Explicit empty values prevent Next from reloading real credentials.
  return applicationEnvironment(
    {
      databaseUrl: "",
      databaseToken: "",
      googleKey: "",
      mistralKey: "",
      origin: "http://localhost:3210",
    },
    inherited,
  );
}
