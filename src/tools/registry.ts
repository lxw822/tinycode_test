import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * One registry, one tool surface.
 *
 * Built-ins register first; MCP tools and sub-agent tools join the same
 * namespace before the agent starts, so the model always sees a single
 * uniform list. Duplicate names are rejected loudly — a silent overwrite
 * would let two subsystems claim the same tool name.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool<any>>();

  register(tool: AgentTool<any>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Register only if the name is free. Returns true when registered. */
  registerIfAbsent(tool: AgentTool<any>): boolean {
    if (this.tools.has(tool.name)) return false;
    this.tools.set(tool.name, tool);
    return true;
  }

  get(name: string): AgentTool<any> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get size(): number {
    return this.tools.size;
  }

  list(): AgentTool<any>[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}
