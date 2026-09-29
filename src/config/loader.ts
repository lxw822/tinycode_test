import fs from "node:fs";
import path from "node:path";
import { dataHome, sessionsDir } from "../session/index.js";
import {
  coerceConfig,
  findSecretLookingKeys,
  validateConfig,
  type TinyCodeConfig,
} from "./schema.js";

/**
 * Config loading: `.tinycode/config.json` in the project root, layered under
 * environment variables and CLI flags (callers apply that order).
 *
 * Failure policy: a malformed config degrades to `{}` with warnings — startup
 * must never die because of a typo'd config file.
 */

export interface LoadedConfig {
  config: TinyCodeConfig;
  /** Non-fatal problems (parse errors, schema violations). */
  warnings: string[];
  /** Absolute path of the file that was read, if any. */
  path?: string;
  /** Secret-looking keys found in the committed config file. */
  secretWarnings: string[];
}

export function configPath(projectRoot: string): string {
  return path.join(projectRoot, ".tinycode", "config.json");
}

export function loadConfig(projectRoot: string): LoadedConfig {
  const file = configPath(projectRoot);
  const warnings: string[] = [];
  const secretWarnings: string[] = [];

  if (!fs.existsSync(file)) {
    return { config: {}, warnings, secretWarnings, path: file };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    warnings.push(`Cannot read ${file}: ${(error as Error).message}`);
    return { config: {}, warnings, secretWarnings, path: file };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warnings.push(`Invalid JSON in ${file}: ${(error as Error).message} — using defaults`);
    return { config: {}, warnings, secretWarnings, path: file };
  }

  const schemaErrors = validateConfig(parsed);
  warnings.push(...schemaErrors.map((e) => `${file}: ${e}`));

  for (const key of findSecretLookingKeys(parsed)) {
    secretWarnings.push(
      `${file} contains a secret-looking field "${key}" — this file is meant to be committed; ` +
        `move secrets to environment variables`,
    );
  }

  return { config: coerceConfig(parsed), warnings, secretWarnings, path: file };
}

/**
 * Effective permission mode:
 * CLI flag > TINYCODE_PERMISSION_MODE env > config > "ask".
 */
export function resolvePermissionMode(
  config: TinyCodeConfig,
  env: NodeJS.ProcessEnv = process.env,
  cliFlag?: string,
): "ask" | "auto" {
  if (cliFlag === "ask" || cliFlag === "auto") return cliFlag;
  const fromEnv = env["TINYCODE_PERMISSION_MODE"];
  if (fromEnv === "ask" || fromEnv === "auto") return fromEnv;
  if (config.permissionMode === "auto") return "auto";
  return "ask";
}

/**
 * Model reference precedence:
 * CLI --model > TINYCODE_MODEL env > config > (registry default).
 */
export function resolveModelRef(
  config: TinyCodeConfig,
  env: NodeJS.ProcessEnv = process.env,
  cliFlag?: string,
): { provider?: string; model?: string } {
  const parse = (value: string | undefined): { provider?: string; model?: string } | undefined => {
    if (!value || value.trim().length === 0) return undefined;
    const slash = value.indexOf("/");
    if (slash === -1) return { model: value };
    return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
  };

  const fromConfig = config.model
    ? config.provider
      ? `${config.provider}/${config.model}`
      : config.model
    : undefined;

  return parse(cliFlag) ?? parse(env["TINYCODE_MODEL"]) ?? parse(fromConfig) ?? {};
}

export { dataHome, sessionsDir };
