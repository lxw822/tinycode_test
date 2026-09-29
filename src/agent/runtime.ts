import { Agent, type AgentEvent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { PermissionManager } from "../permissions/manager.js";
import type { SessionManager } from "../session/manager.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ContextManager, Summarizer } from "../context/manager.js";

/**
 * TinyCodeRuntime: the ONLY place the harness touches Pi's Agent loop.
 *
 * Pi owns the mechanism (streaming, tool dispatch, abort, event broadcast);
 * this class injects the harness's five policies through the hooks Pi exposes:
 *
 * | hook               | policy                                    |
 * |--------------------|-------------------------------------------|
 * | streamFn           | auth-resolved streaming from ModelRegistry|
 * | beforeToolCall     | permission gate (can block with a reason) |
 * | afterToolCall      | tool-result truncation + artifacts        |
 * | transformContext   | auto-compaction of oversized history      |
 * | subscribe          | session persistence of finalized messages |
 *
 * Nothing here re-derives control flow: no loop, no tool-call parsing, no
 * stop conditions — that is Pi's job. Policy in, decisions out.
 */
export interface RuntimeOptions {
  projectRoot: string;
  systemPrompt: string;
  model: Model<any>;
  streamFn: StreamFn;
  tools: ToolRegistry;
  permissions: PermissionManager;
  contextManager: ContextManager;
  summarize: Summarizer;
  session?: SessionManager;
}

export class TinyCodeRuntime {
  readonly agent: Agent;

  constructor(public readonly options: RuntimeOptions) {
    this.agent = new Agent({
      // Hook 1/5: streaming — ModelRegistry's auth-resolved streamSimple.
      streamFn: options.streamFn,
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        // "minimal" rather than "off": some hosted endpoints reject requests
        // that disable reasoning outright; models without thinking support
        // ignore the hint.
        thinkingLevel: "minimal",
        tools: options.tools.list(),
      },
      // Hook 3/5: auto-compaction before each provider request.
      transformContext: options.contextManager.makeTransformContext(options.summarize),

      // Hook 2/5: permission gate — deny becomes an error tool result the
      // model can read (it learns WHY it was blocked instead of hallucinating).
      beforeToolCall: async ({ toolCall, args }) => {
        const decision = await options.permissions.check(
          toolCall.name,
          (args ?? {}) as Record<string, unknown>,
        );
        if (decision.action === "deny") {
          return { block: true, reason: `Permission denied: ${decision.reason}` };
        }
        return undefined;
      },

      // Hook 4/5: context hygiene — truncate oversized tool output.
      afterToolCall: async (context) => options.contextManager.handleAfterToolCall(context),
    });

    if (options.session) {
      const session = options.session;
      // Hook 5/5: persistence — every finalized message lands in the JSONL.
      this.agent.subscribe(async (event: AgentEvent) => {
        if (event.type === "message_end") {
          session.record(event.message);
        }
      });
    }
  }

  /** Send one user message and run the loop to completion. */
  prompt(text: string): Promise<void> {
    return this.agent.prompt(text);
  }

  abort(): void {
    this.agent.abort();
  }

  /** Hot-swap the model (/model, --model). */
  setModel(model: Model<any>): void {
    this.agent.state.model = model;
  }

  get busy(): boolean {
    return this.agent.state.isStreaming;
  }

  get messages() {
    return this.agent.state.messages;
  }

  /**
   * Manual compaction (/compact): summarize older turns and replace the live
   * transcript with [summary, ...recent]. Returns a status line.
   */
  async compactNow(): Promise<string> {
    const messages = [...this.agent.state.messages];
    if (messages.length === 0) return "Nothing to compact yet.";
    const before = this.options.contextManager.estimate(messages);
    const compacted = await this.options.contextManager.compact(messages, this.options.summarize);
    if (compacted.length === messages.length) {
      return "Nothing compactable (recent conversation is protected).";
    }
    this.agent.state.messages.splice(0, this.agent.state.messages.length, ...compacted);
    const after = this.options.contextManager.estimate(compacted);
    return `Compacted: ${messages.length} → ${compacted.length} messages (~${before} → ~${after} tokens est.)`;
  }

  waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }

  subscribe(listener: (event: AgentEvent) => Promise<void> | void): () => void {
    return this.agent.subscribe(listener);
  }
}
