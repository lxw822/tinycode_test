import fs from "node:fs";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveWorkspacePath, toRelative } from "./paths.js";
import { diffSummary, unifiedDiff } from "./diff.js";

const EditParams = Type.Object({
  path: Type.String({ description: "File path (relative to the project root)" }),
  oldText: Type.String({
    description: "Exact text to replace (must match exactly once unless replaceAll)",
  }),
  newText: Type.String({ description: "Replacement text" }),
  replaceAll: Type.Optional(
    Type.Boolean({ description: "Replace every occurrence instead of requiring exactly one" }),
  ),
});

export type EditParams = Static<typeof EditParams>;

export interface EditToolDetails {
  path: string;
  matches: number;
  added: number;
  removed: number;
  diff: string;
}

/**
 * edit — exact-match replacement.
 *
 * Failure modes are deliberate and model-readable:
 * - 0 matches → tell the model the text was not found (copy it exactly)
 * - >1 match  → refuse unless replaceAll (silently picking one is a bug)
 * - success   → return a unified diff so the model verifies its own edit
 */
export function createEditTool(projectRoot: string): AgentTool<typeof EditParams, EditToolDetails> {
  return {
    name: "edit",
    label: "Edit file",
    description:
      "Replace an exact text match in a file. The old text must match exactly once " +
      "(pass replaceAll=true to replace every occurrence). Returns a unified diff.",
    parameters: EditParams,
    execute: async (_toolCallId, params) => {
      const abs = resolveWorkspacePath(projectRoot, params.path);

      let before: string;
      try {
        before = fs.readFileSync(abs, "utf8");
      } catch {
        throw new Error(`File not found: ${params.path} (use write to create it)`);
      }

      if (params.oldText === params.newText) {
        throw new Error("oldText and newText are identical; nothing to change");
      }

      // Count occurrences by scanning non-overlapping matches.
      const occurrences: number[] = [];
      let searchFrom = 0;
      for (;;) {
        const at = before.indexOf(params.oldText, searchFrom);
        if (at === -1) break;
        occurrences.push(at);
        searchFrom = at + params.oldText.length;
      }

      if (occurrences.length === 0) {
        const preview =
          params.oldText.length > 200 ? `${params.oldText.slice(0, 200)}…` : params.oldText;
        throw new Error(
          `oldText not found in ${params.path}. Copy the existing text exactly, including whitespace. ` +
            `Looked for:\n${preview}`,
        );
      }
      if (occurrences.length > 1 && !params.replaceAll) {
        throw new Error(
          `oldText matches ${occurrences.length} times in ${params.path}; it must match exactly once. ` +
            `Add more surrounding context to disambiguate, or set replaceAll=true.`,
        );
      }

      const after = before.split(params.oldText).join(params.newText);
      fs.writeFileSync(abs, after, "utf8");

      const details: EditToolDetails = {
        path: toRelative(projectRoot, abs),
        matches: occurrences.length,
        added: 0,
        removed: 0,
        diff: unifiedDiff(before, after, {
          oldLabel: `a/${detailsPath(projectRoot, abs)}`,
          newLabel: `b/${detailsPath(projectRoot, abs)}`,
        }),
      };
      const stats = diffSummary(before, after);
      const match = /^\+(\d+) -(\d+)$/.exec(stats);
      details.added = match ? Number(match[1]) : 0;
      details.removed = match ? Number(match[2]) : 0;

      return {
        content: [
          {
            type: "text",
            text: `${details.path}: ${occurrences.length} replacement(s), ${stats}\n\n${details.diff}`,
          },
        ],
        details,
      };
    },
  };
}

function detailsPath(projectRoot: string, abs: string): string {
  return toRelative(projectRoot, abs);
}
