#!/usr/bin/env node
import path from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { parseArgs, HELP_TEXT, type CliArgs } from "./args.js";
import { bootstrapHarness, type Harness } from "../bootstrap.js";
import { loadConfig, resolveModelRef, resolvePermissionMode } from "../config/loader.js";
import { ModelRegistry } from "../model/registry.js";
import { loadMockScriptFile } from "../model/mock-script.js";
import { TINYCODE_VERSION } from "../agent/prompt.js";
import { PermissionBridge } from "../tui/permission-bridge.js";
import type { TuiApp } from "../tui/app.js";
import type { Terminal } from "@earendil-works/pi-tui";

/**
 * Headless (`-p`) semantics — the safety story:
 *
 *   there is no dialog to answer, so ASK-level operations are DENIED by
 *   default. Unattended writes require an explicit --permission-mode auto
 *   (or TINYCODE_PERMISSION_MODE=auto). The permission manager's
 *   default-deny branch does the work; the CLI just omits the prompt hook.
 *
 * Interactive mode inverts only the presentation: a PermissionBridge is
 * handed to bootstrap *before* any TUI object exists, then pointed at the
 * overlay dialog once the app is up. No TTY at all → print and exit 0.
 */

export interface RunResult {
  text: string;
  exitCode: number;
  harness?: Harness;
}

export interface RunCliOptions {
  argv: string[];
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /**
   * Injected harness for in-process tests; bootstrap is skipped when set — and
   * with it the permission-prompt wiring, so the caller owns that.
   */
  harness?: Harness;
  /**
   * Injected terminal for the interactive path (tests). When set, the TTY
   * check is skipped.
   */
  terminal?: Terminal;
  /** Observe the constructed app before it enters the alternate screen. */
  onTui?: (app: TuiApp) => void;
}

function lineWriter(sink: ((line: string) => void) | undefined) {
  return (line: string) => {
    if (sink) sink(line.endsWith("\n") ? line.slice(0, -1) : line);
    else process.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
  };
}

/** Collect assistant text + tool activity from agent events. */
function attachReporter(
  harness: Harness,
  onText: (line: string) => void,
  onTool: (line: string) => void,
): void {
  let streaming = false;
  let deltaSeen = false;
  harness.runtime.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "message_start": {
        const message = event.message as { role: string };
        if (message.role === "assistant") {
          streaming = true;
          deltaSeen = false;
        }
        break;
      }
      case "message_update": {
        if (!streaming) break;
        const ev = event as unknown as {
          assistantMessageEvent: { type: string; delta?: string };
        };
        if (ev.assistantMessageEvent.type === "text_delta") {
          deltaSeen = true;
          onText(ev.assistantMessageEvent.delta ?? "");
        }
        break;
      }
      case "message_end": {
        streaming = false;
        const message = event.message as {
          role: string;
          content: Array<{ type: string; text?: string; name?: string }>;
        };
        if (message.role === "assistant" && !deltaSeen) {
          // Provider emitted no deltas — fall back to the finalized text so
          // output is never silently empty (deltas already covered the rest).
          const text = message.content
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("");
          if (text.length > 0) onText(text);
        }
        break;
      }
      case "tool_execution_start": {
        const ev = event as unknown as { toolName: string; args: unknown };
        const brief =
          ev.toolName === "bash"
            ? `bash ${String((ev.args as { command?: string })?.command ?? "")}`
            : ev.toolName === "read" || ev.toolName === "write" || ev.toolName === "edit"
              ? `${ev.toolName} ${String((ev.args as { path?: string })?.path ?? "")}`
              : ev.toolName;
        onTool(`● ${brief}`);
        break;
      }
      case "tool_execution_end": {
        const ev = event as unknown as { toolName: string; isError: boolean };
        onTool(ev.isError ? `  ✗ ${ev.toolName} failed` : `  ✓ ${ev.toolName}`);
        break;
      }
      default:
        break;
    }
  });
}

export async function runCli(options: RunCliOptions): Promise<RunResult> {
  const out = lineWriter(options.stdout);
  const err = lineWriter(options.stderr);
  const cwd = options.cwd ?? process.cwd();
  const args: CliArgs = parseArgs(options.argv);

  if (args.mode === "help") {
    out(HELP_TEXT);
    return { text: HELP_TEXT, exitCode: 0 };
  }
  if (args.mode === "version") {
    out(`tinycode ${TINYCODE_VERSION}`);
    return { text: `tinycode ${TINYCODE_VERSION}`, exitCode: 0 };
  }
  if (args.errors.length > 0) {
    for (const e of args.errors) err(e);
    return { text: args.errors.join("\n"), exitCode: 2 };
  }

  const wantsTui = args.mode === "interactive" && !args.mcpStatus;

  // Bail before touching config/session/model state: there is nothing to draw
  // on and nothing to resume. `-p` is the documented alternative.
  if (
    wantsTui &&
    options.terminal === undefined &&
    (!process.stdin.isTTY || !process.stdout.isTTY)
  ) {
    err(
      'interactive mode requires a TTY — use `tinycode -p "prompt"` for headless runs ' +
        "(set TINYCODE_MODEL=mock for offline runs)",
    );
    return { text: "", exitCode: 0 };
  }

  // The bridge must exist before bootstrap: that is where the prompt hook is
  // injected. It stays deny-only until the TUI points it at the dialog.
  const bridge = wantsTui ? new PermissionBridge() : undefined;

  const projectRoot = args.projectRoot ?? cwd;
  const config = loadConfig(projectRoot);
  for (const warning of config.warnings) err(`warning: ${warning}`);
  for (const warning of config.secretWarnings) err(`warning: ${warning}`);

  const modelRef = resolveModelRef(config.config, process.env, args.model);
  const permissionMode = resolvePermissionMode(config.config, process.env, args.permissionMode);

  // Session policy: headless runs stay ephemeral unless explicitly resumed;
  // interactive runs always own a session from message one.
  const session =
    args.sessionId !== undefined
      ? ({ mode: "attach", id: args.sessionId } as const)
      : args.mode === "print"
        ? undefined
        : ({ mode: "new" } as const);

  const models = new ModelRegistry();
  if (modelRef.model === "mock" || process.env["TINYCODE_MODEL"] === "mock") {
    models.enableMock();
    const scriptPath = process.env["TINYCODE_MOCK_SCRIPT"];
    if (scriptPath) {
      models.getMockHandle()?.setResponses(loadMockScriptFile(scriptPath));
    }
  }

  const harness =
    options.harness ??
    (await bootstrapHarness({
      projectRoot,
      config: config.config,
      modelRef,
      models,
      permissionMode,
      ...(session ? { session } : {}),
      // Headless runs omit this → ASK degrades to deny (the safety contract).
      // Interactive runs hand over the bridge, which answers deny until the
      // TUI attaches the dialog.
      ...(bridge ? { permissionPrompt: bridge.prompt } : {}),
    }));

  if (harness.isMock) {
    err("MOCK mode: scripted offline model, no network in use");
  }

  // ---- MCP status mode ----------------------------------------------------
  if (args.mcpStatus) {
    const status = harness.mcp.formatStatus();
    out(status);
    await harness.shutdown();
    return { text: status, exitCode: 0, harness };
  }

  // ---- One-shot mode ------------------------------------------------------
  if (args.mode === "print") {
    if (!args.prompt) {
      err("-p requires a prompt");
      await harness.shutdown();
      return { text: "", exitCode: 2 };
    }

    let acc = "";
    attachReporter(
      harness,
      (delta) => {
        acc += delta;
      },
      (line) => err(line),
    );

    let failure: unknown;
    try {
      await harness.runtime.prompt(args.prompt);
      await harness.runtime.waitForIdle();
    } catch (error) {
      failure = error;
    }

    await harness.shutdown();

    if (failure) {
      err(`error: ${(failure as Error).message}`);
      return { text: acc, exitCode: 1, harness };
    }
    out(acc.trim());
    return { text: acc.trim(), exitCode: 0, harness };
  }

  // ---- Interactive mode ---------------------------------------------------
  // The TUI module is imported lazily so `-p` runs never pay for it.
  const { TuiApp } = await import("../tui/app.js");
  const { ProcessTerminal } = await import("@earendil-works/pi-tui");
  const terminal = options.terminal ?? new ProcessTerminal();

  const app = new TuiApp({
    harness,
    terminal,
    projectRoot,
    greeting: `tinycode ${TINYCODE_VERSION} — /help for commands`,
    ...(bridge ? { bridge } : {}),
  });
  options.onTui?.(app);

  const exitCode = await app.run();
  await harness.shutdown();
  return { text: "", exitCode, harness };
}

/** Process entry: never throws; maps failures to exit codes. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const result = await runCli({ argv });
    return result.exitCode;
  } catch (error) {
    process.stderr.write(`fatal: ${(error as Error).message}\n`);
    return 1;
  }
}

// Only run when executed directly (not when imported by tests):
// compare the resolved entry URL, not string suffixes.
import { pathToFileURL } from "node:url";

const invokedDirectly =
  process.argv[1] !== undefined &&
  (() => {
    try {
      return import.meta.url === pathToFileURL(path.resolve(process.argv[1]!)).href;
    } catch {
      return false;
    }
  })();

if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}
