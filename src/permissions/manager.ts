import { evaluateToolCall, type ToolVerdict } from "./rules.js";

/**
 * Permission modes.
 *
 * - "ask": ASK verdicts go to the dialog (or deny when no dialog exists)
 * - "auto": ASK verdicts are approved automatically (still respects hard deny)
 */
export type PermissionMode = "ask" | "auto";

export interface PermissionDecision {
  action: "allow" | "deny";
  reason: string;
  /** Set when the verdict was ask-able (for UI display / memory). */
  pattern?: string;
  /** How the decision was reached — useful in tests and transcripts. */
  source: "rule" | "memory" | "mode" | "dialog" | "default-deny" | "hard-deny";
}

export interface PermissionRequest {
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  pattern: string;
  risk?: string;
}

export type PermissionAnswer = "allow-once" | "allow-always" | "deny";
export type PermissionPromptFn = (request: PermissionRequest) => Promise<PermissionAnswer>;

export interface PermissionManagerOptions {
  projectRoot: string;
  mode?: PermissionMode;
  prompt?: PermissionPromptFn;
}

/**
 * The runtime gate — order of evaluation, exactly:
 *
 *   1. hard DENY (catastrophic shell)   → refused; auto mode and dialogs never override
 *   2. ALLOW verdict                    → run
 *   3. ASK verdict                      → remembered pattern? → allow
 *                                         mode === "auto"?     → allow
 *                                         prompt available?    → dialog decides
 *                                         otherwise            → safe DENY
 *
 * The last line is what makes headless `-p` safe by default: with no dialog
 * to connect, ASK degrades to deny rather than to allow.
 */
export class PermissionManager {
  private readonly remembered = new Set<string>();
  private mode: PermissionMode;
  private readonly projectRoot: string;
  private readonly prompt?: PermissionPromptFn;

  constructor(options: PermissionManagerOptions) {
    this.projectRoot = options.projectRoot;
    this.mode = options.mode ?? "ask";
    this.prompt = options.prompt;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** Grant a pattern permanently (from dialog "allow always" or config). */
  remember(pattern: string): void {
    this.remembered.add(pattern);
  }

  isRemembered(pattern: string): boolean {
    return this.remembered.has(pattern);
  }

  forget(pattern: string): void {
    this.remembered.delete(pattern);
  }

  forgetAll(): void {
    this.remembered.clear();
  }

  rememberedPatterns(): string[] {
    return [...this.remembered];
  }

  /** Full evaluation for one tool call. */
  async check(toolName: string, args: Record<string, unknown>): Promise<PermissionDecision> {
    const verdict: ToolVerdict = evaluateToolCall(toolName, args, this.projectRoot);

    // 1. Hard deny: not overridable by mode or dialog.
    if (verdict.action === "deny") {
      return {
        action: "deny",
        reason: verdict.reason,
        source: "hard-deny",
        ...(verdict.pattern !== undefined ? { pattern: verdict.pattern } : {}),
      };
    }

    // 2. Rule-level allow.
    if (verdict.action === "allow") {
      return { action: "allow", reason: verdict.reason, source: "rule" };
    }

    // 3. Ask path.
    const pattern = verdict.pattern ?? toolName;

    if (this.remembered.has(pattern)) {
      return { action: "allow", reason: `remembered: ${pattern}`, source: "memory", pattern };
    }

    if (this.mode === "auto") {
      return { action: "allow", reason: `auto mode: ${verdict.reason}`, source: "mode", pattern };
    }

    if (this.prompt) {
      const answer = await this.prompt({
        toolName,
        args,
        reason: verdict.reason,
        pattern,
        ...(verdict.risk !== undefined ? { risk: verdict.risk } : {}),
      });
      if (answer === "allow-always") this.remembered.add(pattern);
      if (answer === "allow-once" || answer === "allow-always") {
        return {
          action: "allow",
          reason: `approved via dialog (${answer})`,
          source: "dialog",
          pattern,
        };
      }
      return { action: "deny", reason: `denied via dialog`, source: "dialog", pattern };
    }

    // No dialog: ASK degrades to deny (headless default).
    return {
      action: "deny",
      reason: `${verdict.reason} — approval required but no dialog is available (headless mode; use --permission-mode auto to allow)`,
      source: "default-deny",
      pattern,
    };
  }
}
