import type { Harness } from "../bootstrap.js";
import type { Transcript } from "./transcript.js";

/**
 * Slash commands — `/help`, `/mcp`, `/model`, `/clear`, `/compact`, `/exit`.
 *
 * A command returns the text to print under the prompt ("" = silent); it may
 * also mutate the transcript/status bar directly for commands like `/clear`.
 * Keeping the return value a plain string means the app can render command
 * output through the same `transcript.info()` path as any other notice.
 */
export interface CommandContext {
  harness: Harness;
  transcript: Transcript;
  /** Re-read harness state into the status bar (after `/model`, `/compact`). */
  refresh: () => void;
  /** Leave the TUI with an exit code. */
  quit: (code: number) => void;
}

export interface TuiCommand {
  name: string;
  description: string;
  /** Remaining text after the command name (`/model anthropic/claude-…`). */
  run: (ctx: CommandContext, arg: string) => string | Promise<string>;
}

export const COMMANDS: TuiCommand[] = [
  {
    name: "help",
    description: "List commands",
    run: (_ctx, arg) => {
      const wanted = arg.replace(/^\//, "").trim();
      if (wanted.length > 0) {
        const found = COMMANDS.find((c) => c.name === wanted);
        if (found) return `/${found.name} — ${found.description}`;
        return `No such command: /${wanted}. Try /help.`;
      }
      const lines = COMMANDS.map((c) => `/${c.name.padEnd(9)}${c.description}`);
      return `Commands:\n${lines.join("\n")}`;
    },
  },
  {
    name: "mcp",
    description: "Show MCP server/tool status",
    run: (ctx) => ctx.harness.mcp.formatStatus(),
  },
  {
    name: "model",
    description: "Show or switch the active model (provider/id)",
    run: async (ctx, arg) => {
      const current = `${ctx.harness.model.provider}/${ctx.harness.model.id}`;
      const ref = arg.trim();
      if (ref.length === 0) {
        const available = ctx.harness.models.listAvailable();
        return `model: ${current}\navailable: ${available.join(", ")}`;
      }
      const slash = ref.indexOf("/");
      if (slash <= 0 || slash === ref.length - 1) {
        return `Expected provider/id, got "${ref}". Example: /model anthropic/claude-sonnet-4-5`;
      }
      const resolution = await ctx.harness.models.resolve({
        provider: ref.slice(0, slash),
        model: ref.slice(slash + 1),
      });
      ctx.harness.runtime.setModel(resolution.model);
      ctx.refresh();
      return `model: ${resolution.model.provider}/${resolution.model.id}`;
    },
  },
  {
    name: "clear",
    description: "Clear the visible transcript (session log untouched)",
    run: (ctx) => {
      ctx.transcript.clear();
      return "";
    },
  },
  {
    name: "compact",
    description: "Summarize history to reclaim context",
    run: async (ctx) => {
      const summary = await ctx.harness.runtime.compactNow();
      ctx.refresh();
      return summary;
    },
  },
  {
    name: "exit",
    description: "Quit (Ctrl+D or Ctrl+C twice also work)",
    run: (ctx) => {
      ctx.quit(0);
      return "";
    },
  },
];

/** Split `/model anthropic/…` into `{ name: "model", arg: "anthropic/…" }`. */
export function parseCommand(text: string): { name: string; arg: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const body = trimmed.slice(1);
  const space = body.search(/\s/);
  if (space === -1) return { name: body, arg: "" };
  return { name: body.slice(0, space), arg: body.slice(space + 1).trim() };
}

/** Run a command line; unknown commands come back as a printable message. */
export async function runCommand(text: string, ctx: CommandContext): Promise<string> {
  const parsed = parseCommand(text);
  if (!parsed) return "";
  const command = COMMANDS.find((c) => c.name === parsed.name);
  if (!command) return `Unknown command: /${parsed.name} — try /help`;
  return command.run(ctx, parsed.arg);
}

/** Names offered to the editor's slash autocomplete. */
export const commandNames = COMMANDS.map((command) => ({
  name: command.name,
  description: command.description,
}));
