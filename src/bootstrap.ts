import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { TinyCodeRuntime } from "./agent/runtime.js";
import { buildSystemPrompt, readProjectMemory } from "./agent/prompt.js";
import type { Summarizer } from "./context/manager.js";
import { ContextManager } from "./context/manager.js";
import { SessionManager, sessionsDir } from "./session/manager.js";
import { PermissionManager, type PermissionPromptFn } from "./permissions/manager.js";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  createLoadSkillTool,
} from "./tools/index.js";
import { ToolRegistry } from "./tools/registry.js";
import { discoverSkills, skillIndex } from "./skills/discovery.js";
import { McpManager } from "./mcp/client.js";
import { SubAgentManager, WORKER_SYSTEM_PROMPT } from "./subagents/manager.js";
import { createSubAgentTools } from "./subagents/tools.js";
import type { TinyCodeConfig } from "./config/schema.js";
import { ModelRegistry, type ModelRef } from "./model/registry.js";

const COMPACTION_SYSTEM_PROMPT =
  "You summarize coding-agent conversations. Produce a dense handoff note: the user's goal, " +
  "what was tried, files modified (with paths), current state, test/build results, and exact next steps. " +
  "Keep code identifiers verbatim. No prose padding.";

/**
 * bootstrapHarness assembles the whole product around the Pi Agent loop:
 * tools, permissions, context policy, session persistence. Both interactive
 * and headless modes build on this single function.
 */
export interface BootstrapOptions {
  projectRoot: string;
  config: TinyCodeConfig;
  /** CLI-resolved model reference (highest precedence). */
  modelRef?: ModelRef;
  /** Force the offline mock model. */
  mock?: boolean;
  /** Session lifecycle: fresh, attach an existing id, or none (ephemeral). */
  session?: { mode: "new" } | { mode: "attach"; id: string };
  /** Permission dialog hook; omit for headless (ASK degrades to deny). */
  permissionPrompt?: PermissionPromptFn;
  /** Permission mode override (CLI flag already resolved by the caller). */
  permissionMode?: "ask" | "auto";
  /** Injected registry (tests); otherwise a fresh builtin catalog. */
  models?: ModelRegistry;
}

export interface Harness {
  projectRoot: string;
  config: TinyCodeConfig;
  models: ModelRegistry;
  model: Model<any>;
  isMock: boolean;
  permissions: PermissionManager;
  contextManager: ContextManager;
  runtime: TinyCodeRuntime;
  tools: ToolRegistry;
  mcp: McpManager;
  subAgents: SubAgentManager;
  session?: SessionManager;
  shutdown(): Promise<void>;
}

export async function bootstrapHarness(options: BootstrapOptions): Promise<Harness> {
  const { projectRoot, config } = options;

  // --- Model ---------------------------------------------------------------
  const models = options.models ?? new ModelRegistry();
  // Cap output: full 32k+ defaults trip prepaid-credit preflight checks
  // (e.g. OpenRouter 402). Override via config.maxOutputTokens.
  models.setMaxOutputTokens(config.maxOutputTokens ?? 16384);
  if (options.mock || process.env["TINYCODE_MODEL"] === "mock") {
    models.enableMock();
  }
  const resolution = await models.resolve(options.modelRef ?? {});
  const model = resolution.model;

  // --- Permissions ---------------------------------------------------------
  const permissions = new PermissionManager({
    mode: options.permissionMode ?? config.permissionMode ?? "ask",
    projectRoot,
    ...(options.permissionPrompt ? { prompt: options.permissionPrompt } : {}),
  });

  // --- Context policy ------------------------------------------------------
  const contextLimit = typeof model.contextWindow === "number" ? model.contextWindow : undefined;
  const contextManager = new ContextManager({
    maxToolResultChars: config.context?.maxToolResultChars ?? 30_000,
    compactAboveTokens:
      config.context?.compactAboveTokens ??
      (contextLimit ? Math.floor(contextLimit * 0.8) : 100_000),
    keepRecentMessages: config.context?.keepRecentMessages ?? 12,
    artifactsDir: path.join(sessionsDir(), "artifacts"),
  });

  // --- Session -------------------------------------------------------------
  let session: SessionManager | undefined;
  if (options.session) {
    session = new SessionManager(sessionsDir(), {
      titleFrom: firstUserTitle,
    });
    if (options.session.mode === "new") {
      session.start(projectRoot, `${model.provider}/${model.id}`);
    } else {
      session.attach(options.session.id, projectRoot, `${model.provider}/${model.id}`);
    }
  }

  // --- Tools (one registry, uniform surface) -------------------------------
  const tools = new ToolRegistry();
  const factories: Array<(root: string) => AgentTool<any>> = [
    createReadTool,
    createWriteTool,
    createEditTool,
    createBashTool,
    createGrepTool,
    createFindTool,
    createLsTool,
  ];
  for (const factory of factories) tools.register(factory(projectRoot));

  // --- Skills (progressive disclosure, ARCHITECTURE §8) --------------------
  const skills = discoverSkills(projectRoot);
  if (skills.length > 0) tools.register(createLoadSkillTool(skills));

  // --- Sub-agents (read-only workers; ARCHITECTURE §10) --------------------
  // Registered before MCP so a conflicting MCP name gets qualified instead of
  // shadowing a coordination tool. Workers are assembled with a *fresh*
  // registry holding only the read-only subset — they never see spawn_agent,
  // nor write/edit/bash, which is what makes them safe to fan out to.
  const summarize = makeDefaultSummarizer(models, model);
  const subAgents = new SubAgentManager({
    createRuntime: () =>
      new TinyCodeRuntime({
        projectRoot,
        systemPrompt: WORKER_SYSTEM_PROMPT,
        model,
        streamFn: models.collection.streamSimple.bind(models.collection),
        tools: makeWorkerToolRegistry(projectRoot),
        permissions,
        contextManager,
        summarize,
        // Workers never touch the session log: the root owns it.
      }),
  });
  for (const tool of createSubAgentTools(subAgents)) tools.register(tool);

  // --- MCP (connect in parallel; failures recorded, never fatal) -----------
  // Registered after the built-ins so a conflicting MCP name gets the
  // `<server>_<tool>` qualification instead of shadowing a core tool.
  const mcp = new McpManager({ servers: config.mcpServers ?? {} });
  await mcp.connect(tools);

  // --- System prompt -------------------------------------------------------
  const memory = readProjectMemory(projectRoot);
  const systemPrompt = buildSystemPrompt({
    projectRoot,
    platform: `${os.platform()} ${os.arch()} · node ${process.version}`,
    memory,
    skills: skillIndex(skills),
  });

  // --- Runtime (five hooks) ------------------------------------------------
  const runtime = new TinyCodeRuntime({
    projectRoot,
    systemPrompt,
    model,
    streamFn: models.collection.streamSimple.bind(models.collection),
    tools,
    permissions,
    contextManager,
    summarize,
    session,
  });

  // Resume an attached session into the live transcript (read-only load).
  if (session && options.session?.mode === "attach") {
    const loaded = session.load(options.session.id);
    if (loaded) {
      runtime.agent.state.messages.splice(
        0,
        runtime.agent.state.messages.length,
        ...(loaded.messages as never[]),
      );
    }
  }

  return {
    projectRoot,
    config,
    models,
    model,
    isMock: resolution.mock,
    permissions,
    contextManager,
    runtime,
    tools,
    mcp,
    subAgents,
    session,
    async shutdown() {
      subAgents.shutdown();
      await mcp.shutdown();
    },
  };
}

/**
 * The worker tool subset: read-only project inspection, nothing else.
 * Deliberately omits write/edit/bash and all coordination tools — a worker
 * can look but never touch, and can never spawn its own children.
 */
export function makeWorkerToolRegistry(projectRoot: string): ToolRegistry {
  const registry = new ToolRegistry();
  for (const factory of [createReadTool, createGrepTool, createFindTool, createLsTool]) {
    registry.register(factory(projectRoot));
  }
  return registry;
}

/** Title policy: first user message, first line, trimmed. */
function firstUserTitle(message: unknown): string | undefined {
  const m = message as { role?: string; content?: unknown };
  if (m.role !== "user") return undefined;
  const text =
    typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content
            .map((b) =>
              b && typeof b === "object" && "text" in b
                ? String((b as { text: unknown }).text)
                : "",
            )
            .join(" ")
        : "";
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.split("\n")[0]!.slice(0, 60);
}

/** Default compaction summarizer: one plain LLM call via pi-ai. */
export function makeDefaultSummarizer(models: ModelRegistry, model: Model<any>): Summarizer {
  return async (transcript, signal) => {
    try {
      const message = await models.collection.completeSimple(
        model,
        {
          systemPrompt: COMPACTION_SYSTEM_PROMPT,
          messages: [{ role: "user", content: transcript, timestamp: Date.now() }],
        },
        { signal },
      );
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      return text.length > 0 ? text : "(empty summary)";
    } catch (error) {
      return `(summary failed: ${(error as Error).message})`;
    }
  };
}
