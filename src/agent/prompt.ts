import fs from "node:fs";
import path from "node:path";

/**
 * System prompt: identity + environment + project memory + skill index.
 *
 * Progressive disclosure lives here: skills contribute only a one-line
 * `name: description` entry; the full body arrives later through the
 * load_skill tool, so unused skills cost zero context tokens.
 */

export interface SystemPromptInput {
  projectRoot: string;
  platform: string;
  memory?: string | undefined;
  skills?: string | undefined;
}

export const TINYCODE_VERSION = "1.0.0";

export function buildSystemPrompt(input: SystemPromptInput): string {
  const parts: string[] = [];

  parts.push(
    `You are TinyCode v${TINYCODE_VERSION}, a coding agent operating directly in the user's project directory.`,
  );

  parts.push(
    [
      "## Environment",
      `- Project: ${input.projectRoot}`,
      `- Platform: ${input.platform}`,
      `- Working directory rules: all file paths are relative to the project root.`,
    ].join("\n"),
  );

  parts.push(
    [
      "## How you work",
      "- Prefer small, verifiable steps: read before you edit, run the tests after you change code.",
      "- Use the read tool with offset/limit to window large files instead of guessing contents.",
      "- Edits must match existing text exactly (copy it); after editing, verify with read or a test run.",
      "- Non-zero exit codes from bash are data, not failures: read stdout/stderr and decide.",
      "- When a tool call is blocked by permissions, report the reason to the user; do not retry the same blocked action in a loop.",
      "- Keep replies concise: state what you did and what you verified.",
    ].join("\n"),
  );

  if (input.memory) {
    parts.push(`## Project memory\n${input.memory}`);
  }

  if (input.skills) {
    parts.push(
      [
        "## Skills",
        "The following skills are available. Call load_skill(name) to read a skill's full instructions before applying it.",
        input.skills,
      ].join("\n"),
    );
  }

  return parts.join("\n\n");
}

/**
 * Project memory: TINY.md is the standard; AGENTS.md/CLAUDE.md are honored
 * as compatible extras so existing repos work unchanged.
 */
export function readProjectMemory(projectRoot: string): string | undefined {
  const parts: string[] = [];
  for (const name of ["TINY.md", "AGENTS.md", "CLAUDE.md"]) {
    try {
      const text = fs.readFileSync(path.join(projectRoot, name), "utf8").trim();
      if (text.length > 0) parts.push(`### ${name}\n\n${text}`);
    } catch {
      // file absent: skip
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
