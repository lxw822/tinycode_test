import { Type } from "typebox";
import type { TinyCodeRuntime } from "../agent/runtime.js";

/**
 * Sub-agent coordination — ARCHITECTURE §10.
 *
 * Workers are READ-ONLY: each is an independent Pi Agent (own transcript,
 * own abort, read-only tool subset, fixed worker prompt) assembled by the
 * caller-supplied runtime factory. Hard rules prevent swarms:
 *
 *   - max 3 concurrent workers (spawn refuses beyond the cap)
 *   - workers never receive sub-agent tools (no nesting, no recursion)
 *   - the worker tool set contains no write/edit/bash (built in bootstrap)
 *
 * The root coordinates through four tools: spawn_agent / list_agents /
 * wait_agent (returns the worker's final assistant message as a report) /
 * close_agent (abort).
 */

export const MAX_SUB_AGENTS = 3;
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000;

/** Fixed system prompt for every worker — identical, deterministic. */
export const WORKER_SYSTEM_PROMPT = [
  "You are a read-only research worker inside TinyCode, coordinated by a main agent.",
  "You were given one task. Investigate it using only read/grep/find/ls and reply with a report.",
  "",
  "Rules:",
  "- Read-only: you cannot modify anything; do not attempt to.",
  "- Answer the task you were given, nothing else.",
  "- Be concrete: cite file paths and line numbers, quote the relevant code.",
  "- End with a short `Report:` section the coordinating agent can lift verbatim.",
].join("\n");

export type SubAgentStatus = "running" | "done" | "error" | "closed";

export interface SubAgentRecord {
  id: string;
  task: string;
  status: SubAgentStatus;
  startedAt: number;
  endedAt?: number;
  /** Final assistant message (wait_agent's payload) once done. */
  report?: string;
  error?: string;
}

export interface SubAgentManagerOptions {
  /** Builds a fresh worker runtime per spawn (fresh transcript + tools). */
  createRuntime: () => TinyCodeRuntime;
  maxConcurrent?: number;
}

export class SubAgentManager {
  private readonly records = new Map<string, SubAgentRecord>();
  private readonly runtimes = new Map<string, TinyCodeRuntime>();
  /** Completion promise per worker so wait_agent can await without polling. */
  private readonly completions = new Map<string, Promise<void>>();
  private counter = 0;

  constructor(private readonly options: SubAgentManagerOptions) {}

  get maxConcurrent(): number {
    return this.options.maxConcurrent ?? MAX_SUB_AGENTS;
  }

  get runningCount(): number {
    return [...this.records.values()].filter((r) => r.status === "running").length;
  }

  list(): SubAgentRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  get(id: string): SubAgentRecord {
    const record = this.records.get(id);
    if (!record) {
      const known = [...this.records.keys()].join(", ");
      throw new Error(
        `Unknown sub-agent: ${id}` + (known.length > 0 ? ` (known: ${known})` : " (none spawned)"),
      );
    }
    return record;
  }

  /** Start a worker. Throws when the concurrency cap is reached. */
  spawn(task: string): SubAgentRecord {
    const trimmed = task.trim();
    if (trimmed.length === 0) throw new Error("spawn_agent requires a non-empty task");

    if (this.runningCount >= this.maxConcurrent) {
      throw new Error(
        `Sub-agent limit reached: ${this.maxConcurrent} concurrent workers are already running. ` +
          "Wait for one to finish (wait_agent) or close one (close_agent) first.",
      );
    }

    const id = `w${++this.counter}`;
    const record: SubAgentRecord = {
      id,
      task: trimmed,
      status: "running",
      startedAt: Date.now(),
    };
    this.records.set(id, record);

    const runtime = this.options.createRuntime();
    this.runtimes.set(id, runtime);

    const completion = (async () => {
      try {
        await runtime.prompt(trimmed);
        await runtime.waitForIdle();
        const report = lastAssistantText(runtime.messages);
        if (record.status === "running") {
          record.report = report.length > 0 ? report : "(worker finished without a report)";
          record.status = "done";
        }
      } catch (error) {
        if (record.status === "running") {
          record.status = "error";
          record.error = (error as Error).message;
        }
      } finally {
        record.endedAt = Date.now();
        this.runtimes.delete(id);
        this.completions.delete(id);
      }
    })();
    // The body never rejects (all paths caught); keep a no-op guard anyway so
    // a future change cannot surface an unhandled rejection.
    completion.catch(() => undefined);
    this.completions.set(id, completion);
    return { ...record };
  }

  /**
   * Await a worker and return its report. Throws on unknown ids, failures,
   * closed workers, and on timeout (the worker keeps running).
   */
  async wait(id: string, timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS): Promise<string> {
    const record = this.get(id);
    if (record.status === "running") {
      const completion = this.completions.get(id);
      if (completion) await withTimeout(completion, timeoutMs, id);
    }
    if (record.status === "error") throw new Error(`Sub-agent ${id} failed: ${record.error}`);
    if (record.status === "closed") {
      throw new Error(`Sub-agent ${id} was closed before finishing`);
    }
    return record.report ?? "(no report)";
  }

  /** Abort a running worker (or mark a finished one closed). */
  close(id: string): SubAgentRecord {
    const record = this.get(id);
    if (record.status === "running") {
      this.runtimes.get(id)?.abort();
      record.status = "closed";
      record.endedAt = Date.now();
    }
    return { ...record };
  }

  /** `SUB-AGENTS n/3 RUNNING` for the status bar; empty when idle. */
  statusLine(): string {
    const running = this.runningCount;
    return running > 0 ? `SUB-AGENTS ${running}/${this.maxConcurrent} RUNNING` : "";
  }

  /** Abort every worker (harness shutdown — no runaway agents keep polling). */
  shutdown(): void {
    for (const record of this.records.values()) {
      if (record.status === "running") {
        this.runtimes.get(record.id)?.abort();
        record.status = "closed";
        record.endedAt = Date.now();
      }
    }
    for (const runtime of this.runtimes.values()) runtime.abort();
    this.runtimes.clear();
  }
}

/** Newest assistant message that actually carries text, else "". */
export function lastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown };
    if (message.role !== "assistant") continue;
    if (!Array.isArray(message.content)) continue;
    const text = message.content
      .filter(
        (block): block is { type: string; text: string } =>
          Boolean(block) &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text",
      )
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text.length > 0) return text;
  }
  return "";
}

async function withTimeout(promise: Promise<void>, ms: number, id: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${ms}ms waiting for sub-agent ${id}`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- Tool parameter schemas --------------------------------------------------
export const SpawnAgentParams = Type.Object({
  task: Type.String({
    description:
      "The research task for the worker: what to investigate and what the report must answer.",
  }),
});

export const SubAgentIdParams = Type.Object({
  id: Type.String({ description: 'Sub-agent id, e.g. "w1" (from spawn_agent or list_agents).' }),
});

export const WaitAgentParams = Type.Object({
  id: Type.String({ description: "Sub-agent id to wait for." }),
  timeoutMs: Type.Optional(
    Type.Number({
      description: `Max milliseconds to wait (default ${DEFAULT_WAIT_TIMEOUT_MS}).`,
    }),
  ),
});
