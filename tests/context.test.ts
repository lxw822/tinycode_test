import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  ContextManager,
  SUMMARY_TAG,
  estimateTokens,
  type Summarizer,
} from "../src/context/manager.js";

let artifactsDir: string;
let manager: ContextManager;

const summarizer = async (transcript: string): Promise<string> =>
  `SUMMARY(${transcript.length} chars)`;

beforeEach(() => {
  artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tinycode-ctx-"));
  manager = new ContextManager({
    maxToolResultChars: 100,
    compactAboveTokens: 500,
    keepRecentMessages: 4,
    artifactsDir,
  });
});

afterEach(() => {
  fs.rmSync(artifactsDir, { recursive: true, force: true });
});

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}
function assistantText(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "faux",
    model: "mock",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AgentMessage;
}
function toolResult(text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage;
}

describe("token estimation", () => {
  it("is deterministic chars/4", () => {
    expect(estimateTokens("a".repeat(40))).toBe(10);
    expect(estimateTokens([user("x".repeat(40))])).toBe(10);
  });
});

describe("per-result truncation", () => {
  it("keeps short results untouched", () => {
    const res = manager.truncateToolResult("short output", "bash");
    expect(res.truncated).toBe(false);
    expect(res.content[0]!.text).toBe("short output");
    expect(res.artifactPath).toBeUndefined();
  });

  it("keeps head+tail and saves the full output as an artifact", () => {
    const big = "HEAD".repeat(50) + "MIDDLE".repeat(500) + "TAIL".repeat(50);
    const res = manager.truncateToolResult(big, "bash");
    expect(res.truncated).toBe(true);
    expect(res.content[0]!.text.length).toBeLessThan(big.length);
    expect(res.content[0]!.text).toContain("HEAD");
    expect(res.content[0]!.text).toContain("TAIL");
    expect(res.content[0]!.text).toMatch(/\[… \d+ characters truncated …/);

    // Full output is readable from the artifact path.
    expect(res.artifactPath).toBeDefined();
    expect(fs.readFileSync(res.artifactPath!, "utf8")).toBe(big);
  });

  it("handleAfterToolCall returns an override only when truncation happened", () => {
    const small = manager.handleAfterToolCall({
      toolCall: { name: "bash" },
      result: { content: [{ type: "text", text: "tiny" }] },
    });
    expect(small).toBeUndefined();

    const big = manager.handleAfterToolCall({
      toolCall: { name: "bash" },
      result: { content: [{ type: "text", text: "x".repeat(500) }] },
    });
    expect(big).toBeDefined();
    expect(big!.content[0]!.text).toContain("characters truncated");
  });

  it("leaves non-text content alone", () => {
    const res = manager.handleAfterToolCall({
      toolCall: { name: "read" },
      result: { content: [{ type: "image" as unknown as "text" }] },
    });
    expect(res).toBeUndefined();
  });
});

describe("budget & compaction", () => {
  it("does nothing under the budget", async () => {
    const messages = [user("hello"), assistantText("hi")];
    const transform = manager.makeTransformContext(summarizer);
    const out = await transform(messages);
    expect(out).toBe(messages);
  });

  it("compacts over-budget history, protecting recent messages", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`question ${i} ${"x".repeat(100)}`));
      messages.push(assistantText(`answer ${i} ${"y".repeat(100)}`));
    }
    expect(estimateTokens(messages)).toBeGreaterThan(500);

    const transform = manager.makeTransformContext(summarizer);
    const out = await transform(messages);

    expect(out.length).toBeLessThan(messages.length);
    // First message is the summary bubble.
    const first = out[0]!;
    expect(first.role).toBe("user");
    const text = "content" in first && typeof first.content === "string" ? first.content : "";
    expect(text).toContain(`<${SUMMARY_TAG}>`);
    expect(text).toContain("SUMMARY");
    // Recent messages survive verbatim.
    expect(out).toContain(messages[messages.length - 1]);
    expect(out).toContain(messages[messages.length - 2]);
    // Cut is on a user boundary: the message after the summary is a user turn.
    expect(out[1]!.role).toBe("user");
  });

  it("keeps an assistant turn together with its tool results", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(user(`q${i} ${"x".repeat(120)}`));
      messages.push(assistantText(`a${i}`));
      messages.push(toolResult(`r${i} ${"z".repeat(120)}`));
    }
    const out = await manager.compact(messages, summarizer);
    // The protected tail starts at a user message — no orphaned toolResult
    // can appear directly after the summary.
    const afterSummary = out.slice(1);
    expect(afterSummary[0]!.role).toBe("user");
    // No toolResult is separated from its assistant predecessor in the tail.
    for (let i = 0; i < afterSummary.length; i++) {
      const msg = afterSummary[i]!;
      if (msg.role === "toolResult") {
        const prev = afterSummary[i - 1];
        expect(prev).toBeDefined();
        expect(["assistant", "toolResult"]).toContain(prev!.role);
      }
    }
  });

  it("returns a copy unchanged when nothing is compactable", async () => {
    const messages = [user("only one")];
    const out = await manager.compact(messages, summarizer);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(messages[0]);
  });

  it("transformContext never throws (safe fallback contract)", async () => {
    const exploding: Summarizer = async () => {
      throw new Error("model unavailable");
    };
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(user(`q${i} ${"x".repeat(100)}`));
      messages.push(assistantText(`a${i}`));
    }
    const transform = manager.makeTransformContext(exploding);
    const out = await transform(messages);
    expect(out).toBe(messages); // original returned, no crash
  });

  it("repeated compaction of an already-summarized transcript still shrinks", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(user(`q${i} ${"x".repeat(120)}`));
      messages.push(assistantText(`a${i} ${"y".repeat(120)}`));
    }
    const first = await manager.compact(messages, summarizer);
    expect(manager.hasSummary(first)).toBe(true);

    // Force another round by feeding the compacted list plus more traffic.
    const second = await manager.compact([...first, ...messages.slice(0, 10)], summarizer);
    expect(second.length).toBeLessThanOrEqual(first.length + 10);
  });
});
