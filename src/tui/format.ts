/**
 * Pure string helpers shared by the TUI transcript and the headless reporter.
 *
 * Deliberately free of pi-tui imports: `-p` runs must not pay for the
 * interactive module graph, and these functions stay trivially unit-testable.
 */

/** Drop an optional unknown into a trimmed string (missing → ""). */
function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/**
 * One-line summary of a tool call — `● bash npm test`, `● read src/a.ts`.
 * Keyed on the argument each tool actually cares about, so the line reads
 * like the command the model asked for rather than the tool's schema name.
 */
export function toolBrief(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case "bash":
      return `bash ${str(a["command"])}`.trimEnd();
    case "read":
    case "write":
    case "edit":
      return `${toolName} ${str(a["path"])}`.trimEnd();
    case "ls":
      return `${toolName} ${str(a["path"])}`.trimEnd();
    case "grep":
      return `${toolName} ${str(a["pattern"])}`.trimEnd();
    case "find":
      return `${toolName} ${str(a["pattern"])}`.trimEnd();
    default:
      return toolName;
  }
}

/** Human duration: `240ms`, `2.4s`, `1m 05s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

/** A compact `path` / `command` / JSON fallback for a tool's arguments. */
export function argsSummary(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const path = str(a["path"]);
  if (path.length > 0) return path;
  const command = str(a["command"]);
  if (command.length > 0) return command;
  const pattern = str(a["pattern"]);
  if (pattern.length > 0) return pattern;
  if (toolName === "load_skill") return str(a["name"]);
  return "";
}

/**
 * A few `+`/`-` lines showing what `write` / `edit` actually changed.
 *
 * Returns raw (unstyled) lines; the caller owns the color so headless output
 * can stay plain. Empty array = nothing worth previewing.
 */
export function diffPreview(
  toolName: string,
  args: unknown,
  details: unknown,
  maxLines = 5,
): string[] {
  if (toolName === "write") {
    const content = str((args as { content?: unknown } | undefined)?.content);
    if (content.length === 0) return [];
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(0, maxLines)
      .map((line) => `+ ${line}`);
  }

  if (toolName === "edit") {
    // `edit` returns a unified diff — the model's own verification artifact.
    const diff = str((details as { diff?: unknown } | undefined)?.diff);
    if (diff.length === 0) return [];
    const hunks = diff
      .split(/\r?\n/)
      .filter((line) => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line));
    return hunks.slice(0, maxLines);
  }

  return [];
}
