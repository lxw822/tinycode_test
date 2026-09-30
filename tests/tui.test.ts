import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import {
  TuiAltScreen,
  stripTerminalSequences,
  visibleWidth,
  type Terminal,
} from "@earendil-works/pi-tui";
import { bootstrapHarness, type Harness } from "../src/bootstrap.js";
import { ModelRegistry } from "../src/model/registry.js";
import { runCli, type RunResult } from "../src/cli/index.js";
import type { PermissionAnswer, PermissionRequest } from "../src/permissions/manager.js";
import type { TuiApp } from "../src/tui/app.js";
import {
  COMMANDS,
  commandNames,
  parseCommand,
  runCommand,
  type CommandContext,
} from "../src/tui/commands.js";
import { argsSummary, diffPreview, formatDuration, toolBrief } from "../src/tui/format.js";
import { LoaderHost } from "../src/tui/loader-host.js";
import { PermissionBridge } from "../src/tui/permission-bridge.js";
import { askPermission, renderPermissionDialog } from "../src/tui/permission-dialog.js";
import { StatusBar, formatTokens } from "../src/tui/status-bar.js";
import { Transcript } from "../src/tui/transcript.js";
import { withNonTTY } from "./tty.js";

/**
 * M12 — the full-screen TUI (ARCHITECTURE §11), fully offline.
 *
 * Two layers are covered:
 *
 *   1. Components driven directly (`render(width)`), which is where the
 *      event → visual mapping lives and where assertions are cheapest.
 *   2. `TuiApp` end-to-end through `runCli`, with a `FakeTerminal` standing in
 *      for the process terminal and the faux mock model standing in for a
 *      provider. Keys are injected as raw escape sequences — the exact bytes a
 *      real terminal sends — so the whole input pipeline (viewport listener →
 *      app keybindings → focused component) is exercised, not just our code.
 *
 * Every run uses `--model mock`; ambient config env is neutralized first.
 */

// --- env isolation ------------------------------------------------------------
const ENV_KEYS = [
  "TINYCODE_HOME",
  "TINYCODE_MODEL",
  "TINYCODE_PERMISSION_MODE",
  "TINYCODE_MOCK_SCRIPT",
] as const;
const savedEnv = new Map<string, string | undefined>();
let home = "";

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  delete process.env["TINYCODE_MODEL"];
  delete process.env["TINYCODE_PERMISSION_MODE"];
  delete process.env["TINYCODE_MOCK_SCRIPT"];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tinycode-tui-home-"));
  process.env["TINYCODE_HOME"] = home;
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

// --- fakes & helpers ----------------------------------------------------------
/** A terminal that records writes and lets tests inject raw key bytes. */
class FakeTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  started = false;
  readonly writes: string[] = [];
  private onInput?: (data: string) => void;

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.onInput = onInput;
    this.started = true;
  }

  stop(): void {
    this.onInput = undefined;
    this.started = false;
  }

  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  input(data: string): void {
    this.onInput?.(data);
  }

  /** Everything written so far, with escape sequences removed. */
  get screen(): string {
    return stripTerminalSequences(this.writes.join(""));
  }
}

/** Render a component and strip its styling so assertions read as plain text. */
function rendered(component: { render(width: number): string[] }, width = 80): string {
  return stripTerminalSequences(component.render(width).join("\n"));
}

function typeText(terminal: FakeTerminal, text: string): void {
  for (const character of text) terminal.input(character);
}

async function until(
  predicate: () => boolean,
  label = "condition",
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Await `work`, but never hang the suite if it cannot finish. */
async function withTimeout<T>(work: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- synthetic agent events ---------------------------------------------------
type Loose = Record<string, unknown>;

const messageStart = (): AgentEvent =>
  ({ type: "message_start", message: { role: "assistant", content: [] } }) as unknown as AgentEvent;

const textDelta = (delta: string): AgentEvent =>
  ({
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: null },
  }) as unknown as AgentEvent;

const messageEnd = (text: string): AgentEvent =>
  ({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
  }) as unknown as AgentEvent;

const toolStart = (id: string, name: string, args: Loose): AgentEvent =>
  ({ type: "tool_execution_start", toolCallId: id, toolName: name, args }) as unknown as AgentEvent;

const toolEnd = (
  id: string,
  name: string,
  details: Loose,
  options: { isError?: boolean; content?: string } = {},
): AgentEvent =>
  ({
    type: "tool_execution_end",
    toolCallId: id,
    toolName: name,
    isError: options.isError ?? false,
    result: { content: [{ type: "text", text: options.content ?? "" }], details },
  }) as unknown as AgentEvent;

function makeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    toolName: "write",
    args: { path: ".env", content: "SECRET=1" },
    reason: "ask-mode write",
    pattern: "write:.env",
    risk: "creates a new file",
    ...overrides,
  };
}

// --- 1. format helpers ---------------------------------------------------------
describe("tui format helpers", () => {
  it("summarizes tool calls by the argument each tool cares about", () => {
    expect(toolBrief("bash", { command: "npm test" })).toBe("bash npm test");
    expect(toolBrief("read", { path: "src/a.ts" })).toBe("read src/a.ts");
    expect(toolBrief("write", { path: "out.txt" })).toBe("write out.txt");
    expect(toolBrief("edit", { path: "src/a.ts" })).toBe("edit src/a.ts");
    expect(toolBrief("grep", { pattern: "TODO" })).toBe("grep TODO");
    expect(toolBrief("find", { pattern: "*.ts" })).toBe("find *.ts");
    expect(toolBrief("ls", { path: "src" })).toBe("ls src");
    // Unknown/MCP/sub-agent tools fall back to their bare name.
    expect(toolBrief("spawn_agent", { task: "x" })).toBe("spawn_agent");
  });

  it("formats durations at human granularity", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(240)).toBe("240ms");
    expect(formatDuration(2400)).toBe("2.4s");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(-1)).toBe("0ms");
  });

  it("previews the lines write/edit actually changed", () => {
    const write = diffPreview("write", { path: "a.txt", content: "one\ntwo\n" }, {});
    expect(write).toEqual(["+ one", "+ two"]);

    const edit = diffPreview(
      "edit",
      { path: "a.ts" },
      { diff: "--- a\n+++ b\n context\n-old line\n+new line\n" },
    );
    expect(edit).toEqual(["-old line", "+new line"]);

    // Tools without a diffable payload stay quiet.
    expect(diffPreview("bash", { command: "ls" }, { exitCode: 0 })).toEqual([]);
  });

  it("picks a compact argument summary for the dialog header", () => {
    expect(argsSummary("write", { path: ".env" })).toBe(".env");
    expect(argsSummary("bash", { command: "rm -rf build" })).toBe("rm -rf build");
    expect(argsSummary("grep", { pattern: "TODO" })).toBe("TODO");
    expect(argsSummary("spawn_agent", {})).toBe("");
  });
});

// --- 2. transcript --------------------------------------------------------------
describe("Transcript", () => {
  let transcript: Transcript;
  let changes: number;

  beforeEach(() => {
    changes = 0;
    transcript = new Transcript(() => {
      changes += 1;
    });
  });

  it("streams text deltas live, then finalizes into Markdown", () => {
    transcript.applyEvent(messageStart());
    transcript.applyEvent(textDelta("Hello "));
    transcript.applyEvent(textDelta("world"));
    expect(rendered(transcript)).toContain("Hello world");

    transcript.applyEvent(messageEnd("Hello world"));
    expect(rendered(transcript)).toContain("Hello world");
    expect(changes).toBeGreaterThan(0);
  });

  it("falls back to the finalized text when a provider emits no deltas", () => {
    transcript.applyEvent(messageStart());
    transcript.applyEvent(messageEnd("no deltas at all"));
    expect(rendered(transcript)).toContain("no deltas at all");
  });

  it("renders a user turn with the prompt marker", () => {
    transcript.addUser("fix the build");
    expect(rendered(transcript)).toContain("❯ fix the build");
  });

  it("renders tool start/end with duration and exit code", () => {
    transcript.applyEvent(toolStart("t1", "bash", { command: "npm test" }));
    transcript.applyEvent(toolEnd("t1", "bash", { exitCode: 0, durationMs: 2400 }));

    const out = rendered(transcript);
    expect(out).toContain("● bash npm test");
    expect(out).toContain("✓ exit 0 · 2.4s");
  });

  it("previews write and edit diffs below the result line", () => {
    transcript.applyEvent(toolStart("t2", "write", { path: "a.txt", content: "alpha\nbeta" }));
    transcript.applyEvent(toolEnd("t2", "write", { added: 2, removed: 0 }));
    expect(rendered(transcript)).toContain("+ alpha");
    expect(rendered(transcript)).toContain("+ beta");

    transcript.applyEvent(toolStart("t3", "edit", { path: "src/a.ts" }));
    transcript.applyEvent(
      toolEnd("t3", "edit", { diff: "--- a\n+++ b\n-const x = 1;\n+const x = 2;" }),
    );
    expect(rendered(transcript)).toContain("-const x = 1;");
    expect(rendered(transcript)).toContain("+const x = 2;");
  });

  it("surfaces tool errors and assistant error messages in red", () => {
    transcript.applyEvent(toolStart("t4", "write", { path: ".env" }));
    transcript.applyEvent(
      toolEnd("t4", "write", {}, { isError: true, content: "Permission denied: user denied" }),
    );
    expect(rendered(transcript)).toContain("Permission denied: user denied");

    transcript.applyEvent({
      type: "message_end",
      message: { role: "assistant", errorMessage: "stream exploded", content: [] },
    } as unknown as AgentEvent);
    expect(rendered(transcript)).toContain("stream exploded");
  });

  it("clear() empties the visible history", () => {
    transcript.addUser("go");
    expect(transcript.render(80).length).toBeGreaterThan(0);
    transcript.clear();
    expect(transcript.render(80)).toEqual([]);
    expect(changes).toBeGreaterThan(0);
  });
});

// --- 3. status bar ---------------------------------------------------------------
describe("StatusBar", () => {
  const base = {
    busy: false,
    model: "mock/mock-reply",
    cwd: "E:\\tinycode_test",
    tokens: 12_345,
    subAgents: "",
    session: "4f2a1b9c-dead-beef",
  };

  it("shows readiness, model, cwd and context size", () => {
    const bar = new StatusBar(base);
    const out = rendered(bar, 200);
    expect(out).toContain("● ready");
    expect(out).toContain("mock/mock-reply");
    expect(out).toContain("E:\\tinycode_test");
    expect(out).toContain("ctx ~12.3k");
    expect(out).toContain("session 4f2a1b9c");
    expect(out).not.toContain("SUB-AGENTS");
  });

  it("flips to working and surfaces sub-agent activity", () => {
    const bar = new StatusBar({ ...base, busy: true, subAgents: "SUB-AGENTS 1/3 RUNNING" });
    const out = rendered(bar, 200);
    expect(out).toContain("● working");
    expect(out).toContain("SUB-AGENTS 1/3 RUNNING");
  });

  it("truncates to the available width instead of wrapping", () => {
    const bar = new StatusBar(base);
    expect(visibleWidth(bar.render(24)[0]!)).toBeLessThanOrEqual(24);
  });

  it("formats token counts compactly", () => {
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(12_345)).toBe("12.3k");
  });
});

// --- 4. loader host ---------------------------------------------------------------
describe("LoaderHost", () => {
  let terminal: FakeTerminal;
  let tui: TuiAltScreen;
  let host: LoaderHost;

  beforeEach(() => {
    terminal = new FakeTerminal();
    tui = new TuiAltScreen(terminal, false);
    host = new LoaderHost(tui);
  });

  afterEach(() => {
    host.dispose();
    tui.stop();
  });

  it("renders nothing while idle", () => {
    expect(host.render(80)).toEqual([]);
  });

  it("shows the default message, then the running-tool count", () => {
    host.show(0);
    expect(rendered(host)).toContain("thinking…");

    host.setToolCount(1);
    expect(rendered(host)).toContain("1 tool running");

    host.setToolCount(3);
    expect(rendered(host)).toContain("3 tools running");

    host.hide();
    expect(host.render(80)).toEqual([]);
  });

  it("keeps the count while hidden and restores it on show", () => {
    host.hide();
    host.setToolCount(2);
    expect(host.render(80)).toEqual([]);
    host.show(); // no argument → keep the remembered count
    expect(rendered(host)).toContain("2 tools running");
  });
});

// --- 5. commands ---------------------------------------------------------------------
describe("slash commands", () => {
  let harness: Harness;
  let transcript: Transcript;
  let quitCode: number | undefined;
  let refreshes: number;
  let ctx: CommandContext;
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tinycode-tui-cmd-"));
    const models = new ModelRegistry();
    models.enableMock();
    harness = await bootstrapHarness({
      projectRoot,
      config: {},
      models,
      session: { mode: "new" },
    });
    transcript = new Transcript(() => {});
    quitCode = undefined;
    refreshes = 0;
    ctx = {
      harness,
      transcript,
      refresh: () => {
        refreshes += 1;
      },
      quit: (code) => {
        quitCode = code;
      },
    };
  });

  afterEach(async () => {
    await harness.shutdown();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("exposes exactly the documented commands", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual([
      "help",
      "mcp",
      "model",
      "clear",
      "compact",
      "exit",
    ]);
    expect(commandNames.map((c) => c.name)).toEqual(COMMANDS.map((c) => c.name));
  });

  it("splits a command line into name and argument", () => {
    expect(parseCommand("/help")).toEqual({ name: "help", arg: "" });
    expect(parseCommand("  /model anthropic/claude-sonnet-4-5 ")).toEqual({
      name: "model",
      arg: "anthropic/claude-sonnet-4-5",
    });
    expect(parseCommand("plain prose")).toBeUndefined();
  });

  it("lists commands with /help and details with an argument", async () => {
    expect(await runCommand("/help", ctx)).toContain("/mcp");
    expect(await runCommand("/help", ctx)).toContain("compact");
    expect(await runCommand("/help model", ctx)).toContain("Show or switch the active model");
    expect(await runCommand("/help nope", ctx)).toContain("No such command");
  });

  it("reports MCP status and an empty server list", async () => {
    expect(await runCommand("/mcp", ctx)).toContain("MCP: no servers configured");
  });

  it("shows the current model with /model", async () => {
    const output = await runCommand("/model", ctx);
    expect(output).toContain(`model: ${harness.model.provider}/${harness.model.id}`);
    expect(output).toContain("available:");
  });

  it("clears the visible transcript without touching the session", async () => {
    transcript.addUser("something to forget");
    expect(transcript.render(80).length).toBeGreaterThan(0);
    expect(await runCommand("/clear", ctx)).toBe("");
    expect(transcript.render(80)).toEqual([]);
  });

  it("compacts (or reports there is nothing to compact)", async () => {
    expect(await runCommand("/compact", ctx)).toContain("Nothing to compact");
    expect(refreshes).toBe(1);
  });

  it("hands the exit code to the app", async () => {
    expect(await runCommand("/exit", ctx)).toBe("");
    expect(quitCode).toBe(0);
  });

  it("reports unknown commands instead of throwing", async () => {
    expect(await runCommand("/frobnicate", ctx)).toContain("Unknown command: /frobnicate");
    expect(await runCommand("not a command", ctx)).toBe("");
  });
});

// --- 6. permission bridge -------------------------------------------------------------
describe("PermissionBridge", () => {
  const request = makeRequest();

  it("denies when no handler is attached (unattended asks fail closed)", async () => {
    const bridge = new PermissionBridge();
    await expect(bridge.prompt(request)).resolves.toBe("deny");
    expect(bridge.pending).toBe(0);
  });

  it("delegates to the handler once attached", async () => {
    const bridge = new PermissionBridge();
    bridge.setHandler(async () => "allow-once");
    await expect(bridge.prompt(request)).resolves.toBe("allow-once");
  });

  it("denies when the handler throws", async () => {
    const bridge = new PermissionBridge();
    bridge.setHandler(() => Promise.reject(new Error("dialog exploded")));
    await expect(bridge.prompt(request)).resolves.toBe("deny");
  });

  it("serializes concurrent asks instead of stacking overlays", async () => {
    const bridge = new PermissionBridge();
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    bridge.setHandler(async (req) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(req.toolName);
      active -= 1;
      return "allow-always";
    });

    const first = bridge.prompt({ ...request, toolName: "write" });
    const second = bridge.prompt({ ...request, toolName: "bash", args: { command: "ls" } });
    await expect(Promise.all([first, second])).resolves.toEqual(["allow-always", "allow-always"]);
    expect(peak).toBe(1);
    expect(order).toEqual(["write", "bash"]);
    expect(bridge.pending).toBe(0);
  });

  it("cancelPending answers outstanding asks with deny and resets the queue", async () => {
    const bridge = new PermissionBridge();
    bridge.setHandler(() => new Promise<PermissionAnswer>(() => undefined));
    const pendingAsk = bridge.prompt(request);
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(bridge.pending).toBe(1);

    bridge.cancelPending();
    await expect(pendingAsk).resolves.toBe("deny");
    expect(bridge.pending).toBe(0);

    // The queue is usable again — and with the handler cleared it denies.
    bridge.clearHandler();
    await expect(bridge.prompt(request)).resolves.toBe("deny");
  });
});

// --- 7. permission dialog ----------------------------------------------------------------
describe("permission dialog", () => {
  it("renders the tool, its args, the risk and all three answers", () => {
    const out = stripTerminalSequences(renderPermissionDialog(makeRequest(), 70).join("\n"));
    expect(out).toContain("write");
    expect(out).toContain(".env");
    expect(out).toContain("ask-mode write");
    expect(out).toContain("write:.env");
    expect(out).toContain("creates a new file");
    expect(out).toContain("Deny");
    expect(out).toContain("Allow once");
    expect(out).toContain("Always allow");
  });

  it("omits the risk line when the request has none", () => {
    const out = stripTerminalSequences(
      renderPermissionDialog(makeRequest({ risk: undefined }), 70).join("\n"),
    );
    expect(out).not.toContain("creates a new file");
    expect(out).toContain("Deny");
  });

  describe("driven through a live TUI", () => {
    let terminal: FakeTerminal;
    let tui: TuiAltScreen;

    beforeEach(() => {
      terminal = new FakeTerminal();
      tui = new TuiAltScreen(terminal, false);
      tui.start();
    });

    afterEach(() => {
      tui.stop();
    });

    it("Enter picks the default: deny", async () => {
      const answer = askPermission(tui, makeRequest());
      await new Promise((resolve) => setTimeout(resolve, 1));
      terminal.input("\r");
      await expect(answer).resolves.toBe("deny");
      expect(tui.hasOverlayEntries).toBe(false);
    });

    it("Down + Enter allows once", async () => {
      const answer = askPermission(tui, makeRequest());
      await new Promise((resolve) => setTimeout(resolve, 1));
      terminal.input("\x1b[B");
      terminal.input("\r");
      await expect(answer).resolves.toBe("allow-once");
    });

    it("Down Down + Enter allows always", async () => {
      const answer = askPermission(tui, makeRequest());
      await new Promise((resolve) => setTimeout(resolve, 1));
      terminal.input("\x1b[B");
      terminal.input("\x1b[B");
      terminal.input("\r");
      await expect(answer).resolves.toBe("allow-always");
    });

    it("Escape cancels to deny", async () => {
      const answer = askPermission(tui, makeRequest());
      await new Promise((resolve) => setTimeout(resolve, 1));
      terminal.input("\x1b");
      await expect(answer).resolves.toBe("deny");
      expect(tui.hasOverlayEntries).toBe(false);
    });
  });
});

// --- 8. TuiApp end-to-end --------------------------------------------------------------
describe("TuiApp end-to-end (offline faux model)", () => {
  const apps: TuiApp[] = [];
  const runs: Array<Promise<RunResult>> = [];
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tinycode-tui-proj-"));
    apps.length = 0;
    runs.length = 0;
  });

  afterEach(async () => {
    for (const app of apps) app.quit(0);
    const settled = Promise.all([
      ...apps.map((app) => app.whenIdle()),
      ...runs.map((run) => run.catch(() => undefined)),
    ]);
    await withTimeout(settled, "tui teardown").catch(() => undefined);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeScript(steps: unknown): void {
    const file = path.join(projectRoot, "mock-script.json");
    fs.writeFileSync(file, JSON.stringify(steps), "utf8");
    process.env["TINYCODE_MOCK_SCRIPT"] = file;
  }

  async function startTui(): Promise<{ terminal: FakeTerminal; app: TuiApp }> {
    const terminal = new FakeTerminal();
    let captured: TuiApp | undefined;
    runs.push(
      runCli({
        argv: ["--model", "mock", "--project-root", projectRoot],
        cwd: projectRoot,
        stdout: () => {},
        stderr: () => {},
        terminal,
        onTui: (app) => {
          captured = app;
          apps.push(app);
        },
      }),
    );
    await until(() => terminal.started && captured !== undefined, "the TUI to start");
    return { terminal, app: captured! };
  }

  it("gives up gracefully when there is no terminal to draw on", async () => {
    const stderr: string[] = [];
    const result = await withNonTTY(() =>
      runCli({
        argv: ["--model", "mock", "--project-root", projectRoot],
        cwd: projectRoot,
        stdout: () => {},
        stderr: (line) => stderr.push(line),
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(stderr.join("\n")).toContain("requires a TTY");
    expect(apps).toHaveLength(0);
  });

  it("streams a faux reply into the transcript and exits on Ctrl+D", async () => {
    writeScript([{ text: "hello back from the mock" }]);

    const { terminal, app } = await startTui();
    expect(rendered(app.transcript)).toContain("/help for commands");

    typeText(terminal, "fix the tests");
    terminal.input("\r");
    await app.whenIdle();

    expect(rendered(app.transcript)).toContain("❯ fix the tests");
    expect(rendered(app.transcript)).toContain("hello back from the mock");
    // Rendered wide: at 80 columns a temp-dir cwd would push `ctx` off the end.
    expect(rendered(app.statusBar, 200)).toContain("● ready");
    expect(rendered(app.statusBar, 200)).toContain("ctx ~");
    expect(app.loaderHost.isVisible()).toBe(false);

    terminal.input("\x04"); // Ctrl+D
    const result = await withTimeout(runs[0]!, "runCli");
    expect(result.exitCode).toBe(0);
  });

  it("paints the screen through the terminal, not just component renders", async () => {
    writeScript([{ text: "paint me" }]);

    const { terminal, app } = await startTui();
    typeText(terminal, "say it");
    terminal.input("\r");
    await app.whenIdle();
    app.renderNow();

    expect(terminal.writes.length).toBeGreaterThan(0);
    expect(terminal.screen).toContain("ready");
    expect(terminal.screen).toContain("say it");

    app.quit(0);
    await withTimeout(runs[0]!, "runCli");
  });

  it("executes a tool call and shows its brief plus result line", async () => {
    fs.writeFileSync(path.join(projectRoot, "hello.txt"), "hi there\n", "utf8");
    writeScript([
      { toolCalls: [{ name: "read", arguments: { path: "hello.txt" } }] },
      { text: "read the file" },
    ]);

    const { terminal, app } = await startTui();
    typeText(terminal, "read hello.txt");
    terminal.input("\r");
    await app.whenIdle();

    const out = rendered(app.transcript);
    expect(out).toContain("● read hello.txt");
    expect(out).toMatch(/✓ read · \d/);
    expect(out).toContain("read the file");

    app.quit(0);
    await withTimeout(runs[0]!, "runCli");
  });

  it("runs a slash command through the editor submit path", async () => {
    writeScript([{ text: "unused" }]);

    const { terminal, app } = await startTui();
    // setText skips the editor's autocomplete popup so Enter submits directly.
    app.editor.setText("/help");
    terminal.input("\r");
    await app.whenIdle();

    expect(rendered(app.transcript)).toContain("❯ /help");
    expect(rendered(app.transcript)).toContain("/compact");

    app.quit(0);
    await withTimeout(runs[0]!, "runCli");
  });

  it("aborts a running turn on Ctrl+C, then requires two presses to quit", async () => {
    writeScript([{ text: "slow reply" }]);

    const { terminal, app } = await startTui();
    typeText(terminal, "go");
    terminal.input("\r");

    // Ctrl+C while busy aborts the run instead of exiting the app.
    terminal.input("\x03");
    await withTimeout(app.whenIdle(), "the aborted turn to settle");
    expect(terminal.started).toBe(true);

    // Idle now: the first press arms the confirm, the second quits.
    terminal.input("\x03");
    terminal.input("\x03");
    const result = await withTimeout(runs[0]!, "runCli");
    expect(result.exitCode).toBe(0);
  });

  describe("permission dialog integration", () => {
    it("denies the write by default (Enter) — no file is created", async () => {
      const target = path.join(projectRoot, "denied.txt");
      writeScript([
        { toolCalls: [{ name: "write", arguments: { path: "denied.txt", content: "owned" } }] },
        { text: "attempted the write" },
      ]);

      const { terminal, app } = await startTui();
      typeText(terminal, "create the file");
      terminal.input("\r");

      await until(() => app.tui.hasOverlayEntries, "the permission dialog");
      terminal.input("\r"); // Deny is the default selection.

      await app.whenIdle();
      expect(app.tui.hasOverlayEntries).toBe(false);
      expect(fs.existsSync(target)).toBe(false);
      expect(rendered(app.transcript)).toContain("Permission denied");

      app.quit(0);
      await withTimeout(runs[0]!, "runCli");
    });

    it("allows the write on Down + Enter (allow once)", async () => {
      const target = path.join(projectRoot, "allowed.txt");
      writeScript([
        { toolCalls: [{ name: "write", arguments: { path: "allowed.txt", content: "ok" } }] },
        { text: "wrote the file" },
      ]);

      const { terminal, app } = await startTui();
      typeText(terminal, "create the file");
      terminal.input("\r");

      await until(() => app.tui.hasOverlayEntries, "the permission dialog");
      terminal.input("\x1b[B"); // → Allow once
      terminal.input("\r");

      await app.whenIdle();
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("ok");
      expect(rendered(app.transcript)).toContain("● write allowed.txt");
      expect(rendered(app.transcript)).toContain("✓ +1 -0");

      app.quit(0);
      await withTimeout(runs[0]!, "runCli");
    });
  });
});
