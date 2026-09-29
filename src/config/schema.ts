/** TinyCode config file schema (.tinycode/config.json — all keys optional). */

export interface ContextConfig {
  /** Compact when estimated tokens exceed this. */
  compactAboveTokens?: number;
  /** Newest messages kept verbatim through compaction. */
  keepRecentMessages?: number;
  /** Per-tool-result truncation threshold (chars). */
  maxToolResultChars?: number;
}

export type PermissionModeConfig = "ask" | "auto";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface TinyCodeConfig {
  provider?: string;
  model?: string;
  maxOutputTokens?: number;
  permissionMode?: PermissionModeConfig;
  context?: ContextConfig;
  mcpServers?: Record<string, McpServerConfig>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validate a parsed config object. Returns a list of human-readable problems;
 * an empty list means the config is usable. Unknown keys are tolerated (a
 * newer config on an older binary should not brick startup).
 */
export function validateConfig(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["config must be a JSON object"];

  const str = (key: string) => {
    const v = value[key];
    if (v !== undefined && typeof v !== "string") errors.push(`${key} must be a string`);
  };
  str("provider");
  str("model");

  if (value["maxOutputTokens"] !== undefined && typeof value["maxOutputTokens"] !== "number") {
    errors.push("maxOutputTokens must be a number");
  }
  if (
    value["permissionMode"] !== undefined &&
    value["permissionMode"] !== "ask" &&
    value["permissionMode"] !== "auto"
  ) {
    errors.push('permissionMode must be "ask" or "auto"');
  }
  if (value["context"] !== undefined) {
    if (!isRecord(value["context"])) errors.push("context must be an object");
    else {
      for (const key of ["compactAboveTokens", "keepRecentMessages", "maxToolResultChars"]) {
        const v = value["context"][key];
        if (v !== undefined && typeof v !== "number")
          errors.push(`context.${key} must be a number`);
      }
    }
  }
  if (value["mcpServers"] !== undefined) {
    if (!isRecord(value["mcpServers"])) errors.push("mcpServers must be an object");
    else {
      for (const [name, entry] of Object.entries(value["mcpServers"])) {
        if (!isRecord(entry) || typeof entry["command"] !== "string") {
          errors.push(`mcpServers.${name} must be { command: string, args?: string[] }`);
        }
      }
    }
  }
  return errors;
}

/** Coerce a validated object into the typed config (defaults applied later). */
export function coerceConfig(value: unknown): TinyCodeConfig {
  if (!isRecord(value)) return {};
  const config: TinyCodeConfig = {};
  if (typeof value["provider"] === "string") config.provider = value["provider"];
  if (typeof value["model"] === "string") config.model = value["model"];
  if (typeof value["maxOutputTokens"] === "number")
    config.maxOutputTokens = value["maxOutputTokens"];
  if (value["permissionMode"] === "ask" || value["permissionMode"] === "auto") {
    config.permissionMode = value["permissionMode"];
  }
  if (isRecord(value["context"])) {
    const ctx: ContextConfig = {};
    for (const key of ["compactAboveTokens", "keepRecentMessages", "maxToolResultChars"] as const) {
      const v = value["context"][key];
      if (typeof v === "number") ctx[key] = v;
    }
    config.context = ctx;
  }
  if (isRecord(value["mcpServers"])) {
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, entry] of Object.entries(value["mcpServers"])) {
      if (isRecord(entry) && typeof entry["command"] === "string") {
        servers[name] = {
          command: entry["command"],
          ...(Array.isArray(entry["args"]) && entry["args"].every((a) => typeof a === "string")
            ? { args: entry["args"] as string[] }
            : {}),
          ...(isRecord(entry["env"]) ? { env: entry["env"] as Record<string, string> } : {}),
        };
      }
    }
    config.mcpServers = servers;
  }
  return config;
}

/** Fields that look like secrets (startup warns when found in config). */
export const SECRET_LOOKING_KEYS = [
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
  "credential",
  "authorization",
];

export function findSecretLookingKeys(value: unknown, prefix = ""): string[] {
  if (!isRecord(value)) return [];
  const found: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (SECRET_LOOKING_KEYS.some((s) => key.toLowerCase().includes(s))) {
      found.push(path);
    }
    found.push(...findSecretLookingKeys(entry, path));
  }
  return found;
}
