import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SubAgentManager, SubAgentRecord } from "./manager.js";
import {
  ListAgentsParams,
  SpawnAgentParams,
  SubAgentIdParams,
  WaitAgentParams,
} from "./manager.js";

/**
 * The root agent's coordination surface (ARCHITECTURE §10):
 *
 *   spawn_agent  start a read-only worker (cap: 3 concurrent)
 *   list_agents  every worker with status/report preview
 *   wait_agent   block until done and return the final report
 *   close_agent  abort a worker
 *
 * These tools are registered ONLY on the root — the worker runtimes are
 * assembled with a read-only subset and never see this file's names.
 */

export interface SubAgentToolDetails {
  agentId: string;
  status: SubAgentRecord["status"];
}

function summarize(record: SubAgentRecord): string {
  const base = `${record.id} [${record.status}] ${record.task}`;
  if (record.status === "done") {
    const preview = (record.report ?? "").split("\n")[0] ?? "";
    return `${base}\n  report: ${preview.slice(0, 120)}`;
  }
  if (record.status === "error") return `${base}\n  error: ${record.error ?? "unknown"}`;
  return base;
}

export function createSubAgentTools(manager: SubAgentManager): AgentTool<any>[] {
  const spawn: AgentTool<typeof SpawnAgentParams, SubAgentToolDetails> = {
    name: "spawn_agent",
    label: "Spawn sub-agent",
    description:
      "Start a read-only research sub-agent with its own transcript. Use for parallel or " +
      "lengthy investigation (exploring a large area, comparing files) so the work does not " +
      "consume the main context. Returns the worker id immediately; call wait_agent to collect " +
      "the report. Max 3 concurrent.",
    parameters: SpawnAgentParams,
    execute: async (_toolCallId, params) => {
      const record = manager.spawn(params.task);
      return {
        content: [
          {
            type: "text",
            text:
              `Spawned ${record.id} (${manager.runningCount}/${manager.maxConcurrent} running).\n` +
              `Task: ${record.task}\nCall wait_agent(id="${record.id}") to collect its report.`,
          },
        ],
        details: { agentId: record.id, status: record.status },
      };
    },
  };

  const list: AgentTool<typeof ListAgentsParams, { count: number }> = {
    name: "list_agents",
    label: "List sub-agents",
    description: "List every sub-agent with its status, task, and a preview of its report.",
    parameters: ListAgentsParams,
    execute: async () => {
      const records = manager.list();
      const text =
        records.length === 0
          ? "No sub-agents."
          : `${manager.runningCount}/${manager.maxConcurrent} running\n${records
              .map(summarize)
              .join("\n")}`;
      return { content: [{ type: "text", text }], details: { count: records.length } };
    },
  };

  const wait: AgentTool<typeof WaitAgentParams, SubAgentToolDetails> = {
    name: "wait_agent",
    label: "Wait for sub-agent",
    description:
      "Wait for a sub-agent to finish and return its final report as text. Throws if the " +
      "worker failed, was closed, or the timeout elapses (the worker keeps running).",
    parameters: WaitAgentParams,
    execute: async (_toolCallId, params) => {
      const report = await manager.wait(params.id, params.timeoutMs);
      const record = manager.get(params.id);
      return {
        content: [{ type: "text", text: `Report from ${record.id}:\n${report}` }],
        details: { agentId: record.id, status: record.status },
      };
    },
  };

  const close: AgentTool<typeof SubAgentIdParams, SubAgentToolDetails> = {
    name: "close_agent",
    label: "Close sub-agent",
    description: "Abort a running sub-agent (its partial work is discarded). Safe to call twice.",
    parameters: SubAgentIdParams,
    execute: async (_toolCallId, params) => {
      const record = manager.close(params.id);
      const text =
        record.status === "closed" && record.endedAt !== undefined
          ? `Closed ${record.id}.`
          : `${record.id} was already ${record.status}.`;
      return {
        content: [{ type: "text", text }],
        details: { agentId: record.id, status: record.status },
      };
    },
  };

  return [spawn, list, wait, close];
}
