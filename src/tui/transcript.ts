import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { Container, Markdown, Text, type Component } from "@earendil-works/pi-tui";
import { diffPreview, formatDuration, toolBrief } from "./format.js";
import { cyan, dim, green, markdownTheme, red } from "./themes.js";

/**
 * The transcript — ARCHITECTURE §11's ScrollView child.
 *
 * It owns the event → visual mapping for the scrollable region:
 *
 *   message_start     → open a live Text block
 *   message_update    → append text_delta (streaming)
 *   message_end       → finalize into Markdown (or fall back to the
 *                       finalized text when the provider emitted no deltas)
 *   tool_execution_*  → `● bash npm test` … `✓ exit 0 · 2.4s` + diff preview
 *   errors            → red info line
 *
 * Every mutation calls `onChange`, which the app wires to
 * `tui.requestRender()` — pi-tui does not repaint on component mutation alone.
 */
export class Transcript extends Container {
  private streaming?: Text;
  private streamingBuffer = "";
  private sawDelta = false;
  private readonly started = new Map<string, { brief: string; at: number; args: unknown }>();
  private readonly onChange: () => void;

  constructor(onChange: () => void) {
    super();
    this.onChange = onChange;
  }

  private push(component: Component): void {
    this.addChild(component);
    this.invalidate();
    this.onChange();
  }

  // --- user -------------------------------------------------------------------

  /** Render a user turn: `❯ first line`, continuation lines indented. */
  addUser(text: string): void {
    const block = text
      .split("\n")
      .map((line, index) => (index === 0 ? cyan(`❯ ${line}`) : cyan(`  ${line}`)))
      .join("\n");
    this.push(new Text(block, 1, 1));
  }

  // --- assistant streaming -----------------------------------------------------

  /** Open a live text block for an incoming assistant message. */
  beginAssistant(): void {
    this.streaming = new Text("", 1, 1);
    this.streamingBuffer = "";
    this.sawDelta = false;
    this.addChild(this.streaming);
    this.invalidate();
    this.onChange();
  }

  /** Append one provider delta to the live block. */
  appendDelta(delta: string): void {
    if (!this.streaming || delta.length === 0) return;
    this.sawDelta = true;
    this.streamingBuffer += delta;
    this.streaming.setText(this.streamingBuffer);
    this.invalidate();
    this.onChange();
  }

  /**
   * Finalize the live block into Markdown.
   *
   * `fallbackText` covers providers that never emit deltas — without it their
   * output would be silently dropped from the transcript.
   */
  endAssistant(fallbackText: string): void {
    const text = (this.sawDelta ? this.streamingBuffer : fallbackText).trim();
    const live = this.streaming;
    this.streaming = undefined;
    this.streamingBuffer = "";
    this.sawDelta = false;

    let slot = -1;
    if (live) {
      slot = this.children.indexOf(live);
      if (slot !== -1) this.children.splice(slot, 1);
    }
    if (text.length > 0) {
      const block = new Markdown(text, 1, 1, markdownTheme);
      if (slot >= 0) this.children.splice(slot, 0, block);
      else this.children.push(block);
    }
    this.invalidate();
    this.onChange();
  }

  // --- tools -------------------------------------------------------------------

  /** `● bash npm test` — remembers start time + args for the end line. */
  toolStart(toolCallId: string, toolName: string, args: unknown): void {
    const brief = toolBrief(toolName, args);
    this.started.set(toolCallId, { brief, at: Date.now(), args });
    this.push(new Text(`● ${dim(brief)}`, 1, 0));
  }

  /** `✓ exit 0 · 2.4s` plus a short `+`/`-` preview for write/edit. */
  toolEnd(
    toolCallId: string,
    toolName: string,
    isError: boolean,
    result: unknown,
    errorMessage?: string,
  ): void {
    const info = this.started.get(toolCallId);
    this.started.delete(toolCallId);
    const details = (result as { details?: Record<string, unknown> } | undefined)?.details ?? {};
    // Prefer the tool's own measurement; fall back to wall-clock for tools
    // that don't report one.
    const reported = details["durationMs"];
    const durationMs = typeof reported === "number" ? reported : info ? Date.now() - info.at : 0;
    const duration = formatDuration(durationMs);

    const exitCode = details["exitCode"];
    const timedOut = details["timedOut"] === true;
    const added = details["added"];
    const removed = details["removed"];

    let summary: string;
    if (timedOut) {
      summary = red(`  ✗ timed out · ${duration}`);
    } else if (isError) {
      summary = red(`  ✗ ${errorMessage ?? `${toolName} failed`} · ${duration}`);
    } else if (typeof exitCode === "number") {
      summary = green(`  ✓ exit ${exitCode} · ${duration}`);
    } else if (typeof added === "number" && typeof removed === "number") {
      summary = green(`  ✓ +${added} -${removed} · ${duration}`);
    } else {
      summary = green(`  ✓ ${toolName} · ${duration}`);
    }
    this.push(new Text(summary, 1, 1));

    // Diff previews sit *below* the result line so the eye lands on success/failure first.
    const preview = diffPreview(toolName, info?.args, details);
    if (preview.length > 0) {
      const block = preview
        .map((line) => (line.startsWith("+") ? green(`  ${line}`) : red(`  ${line}`)))
        .join("\n");
      this.push(new Text(block, 1, 1));
    }
  }

  // --- misc lines ----------------------------------------------------------------

  info(text: string): void {
    this.push(new Text(dim(text), 1, 1));
  }

  error(text: string): void {
    this.push(new Text(red(text), 1, 1));
  }

  /** Wipe the visible transcript (`/clear`); the session log is untouched. */
  override clear(): void {
    super.clear();
    this.streaming = undefined;
    this.streamingBuffer = "";
    this.sawDelta = false;
    this.started.clear();
    this.onChange();
  }

  // --- event plumbing -------------------------------------------------------------

  /** Map one `AgentEvent` onto the components above. */
  applyEvent(event: AgentEvent): void {
    switch (event.type) {
      case "message_start":
        if (roleOf(event.message) === "assistant") this.beginAssistant();
        break;
      case "message_update": {
        const assistantEvent = event.assistantMessageEvent;
        if (assistantEvent.type === "text_delta") this.appendDelta(assistantEvent.delta);
        break;
      }
      case "message_end": {
        if (roleOf(event.message) !== "assistant") break;
        this.endAssistant(textOf(event.message));
        const errorMessage = (event.message as { errorMessage?: string }).errorMessage;
        if (errorMessage) this.error(errorMessage);
        break;
      }
      case "tool_execution_start":
        this.toolStart(event.toolCallId, event.toolName, event.args);
        break;
      case "tool_execution_end":
        this.toolEnd(
          event.toolCallId,
          event.toolName,
          event.isError,
          event.result,
          toolErrorMessage(event.result),
        );
        break;
      default:
        break;
    }
  }
}

function roleOf(message: unknown): string {
  return String((message as { role?: string } | undefined)?.role ?? "");
}

/** Plain text of a user/assistant message (string content or text blocks). */
export function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text?: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text",
    )
    .map((block) => block.text ?? "")
    .join("");
}

/** First line of a tool call's result — used as the red `✗ …` reason. */
export function toolErrorMessage(result: unknown): string | undefined {
  const content = (result as { content?: Array<{ type: string; text?: string }> } | undefined)
    ?.content;
  const text = content?.find((block) => block.type === "text")?.text;
  if (!text) return undefined;
  return text.split("\n")[0];
}
