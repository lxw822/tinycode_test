import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpManager } from "../src/mcp/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createReadTool } from "../src/tools/index.js";

const SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "mcp-server.mjs",
);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tinycode-mcp-"));
let projectRoot: string;
let open: McpManager[] = [];

function serverConfig(extraArgs: string[] = []) {
  return { command: process.execPath, args: [SERVER, ...extraArgs] };
}

function make(servers: Record<string, { command: string; args?: string[] }>, timeoutMs?: number) {
  const manager = new McpManager(timeoutMs === undefined ? { servers } : { servers, timeoutMs });
  open.push(manager);
  return manager;
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(tmp, "proj-"));
});

afterEach(async () => {
  await Promise.all(open.map((m) => m.shutdown()));
  open = [];
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("MCP connection", () => {
  it("connects a stdio server and reports status", async () => {
    const registry = new ToolRegistry();
    const mcp = make({ fixture: serverConfig() });
    await mcp.connect(registry);

    const [entry] = mcp.status();
    expect(entry).toMatchObject({ name: "fixture", state: "connected", toolCount: 3 });
    expect(mcp.formatStatus()).toContain("fixture: connected, 3 tools");
  });

  it("records a failure instead of crashing when the command does not exist", async () => {
    const registry = new ToolRegistry();
    const mcp = make({
      broken: { command: "definitely-not-a-real-binary-tinycode" },
      fixture: serverConfig(),
    });
    await mcp.connect(registry); // must not throw

    const byName = Object.fromEntries(mcp.status().map((e) => [e.name, e]));
    expect(byName["broken"]!.state).toBe("failed");
    expect(byName["broken"]!.error).toBeTruthy();
    // The healthy sibling still connected — one bad server, no blast radius.
    expect(byName["fixture"]!.state).toBe("connected");
    expect(registry.has("echo")).toBe(true);
  });

  it("times out a server that never completes initialize", async () => {
    const registry = new ToolRegistry();
    const mcp = make({ silent: serverConfig(["silent"]) }, 700);
    await mcp.connect(registry);

    const [entry] = mcp.status();
    expect(entry!.state).toBe("failed");
    expect(entry!.error).toMatch(/timed out after 700ms/);
    expect(registry.size).toBe(0);
  });

  it("stays empty and harmless with no configured servers", async () => {
    const registry = new ToolRegistry();
    const mcp = make({});
    await mcp.connect(registry);
    expect(mcp.isEmpty).toBe(true);
    expect(mcp.formatStatus()).toBe("MCP: no servers configured");
    expect(registry.size).toBe(0);
  });
});

describe("MCP tool adaptation", () => {
  it("registers a bare MCP name when the built-in name is free", async () => {
    const registry = new ToolRegistry();
    const mcp = make({ fixture: serverConfig() });
    await mcp.connect(registry);
    expect(registry.names().sort()).toEqual(["echo", "fail", "read"]);
  });

  it("qualifies a colliding name as <server>_<tool>", async () => {
    const registry = new ToolRegistry();
    registry.register(createReadTool(projectRoot)); // built-in read wins
    const mcp = make({ fixture: serverConfig() });
    await mcp.connect(registry);

    expect(registry.names().sort()).toEqual(["echo", "fail", "fixture_read", "read"]);
    expect(mcp.status()[0]!.toolCount).toBe(3);
  });

  it("passes the MCP JSON Schema through as tool parameters", async () => {
    const registry = new ToolRegistry();
    const mcp = make({ fixture: serverConfig() });
    await mcp.connect(registry);

    const echo = registry.get("echo")!;
    expect(echo.parameters).toMatchObject({
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" } },
    });
    expect(echo.description).toContain("MCP server: fixture");
  });

  it("executes a tool call against the live server", async () => {
    const registry = new ToolRegistry();
    const mcp = make({ fixture: serverConfig() });
    await mcp.connect(registry);

    const echo = registry.get("echo")!;
    const result = await echo.execute!("call-1", { text: "hi" });
    expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);
    expect(result.details).toEqual({ server: "fixture", tool: "echo" });
  });

  it("throws when the server marks the result as an error", async () => {
    const registry = new ToolRegistry();
    const mcp = make({ fixture: serverConfig() });
    await mcp.connect(registry);

    const fail = registry.get("fail")!;
    await expect(fail.execute!("call-1", {})).rejects.toThrow(/server-side failure/);
  });
});

describe("MCP shutdown", () => {
  it("closes transports and marks entries closed (no child leaks)", async () => {
    const registry = new ToolRegistry();
    const mcp = make({ fixture: serverConfig() });
    await mcp.connect(registry);
    const pid = mcp.status()[0]!.pid;
    expect(pid).toBeGreaterThan(0);

    await mcp.shutdown();
    expect(mcp.status()[0]!.state).toBe("closed");
    // The spawned child is gone (kill(pid, 0) throws ESRCH once reaped).
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(() => process.kill(pid!, 0)).toThrow(/ESRCH|not found/);

    // Idempotent: a second shutdown must not throw.
    await expect(mcp.shutdown()).resolves.toBeUndefined();
  });

  it("never rejects when a failed server is shut down", async () => {
    const registry = new ToolRegistry();
    const mcp = make({ broken: { command: "no-such-binary-tinycode" } });
    await mcp.connect(registry);
    await expect(mcp.shutdown()).resolves.toBeUndefined();
  });
});
