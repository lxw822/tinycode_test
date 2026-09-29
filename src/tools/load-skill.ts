import fs from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Skill } from "../skills/discovery.js";

/**
 * load_skill — the second half of progressive disclosure (ARCHITECTURE §8).
 *
 * The system prompt only ever carries `name: description` lines; the model
 * calls this tool when a skill matches the task and the full body arrives as
 * a normal tool result. Unused skills therefore cost zero context tokens.
 *
 * Safety: the model supplies a NAME, never a path. It is resolved against
 * the discovery-time map, so there is nothing to traverse — a name that was
 * not discovered simply does not resolve.
 */

export const LoadSkillParams = Type.Object({
  name: Type.String({
    description: "Skill name exactly as listed in the system prompt's Skills section.",
  }),
});

export interface LoadSkillDetails {
  name: string;
  scope: Skill["scope"];
  bytes: number;
}

export function createLoadSkillTool(
  skills: Skill[],
): AgentTool<typeof LoadSkillParams, LoadSkillDetails> {
  const byName = new Map(skills.map((s) => [s.name, s]));

  return {
    name: "load_skill",
    label: "Load skill",
    description:
      "Load the full instructions of a listed skill by name. Returns the skill's " +
      "complete body (frontmatter stripped). Call this before applying a skill.",
    parameters: LoadSkillParams,
    execute: async (_toolCallId, params) => {
      const skill = byName.get(params.name);
      if (!skill) {
        const available = skills.map((s) => s.name).join(", ");
        throw new Error(
          `Unknown skill: ${params.name}` +
            (available.length > 0 ? ` (available: ${available})` : " (no skills installed)"),
        );
      }

      let raw: string;
      try {
        raw = fs.readFileSync(skill.file, "utf8");
      } catch {
        throw new Error(`Skill file unreadable: ${skill.file}`);
      }

      const body = stripFrontmatter(raw);
      return {
        content: [{ type: "text" as const, text: `# ${skill.name}\n\n${body}` }],
        details: { name: skill.name, scope: skill.scope, bytes: Buffer.byteLength(body) },
      };
    },
  };
}

/** Drop the leading `---` frontmatter block; keep everything after it. */
function stripFrontmatter(raw: string): string {
  const normalized = raw.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return normalized;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---")
      return lines
        .slice(i + 1)
        .join("\n")
        .replace(/^\n+/, "");
  }
  return normalized;
}
