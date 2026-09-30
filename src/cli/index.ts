#!/usr/bin/env node
import path from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { parseArgs, HELP_TEXT, type CliArgs } from "./args.js";
import { bootstrapHarness, type Harness } from "../bootstrap.js";
import { loadConfig, resolveModelRef, resolvePermissionMode } from "../config/loader.js";
import { ModelRegistry } from "../model/registry.js";
import { loadMockScriptFile } from "../model/mock-script.js";
import { TINYCODE_VERSION } from "../agent/prompt.js";

/**
 * Headless (`-p`) semantics — the safety story:
 *
 *   there is no dialog to answer, so ASK-level operations are DENIED by
 *   default. Unattended writes require an explicit --permission-mode auto
 *   (or TINYCODE_PERMISSION_MODE=auto). The permission manager's
 *   default-deny branch does the work; the CLI just omits the prompt hook.
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
  /** Injected harness for in-process tests; bootstrap is skipped when set. */
  harness?: Harness;
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
      // No permissionPrompt here: headless ASK → deny is the design.
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
  // The full-screen TUI is a later milestone; for the core slice the
  // interactive entry reports what would happen instead of hanging a test.
  err(
    'interactive TUI is not part of the core slice yet — use `tinycode -p "prompt"` ' +
      "(or set TINYCODE_MODEL=mock for offline runs)",
  );
  await harness.shutdown();
  return { text: "", exitCode: 0, harness };
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
