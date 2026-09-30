import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, HELP_TEXT } from "../src/cli/args.js";
import { runCli } from "../src/cli/index.js";
import { parseMockScript } from "../src/model/mock-script.js";
import { withNonTTY } from "./tty.js";

/**
 * Headless CLI coverage:
 *
 *   - pure arg parsing / mock-script parsing (no bootstrap)
 *   - the real `-p` path end-to-end with the offline faux model:
 *       * output + exit codes
 *       * the SAFETY CONTRACT: ASK-level writes are denied without a dialog,
 *         --permission-mode auto is the explicit opt-in
 *
 * Every run uses `--model mock` (or TINYCODE_MODEL=mock) so the environment's
 * real API keys can never reach the network.
 */

// --- env isolation -----------------------------------------------------------
const ENV_KEYS = [
  "TINYCODE_HOME",
  "TINYCODE_MODEL",
  "TINYCODE_PERMISSION_MODE",
  "TINYCODE_MOCK_SCRIPT",
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  // Neutralize ambient config; each test sets exactly what it needs.
  delete process.env["TINYCODE_MODEL"];
  delete process.env["TINYCODE_PERMISSION_MODE"];
  delete process.env["TINYCODE_MOCK_SCRIPT"];
  process.env["TINYCODE_HOME"] = fs.mkdtempSync(path.join(os.tmpdir(), "tinycode-cli-home-"));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// --- helpers -----------------------------------------------------------------
interface CliRun {
  stdout: string[];
  stderr: string[];
  text: string;
  exitCode: number;
}

async function run(argv: string[], opts: { cwd?: string } = {}): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await runCli({
    argv,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { stdout, stderr, text: result.text, exitCode: result.exitCode };
}

function makeProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tinycode-cli-proj-"));
}

function writeScript(dir: string, steps: unknown): string {
  const file = path.join(dir, "script.json");
  fs.writeFileSync(file, JSON.stringify(steps), "utf8");
  return file;
}

// --- pure parsing ------------------------------------------------------------
describe("parseArgs", () => {
  it("defaults to interactive mode", () => {
    const args = parseArgs([]);
    expect(args.mode).toBe("interactive");
    expect(args.errors).toEqual([]);
  });

  it("parses -p with a prompt", () => {
    const args = parseArgs(["-p", "fix the tests"]);
    expect(args.mode).toBe("print");
    expect(args.prompt).toBe("fix the tests");
  });

  it("rejects -p without a prompt", () => {
    const args = parseArgs(["-p"]);
    expect(args.errors).toContain("-p requires a prompt string");
  });

  it("rejects an invalid permission mode", () => {
    const args = parseArgs(["--permission-mode", "maybe"]);
    expect(args.errors[0]).toContain('--permission-mode must be "ask" or "auto"');
  });

  it("rejects unknown options and stray arguments", () => {
    expect(parseArgs(["--frobnicate"]).errors[0]).toContain("Unknown option");
    expect(parseArgs(["hello"]).errors[0]).toContain("Unexpected argument");
  });

  it("treats --continue and --session as mutually exclusive", () => {
    const args = parseArgs(["--continue", "--session", "abc"]);
    expect(args.errors.some((e) => e.includes("mutually exclusive"))).toBe(true);
  });

  it("parses help and version", () => {
    expect(parseArgs(["--help"]).mode).toBe("help");
    expect(parseArgs(["-v"]).mode).toBe("version");
  });

  it("parses --mcp-status", () => {
    expect(parseArgs(["--mcp-status"]).mcpStatus).toBe(true);
    expect(parseArgs([]).mcpStatus).toBe(false);
  });
});

describe("parseMockScript", () => {
  it("turns text steps into stop turns and tool steps into toolUse turns", () => {
    const steps = parseMockScript(
      JSON.stringify([
        { toolCalls: [{ name: "read", arguments: { path: "a.ts" } }] },
        { text: "final" },
      ]),
    );
    expect(steps).toHaveLength(2);
  });

  it("honors an explicit stopReason", () => {
    const steps = parseMockScript(JSON.stringify([{ text: "x", stopReason: "length" }]));
    const step = steps[0] as { stopReason?: string };
    expect(step.stopReason).toBe("length");
  });

  it("rejects a non-array script", () => {
    expect(() => parseMockScript('{"text": "nope"}')).toThrow(/JSON array/);
  });

  it("rejects an empty step", () => {
    expect(() => parseMockScript("[{}]")).toThrow(/neither text nor toolCalls/);
  });
});

// --- headless -p, end-to-end -------------------------------------------------
describe("headless -p (real bootstrap, offline mock)", () => {
  it("prints help and exits 0", async () => {
    const result = await run(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe(HELP_TEXT);
    expect(result.stdout.join("\n")).toContain("Usage:");
  });

  it("prints the version and exits 0", async () => {
    const result = await run(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.text).toMatch(/^tinycode \d/);
  });

  it("exits 2 on argument errors without bootstrapping", async () => {
    const result = await run(["--frobnicate"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.join("\n")).toContain("Unknown option");
  });

  it("exits 2 when -p is missing its prompt", async () => {
    const result = await run(["-p"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.join("\n")).toContain("requires a prompt");
  });

  it("runs a scripted mock conversation offline and prints the final answer", async () => {
    const project = makeProject();
    process.env["TINYCODE_MOCK_SCRIPT"] = writeScript(project, [{ text: "hello from the mock" }]);

    const result = await run(["-p", "hi there", "--model", "mock", "--project-root", project], {
      cwd: project,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toContain("hello from the mock");
    // The mock must be announced — proof no network model was silently used.
    expect(result.stderr.join("\n")).toContain("MOCK mode");
    // Headless runs stay ephemeral: no session files for -p.
    const home = process.env["TINYCODE_HOME"]!;
    const sessionsDir = path.join(home, "sessions");
    if (fs.existsSync(sessionsDir)) {
      expect(fs.readdirSync(sessionsDir)).toHaveLength(0);
    }
  });

  it("reads the mock script from TINYCODE_MOCK_SCRIPT", async () => {
    const project = makeProject();
    process.env["TINYCODE_MOCK_SCRIPT"] = writeScript(project, [{ text: "scripted via env" }]);

    const result = await run(["-p", "go", "--model", "mock", "--project-root", project], {
      cwd: project,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toContain("scripted via env");
  });

  it("DENIES state-changing writes in headless ASK mode (no dialog → no file)", async () => {
    const project = makeProject();
    const target = path.join(project, "pwned.txt");
    process.env["TINYCODE_MOCK_SCRIPT"] = writeScript(project, [
      { toolCalls: [{ name: "write", arguments: { path: "pwned.txt", content: "owned" } }] },
      { text: "attempted the write" },
    ]);

    const result = await run(
      ["-p", "write the file", "--model", "mock", "--project-root", project],
      {
        cwd: project,
      },
    );

    // The loop still completes: the denial reaches the model as a tool error.
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    expect(result.stdout.join("\n")).toContain("attempted the write");
  });

  it("ALLOWS writes with --permission-mode auto (the explicit opt-in)", async () => {
    const project = makeProject();
    const target = path.join(project, "allowed.txt");
    process.env["TINYCODE_MOCK_SCRIPT"] = writeScript(project, [
      { toolCalls: [{ name: "write", arguments: { path: "allowed.txt", content: "ok" } }] },
      { text: "wrote the file" },
    ]);

    const result = await run(
      [
        "-p",
        "write the file",
        "--model",
        "mock",
        "--permission-mode",
        "auto",
        "--project-root",
        project,
      ],
      { cwd: project },
    );

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("ok");
    expect(result.stdout.join("\n")).toContain("wrote the file");
  });

  it("denies writes when TINYCODE_PERMISSION_MODE=auto is absent and allows it when set", async () => {
    const project = makeProject();
    const target = path.join(project, "env-allowed.txt");
    process.env["TINYCODE_PERMISSION_MODE"] = "auto";
    process.env["TINYCODE_MOCK_SCRIPT"] = writeScript(project, [
      {
        toolCalls: [{ name: "write", arguments: { path: "env-allowed.txt", content: "via env" } }],
      },
      { text: "done" },
    ]);

    const result = await run(["-p", "write", "--model", "mock", "--project-root", project], {
      cwd: project,
    });

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe("via env");
  });

  it("degrades to a headless hint when there is no TTY (instead of hanging)", async () => {
    const project = makeProject();
    const result = await withNonTTY(() =>
      run(["--model", "mock", "--project-root", project], { cwd: project }),
    );
    expect(result.exitCode).toBe(0);
    const stderr = result.stderr.join("\n");
    expect(stderr).toContain("requires a TTY");
    expect(stderr).toContain('tinycode -p "prompt"');
  });

  it("lists MCP status with --mcp-status and exits without prompting", async () => {
    const project = makeProject();
    // Run the repo's own fixture in place: a copy in tmp could not resolve
    // @modelcontextprotocol/sdk (no node_modules above it).
    const server = path.join(import.meta.dirname, "fixtures", "mcp-server.mjs");
    fs.mkdirSync(path.join(project, ".tinycode"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".tinycode", "config.json"),
      JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [server] } } }),
    );

    const result = await run(["--mcp-status", "--model", "mock", "--project-root", project], {
      cwd: project,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toContain("fixture: connected, 3 tools");
  });

  it("reports a broken MCP server as failed instead of crashing", async () => {
    const project = makeProject();
    fs.mkdirSync(path.join(project, ".tinycode"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".tinycode", "config.json"),
      JSON.stringify({ mcpServers: { broken: { command: "no-such-binary-tinycode" } } }),
    );

    const result = await run(["--mcp-status", "--model", "mock", "--project-root", project], {
      cwd: project,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toContain("broken: failed");
  });
});
