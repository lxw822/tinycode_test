import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, type FauxProviderHandle } from "@earendil-works/pi-ai";
import {
  SubAgentManager,
  WORKER_SYSTEM_PROMPT,
  lastAssistantText,
  MAX_SUB_AGENTS,
} from "../src/subagents/manager.js";
import { createSubAgentTools } from "../src/subagents/tools.js";
import { TinyCodeRuntime } from "../src/agent/runtime.js";
import { makeWorkerToolRegistry, makeDefaultSummarizer } from "../src/bootstrap.js";
import { mockRegistry } from "../src/model/registry.js";
import { ContextManager } from "../src/context/manager.js";
import { PermissionManager } from "../src/permissions/manager.js";

/**
 * Sub-agent coverage (ARCHITECTURE §10):
 *
 *   - workers are READ-ONLY: their registry has no write/edit/bash and no
 *     coordination tools (the anti-swarm rule, verified structurally)
 *   - spawn caps at 3 concurrent; wait/close/list behave as specified
 *   - the report a coordinator collects IS the worker's final assistant text
 *   - shutdown aborts everything (no runaway workers after exit)
 *
 * Workers get their OWN faux handle so their scripted responses never race
 * with the root's queue.
 */

let root: string;
let open: Array<() => void> = [];

interface Fixture {
  manager: SubAgentManager;
  workerHandle: FauxProviderHandle;
  /** Release gated workers (only when `gated: true`). */
  release: () => void;
}

/**
 * `gated: true` holds every worker at its first stream call until
 * `release()` — that is what makes "running" a deterministic state instead
 * of a race against a mock that answers instantly.
 */
async function makeFixture(
  workerScript: unknown[] = [],
  opts: { gated?: boolean } = {},
): Promise<Fixture> {
  const { registry, handle } = mockRegistry();
  handle.setResponses(workerScript as never[]);
  const model = await registry.resolve({});
  const contextManager = new ContextManager({
    maxToolResultChars: 30_000,
    compactAboveTokens: 100_000,
    keepRecentMessages: 12,
    artifactsDir: path.join(root, "artifacts"),
  });
  const permissions = new PermissionManager({ mode: "auto", projectRoot: root });
  const realStream = registry.collection.streamSimple.bind(registry.collection);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const streamFn = opts.gated
    ? async (
        m: Parameters<typeof realStream>[0],
        c: Parameters<typeof realStream>[1],
        o?: Parameters<typeof realStream>[2],
      ) => {
        await gate;
        return realStream(m, c, o);
      }
    : realStream;
  const manager = new SubAgentManager({
    createRuntime: () =>
      new TinyCodeRuntime({
        projectRoot: root,
        systemPrompt: WORKER_SYSTEM_PROMPT,
        model: model.model,
        streamFn,
        tools: makeWorkerToolRegistry(root),
        permissions,
        contextManager,
        summarize: makeDefaultSummarizer(registry, model.model),
      }),
  });
  open.push(() => manager.shutdown());
  return { manager, workerHandle: handle, release };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tinycode-sub-"));
});

afterEach(() => {
  for (const stop of open) stop();
  open = [];
  fs.rmSync(root, { recursive: true, force: true });
});

describe("worker tool subset (anti-swarm)", () => {
  it("contains only read/grep/find/ls", () => {
    const registry = makeWorkerToolRegistry(root);
    expect(registry.names().sort()).toEqual(["find", "grep", "ls", "read"]);
  });

  it("never contains write/edit/bash or coordination tools", () => {
    const names = makeWorkerToolRegistry(root).names();
    for (const forbidden of [
      "write",
      "edit",
      "bash",
      "spawn_agent",
      "list_agents",
      "wait_agent",
      "close_agent",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe("SubAgentManager lifecycle", () => {
  it("spawns, reports, and records a worker end-to-end", async () => {
    const { manager } = await makeFixture([
      fauxAssistantMessage([fauxText("Report: math.js line 3 returns NaN.")]),
    ]);

    const record = manager.spawn("Investigate math.js");
    expect(record.status).toBe("running");
    expect(manager.runningCount).toBe(1);

    const report = await manager.wait(record.id);
    expect(report).toContain("Report: math.js line 3");
    expect(manager.list()[0]!.status).toBe("done");
    expect(manager.statusLine()).toBe(""); // idle again
  });

  it("caps concurrency at 3 and explains how to recover", async () => {
    const { manager } = await makeFixture([], { gated: true });
    for (let i = 0; i < MAX_SUB_AGENTS; i++) manager.spawn(`task ${i}`);
    expect(manager.runningCount).toBe(3);
    expect(manager.statusLine()).toBe(`SUB-AGENTS 3/${MAX_SUB_AGENTS} RUNNING`);
    expect(() => manager.spawn("one too many")).toThrow(/limit reached.*Wait for one/i);
  });

  it("rejects an empty task", async () => {
    const { manager } = await makeFixture();
    expect(() => manager.spawn("   ")).toThrow(/non-empty task/);
  });

  it("reports unknown ids with the known list", async () => {
    const { manager } = await makeFixture();
    expect(() => manager.get("w9")).toThrow(/Unknown sub-agent: w9.*none spawned/);
  });

  it("surfaces a worker failure through wait_agent", async () => {
    const { manager } = await makeFixture();
    const record = manager.spawn("doomed");
    // The worker has no scripted response: the loop ends with no assistant
    // text, which the manager converts into an explicit empty report.
    const report = await manager.wait(record.id);
    expect(report).toMatch(/without a report/);
  });

  it("close aborts a running worker and wait then refuses", async () => {
    const { manager } = await makeFixture([], { gated: true });
    const record = manager.spawn("long task");
    expect(manager.list()[0]!.status).toBe("running");
    const closed = manager.close(record.id);
    expect(closed.status).toBe("closed");
    await expect(manager.wait(record.id)).rejects.toThrow(/closed before finishing/);
    // Closing again is safe and says so.
    expect(manager.close(record.id).status).toBe("closed");
  });

  it("shutdown closes every running worker", async () => {
    const { manager } = await makeFixture([], { gated: true });
    manager.spawn("a");
    manager.spawn("b");
    manager.shutdown();
    expect(manager.list().every((r) => r.status === "closed")).toBe(true);
    expect(manager.runningCount).toBe(0);
    expect(manager.statusLine()).toBe("");
  });
});

describe("wait timeout", () => {
  it("times out without killing the worker", async () => {
    const { manager } = await makeFixture([], { gated: true });
    const record = manager.spawn("slow");
    await expect(manager.wait(record.id, 50)).rejects.toThrow(/Timed out after 50ms/);
    expect(manager.list()[0]!.status).toBe("running");
    manager.close(record.id);
  });
});

describe("coordination tools", () => {
  it("spawn/list/wait/close round-trip through the tool surface", async () => {
    const { manager, workerHandle, release } = await makeFixture([], { gated: true });
    const tools = Object.fromEntries(createSubAgentTools(manager).map((t) => [t.name, t]));

    expect(Object.keys(tools).sort()).toEqual([
      "close_agent",
      "list_agents",
      "spawn_agent",
      "wait_agent",
    ]);

    const spawned = await tools["spawn_agent"]!.execute!("1", {
      task: "inspect the fixture project",
    });
    const spawnText = (spawned.content as Array<{ text: string }>)[0]!.text;
    expect(spawnText).toContain("Spawned w1");
    const id = /^Spawned (w\d+)/.exec(spawnText)![1]!;

    const listed = await tools["list_agents"]!.execute!("2", {});
    expect((listed.content as Array<{ text: string }>)[0]!.text).toContain(`${id} [running]`);

    // The worker now answers: script it, then open the gate.
    workerHandle.setResponses([fauxAssistantMessage([fauxText("Report: all good.")])]);
    release();
    const waited = await tools["wait_agent"]!.execute!("3", { id });
    expect((waited.content as Array<{ text: string }>)[0]!.text).toContain("Report: all good.");

    const closed = await tools["close_agent"]!.execute!("4", { id });
    expect((closed.content as Array<{ text: string }>)[0]!.text).toContain(id);
  });

  it("propagates spawn errors (cap) as tool failures", async () => {
    const { manager } = await makeFixture();
    const tools = Object.fromEntries(createSubAgentTools(manager).map((t) => [t.name, t]));
    await expect(tools["wait_agent"]!.execute!("1", { id: "w404" })).rejects.toThrow(
      /Unknown sub-agent/,
    );
  });
});

describe("lastAssistantText", () => {
  it("takes the newest non-empty assistant text", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "user", content: [{ type: "text", text: "question" }] },
      { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
      { role: "assistant", content: [{ type: "text", text: "final answer" }] },
    ];
    expect(lastAssistantText(messages)).toBe("final answer");
  });

  it("skips empty assistant messages and returns '' when none", () => {
    expect(
      lastAssistantText([
        { role: "assistant", content: [{ type: "text", text: "   " }] },
        { role: "user", content: "hi" },
      ]),
    ).toBe("");
  });
});
