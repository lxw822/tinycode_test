import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * ContextManager owns two policies:
 *
 * 1. Per-result truncation (afterToolCall): oversized tool output keeps
 *    head+tail with an explicit marker; the full output is saved to an
 *    artifact file so nothing is silently lost.
 * 2. Budget & compaction (transformContext): when the transcript exceeds the
 *    token budget, older turns collapse into one summary message while the
 *    newest messages stay verbatim. Cut points sit on user-message boundaries
 *    so an assistant turn never loses its tool results.
 *
 * Token estimation is chars/4 — deterministic and offline, which is what
 * makes context behavior testable without a tokenizer download.
 */

/** A summarizer turns the serialized old conversation into one dense note. */
export type Summarizer = (transcript: string, signal?: AbortSignal) => Promise<string>;

export interface ContextManagerOptions {
  maxToolResultChars: number;
  compactAboveTokens: number;
  keepRecentMessages: number;
  artifactsDir: string;
}

export const SUMMARY_TAG = "conversation-summary";

export function estimateTokens(messages: AgentMessage[] | string): number {
  const text = typeof messages === "string" ? messages : serializeMessages(messages);
  return Math.ceil(text.length / 4);
}

/** Cheap deterministic serialization for token accounting. */
export function serializeMessages(messages: AgentMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "user":
        parts.push(
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        );
        break;
      case "assistant":
        for (const block of message.content) {
          if (block.type === "text") parts.push(block.text);
          else if (block.type === "toolCall")
            parts.push(`${block.name} ${JSON.stringify(block.arguments)}`);
        }
        break;
      case "toolResult":
        for (const block of message.content) {
          if (block.type === "text") parts.push(block.text);
        }
        break;
      default:
        parts.push(JSON.stringify(message));
    }
  }
  return parts.join("\n");
}

export interface TruncationResult {
  content: Array<{ type: "text"; text: string }>;
  truncated: boolean;
  artifactPath?: string;
}

export class ContextManager {
  readonly maxToolResultChars: number;
  readonly compactAboveTokens: number;
  readonly keepRecentMessages: number;
  readonly artifactsDir: string;

  constructor(options: ContextManagerOptions) {
    this.maxToolResultChars = options.maxToolResultChars;
    this.compactAboveTokens = options.compactAboveTokens;
    this.keepRecentMessages = options.keepRecentMessages;
    this.artifactsDir = options.artifactsDir;
  }

  estimate(messages: AgentMessage[]): number {
    return estimateTokens(messages);
  }

  /**
   * Head+tail truncation. The marker states exactly how much was dropped and
   * where the full output lives — the model can still fetch details via read.
   */
  truncateToolResult(text: string, label: string): TruncationResult {
    if (text.length <= this.maxToolResultChars) {
      return { content: [{ type: "text", text }], truncated: false };
    }

    const headLen = Math.floor(this.maxToolResultChars * 0.6);
    const tailLen = this.maxToolResultChars - headLen;
    const head = text.slice(0, headLen);
    const tail = text.slice(-tailLen);
    const dropped = text.length - headLen - tailLen;

    const artifactPath = this.saveArtifact(label, text);
    const marker = `\n[… ${dropped} characters truncated … full output saved to ${artifactPath} …]\n`;
    const merged = head + marker + tail;

    return {
      content: [{ type: "text", text: merged }],
      truncated: true,
      artifactPath,
    };
  }

  /** Persist a full tool output for later inspection. Returns the display path. */
  saveArtifact(label: string, text: string): string {
    fs.mkdirSync(this.artifactsDir, { recursive: true });
    const safe = label.replace(/[^\w.-]+/g, "_").slice(0, 60) || "artifact";
    const file = `${safe}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
    const full = path.join(this.artifactsDir, file);
    fs.writeFileSync(full, text, "utf8");
    return full;
  }

  /** afterToolCall hook body: truncate text results, keep everything else. */
  handleAfterToolCall(context: {
    toolCall: { name: string };
    result: { content: Array<{ type: string; text?: string }>; details?: unknown };
  }): { content: Array<{ type: "text"; text: string }>; details?: unknown } | undefined {
    const content = context.result.content;
    if (!Array.isArray(content) || content.length === 0) return undefined;

    let changed = false;
    const next: Array<{ type: "text"; text: string }> = [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        const result = this.truncateToolResult(block.text, context.toolCall.name);
        if (result.truncated) changed = true;
        next.push(...result.content);
      } else {
        next.push(block as { type: "text"; text: string });
      }
    }
    if (!changed) return undefined;
    return { content: next };
  }

  /**
   * transformContext hook body: compact when over budget.
   * Never throws — returns the original messages on any failure (the SDK
   * contract requires a safe fallback).
   */
  makeTransformContext(summarize: Summarizer) {
    return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
      try {
        if (estimateTokens(messages) <= this.compactAboveTokens) return messages;
        return await this.compact(messages, summarize, signal);
      } catch {
        return messages;
      }
    };
  }

  /**
   * Compact older messages into one summary, keeping the newest
   * `keepRecentMessages` verbatim.
   *
   * Cut rule: the cut index snaps to a user-message boundary (the start of a
   * user turn), so the protected tail always begins at a fresh user request
   * and no assistant message is separated from its tool results.
   */
  async compact(
    messages: AgentMessage[],
    summarize: Summarizer,
    signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    if (messages.length <= this.keepRecentMessages) return [...messages];

    // Snap the cut to a user-message boundary within reach of the keep window.
    let cut = Math.max(1, messages.length - this.keepRecentMessages);
    while (cut > 1 && messages[cut]!.role !== "user") cut--;
    if (cut <= 0 || cut >= messages.length) return [...messages];

    const older = messages.slice(0, cut);
    const recent = messages.slice(cut);

    // Already-compacted prefix + still-too-large recent: compact deeper.
    const summary = await summarize(serializeMessages(older), signal);

    const summaryMessage: AgentMessage = {
      role: "user",
      content: `<${SUMMARY_TAG}>\n${summary}\n</${SUMMARY_TAG}>\n\n(Conversation summary: earlier turns condensed. Continue from the state above.)`,
      timestamp: Date.now(),
    } as AgentMessage;

    return [summaryMessage, ...recent];
  }

  /** True when the messages already start with a summary bubble. */
  hasSummary(messages: AgentMessage[]): boolean {
    const first = messages[0];
    if (!first || first.role !== "user") return false;
    const text = typeof first.content === "string" ? first.content : "";
    return text.includes(`<${SUMMARY_TAG}>`);
  }
}
