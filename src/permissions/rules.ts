import { classifyShellCommand, type ShellRisk } from "./classifier.js";
import { isInsideWorkspace } from "../tools/paths.js";

/**
 * Per-tool default verdicts, before memory/mode/dialog.
 *
 *   allow — no friction (reads inside the project)
 *   ask   — needs approval (writes, reads outside, unknown tools)
 *   deny  — catastrophic, never approvable
 *
 * The classifier's "blocked" verdict maps to deny at this layer so the
 * hard-refusal is decided by data, not by the dialog.
 */
export type VerdictAction = "allow" | "ask" | "deny";

export interface ToolVerdict {
  action: VerdictAction;
  reason: string;
  /** "Always allow" pattern key when this verdict is ask-able. */
  pattern?: string;
  risk?: ShellRisk;
}

function extractPath(args: Record<string, unknown>): string | undefined {
  const value = args["path"];
  return typeof value === "string" ? value : undefined;
}

/**
 * Decide the default verdict for one tool call.
 *
 * `projectRoot` is used to distinguish "read inside the project" from
 * "read outside the project" for path-taking tools.
 */
export function evaluateToolCall(
  toolName: string,
  args: Record<string, unknown>,
  projectRoot: string,
): ToolVerdict {
  if (toolName === "bash") {
    const command = typeof args["command"] === "string" ? args["command"] : "";
    const classification = classifyShellCommand(command);
    switch (classification.risk) {
      case "blocked":
        return { action: "deny", reason: classification.reason, risk: "blocked" };
      case "safe":
        return { action: "allow", reason: classification.reason, risk: "safe" };
      case "destructive":
        return {
          action: "ask",
          reason: classification.reason,
          pattern: classification.pattern ?? command,
          risk: "destructive",
        };
      case "write":
      default:
        return {
          action: "ask",
          reason: classification.reason,
          pattern: classification.pattern ?? command,
          risk: "write",
        };
    }
  }

  if (toolName === "read" || toolName === "ls") {
    const p = extractPath(args);
    if (p === undefined || p === "." || isInsideWorkspace(projectRoot, p)) {
      return { action: "allow", reason: "read inside project", risk: "safe" };
    }
    return { action: "ask", reason: "reads a path outside the project", pattern: toolName };
  }

  if (toolName === "write" || toolName === "edit") {
    return { action: "ask", reason: "modifies a file", pattern: toolName };
  }

  if (toolName === "grep" || toolName === "find") {
    const p = extractPath(args);
    if (p === undefined || isInsideWorkspace(projectRoot, p)) {
      return { action: "allow", reason: "search inside project", risk: "safe" };
    }
    return { action: "ask", reason: "searches a path outside the project", pattern: toolName };
  }

  // Unknown tools (MCP, sub-agents, future additions) never auto-allow.
  return { action: "ask", reason: `unrecognized tool "${toolName}"`, pattern: toolName };
}
