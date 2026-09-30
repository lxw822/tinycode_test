import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { TSchema } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { McpServerConfig } from "../config/schema.js";
import type { ToolRegistry } from "../tools/registry.js";
import { TINYCODE_VERSION } from "../agent/prompt.js";

/**
 * MCP client manager — ARCHITECTURE §9.
 *
 * Every `mcpServers` entry spawns a stdio server. Startup connects them ALL
 * IN PARALLEL behind one initialize timeout; a server that fails (missing
 * binary, crash, silence) records a status entry instead of crashing the
 * app — one bad server must not take the product down.
 *
 * Each server's tools are adapted into regular `AgentTool`s that `callTool`
 * under the hood. The JSON Schema from `listTools` is passed straight
 * through: pi-ai validates plain JSON Schemas as well as TypeBox ones.
 * Name collisions resolve to `<server>_<tool>` (bare names win when free, so
 * a lone server stays readable).
 *
 * `shutdown()` closes every transport, which kills the spawned children —
 * no orphan processes after exit.
 */

export type McpState = "connected" | "failed" | "closed";

export interface McpStatusEntry {
  name: string;
  state: McpState;
  toolCount: number;
  /** Child process pid while connected (leak checks / debugging). */
  pid?: number;
  error?: string;
}

export interface McpManagerOptions {
  servers: Record<string, McpServerConfig>;
  /** Initialize/connect timeout per server. */
  timeoutMs?: number;
}

interface ServerRecord {
  client?: Client;
  transport?: StdioClientTransport;
  tools: Array<{ server: string; originalName: string; tool: AgentTool<any> }>;
  status: McpStatusEntry;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export class McpManager {
  private readonly options: McpManagerOptions;
  private readonly records = new Map<string, ServerRecord>();
  private connected = false;

  constructor(options: McpManagerOptions) {
    this.options = options;
  }

  get isEmpty(): boolean {
    return Object.keys(this.options.servers).length === 0;
  }

  /**
   * Connect every configured server in parallel and register their tools.
   * Never rejects: failures land in `status()`.
   */
  async connect(registry: ToolRegistry): Promise<void> {
    if (this.connected || this.isEmpty) return;
    this.connected = true;

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const entries = Object.entries(this.options.servers).sort(([a], [b]) => a.localeCompare(b));

    await Promise.all(
      entries.map(async ([name, config]) => {
        const record: ServerRecord = {
          tools: [],
          status: { name, state: "failed", toolCount: 0 },
        };
        this.records.set(name, record);
        try {
          await this.connectOne(name, config, registry, timeoutMs);
        } catch (error) {
          // Failure isolation: record it, leave the other servers running.
          record.status.state = "failed";
          record.status.error = (error as Error).message;
          await this.closeRecord(record);
        }
      }),
    );
  }

  private async connectOne(
    name: string,
    config: McpServerConfig,
    registry: ToolRegistry,
    timeoutMs: number,
  ): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      // Keep the inherited defaults (PATH, …) and layer config on top:
      // an explicit env that drops PATH would break most servers.
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
      // Server logs must not corrupt the JSON-RPC stream on stdout; keep
      // child noise off our stderr too (the status entry carries errors).
      stderr: "pipe",
    });
    const client = new Client({ name: "tinycode", version: TINYCODE_VERSION });
    const record = this.records.get(name)!;
    record.transport = transport;
    record.client = client;

    // Capture child stderr so a failed server explains itself: the status
    // entry is the only place users can look for why a server didn't start.
    let stderrTail = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2_000);
    });

    try {
      await this.withTimeout(client.connect(transport), timeoutMs, name);
    } catch (error) {
      const detail = stderrTail.trim();
      throw new Error(
        detail.length > 0 ? `${(error as Error).message} — ${detail}` : (error as Error).message,
      );
    }

    const listed = await client.listTools();
    for (const mcpTool of listed.tools ?? []) {
      // Bare name when free (a lone server stays readable), otherwise the
      // qualified `<server>_<tool>` — that is what the model will call.
      const toolName = registry.has(mcpTool.name) ? `${name}_${mcpTool.name}` : mcpTool.name;
      if (registry.has(toolName)) {
        // Two servers claiming the same qualified name: skip loudly rather
        // than overwrite — a silent hijack would be worse than a missing tool.
        throw new Error(
          `tool name collision: "${toolName}" is already registered (server ${name})`,
        );
      }
      const adapted = this.adaptTool(toolName, name, mcpTool, client);
      registry.register(adapted);
      record.tools.push({ server: name, originalName: mcpTool.name, tool: adapted });
    }

    record.status.state = "connected";
    record.status.toolCount = record.tools.length;
    if (transport.pid !== null) record.status.pid = transport.pid;
  }

  /** Wrap a plain MCP tool as an AgentTool (JSON Schema passed through). */
  private adaptTool(
    toolName: string,
    server: string,
    mcpTool: { name: string; description?: string; inputSchema?: unknown },
    client: Client,
  ): AgentTool<any> {
    const originalName = mcpTool.name;
    // The MCP SDK already validates `inputSchema` as `{ type: "object" }`, so
    // this is guaranteed to be an object-rooted schema by the time it lands here.
    const parameters = (mcpTool.inputSchema ?? { type: "object", properties: {} }) as TSchema;
    return {
      name: toolName,
      label: `${server}:${originalName}`,
      description: `${mcpTool.description ?? `MCP tool ${originalName}`} (MCP server: ${server})`,
      parameters,
      execute: async (_toolCallId, params, signal) => {
        const result = await client.callTool(
          { name: originalName, arguments: params as Record<string, unknown> },
          undefined,
          signal ? { signal } : {},
        );
        if (result.isError === true) {
          // Contract: throw instead of encoding failures in content, so the
          // loop marks the tool result as an error the model must react to.
          throw new Error(`${server}.${originalName}: ${flattenContent(result.content)}`);
        }
        const text = flattenContent(result.content);
        return {
          content: [{ type: "text", text: text.length > 0 ? text : "(no content)" }],
          details: { server, tool: originalName },
        };
      },
    };
  }

  /** Per-server connect timeout that still lets the caller close the child. */
  private async withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`initialize timed out after ${ms}ms`)), ms);
        }),
      ]);
    } catch (error) {
      throw new Error(`${name}: ${(error as Error).message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  status(): McpStatusEntry[] {
    return [...this.records.values()].map((r) => ({ ...r.status }));
  }

  /** Human-readable `/mcp` listing (used by the TUI in a later milestone). */
  formatStatus(): string {
    const entries = this.status();
    if (entries.length === 0) return "MCP: no servers configured";
    return entries
      .map((e) => {
        if (e.state === "connected") return `${e.name}: connected, ${e.toolCount} tools`;
        if (e.state === "closed") return `${e.name}: closed, ${e.toolCount} tools`;
        return `${e.name}: failed — ${e.error ?? "unknown error"}`;
      })
      .join("\n");
  }

  /** Close every transport (kills the spawned children). Idempotent. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.records.values()].map(async (record) => {
        await this.closeRecord(record);
        if (record.status.state === "connected") record.status.state = "closed";
      }),
    );
  }

  private async closeRecord(record: ServerRecord): Promise<void> {
    try {
      await record.client?.close();
    } catch {
      // Client.close also closes the transport; fall through to be sure.
    }
    try {
      await record.transport?.close();
    } catch {
      // Already closed — shutdown must not throw.
    }
    delete record.client;
    delete record.transport;
  }
}

/** Join MCP content blocks into one text string (images summarized). */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block["type"] === "text" && typeof block["text"] === "string") {
      parts.push(block["text"]);
    } else if (block["type"] === "image") {
      parts.push(
        `[image ${String(block["mimeType"] ?? "unknown")} ${String(block["data"] ?? "").length}b]`,
      );
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.join("\n");
}
