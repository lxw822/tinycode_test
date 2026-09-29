import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveWorkspacePath, toRelative } from "./paths.js";
import { diffSummary } from "./diff.js";

const WriteParams = Type.Object({
  path: Type.String({ description: "File path (relative to the project root)" }),
  content: Type.String({ description: "Full file content to write" }),
});

export type WriteParams = Static<typeof WriteParams>;

export interface WriteToolDetails {
  path: string;
  created: boolean;
  added: number;
  removed: number;
  bytes: number;
}

/**
 * write — create or overwrite a file.
 *
 * - creates missing parent directories
 * - reports `+a -d` against the previous content so the model sees the blast
 *   radius of an overwrite (a "write" that silently drops 200 lines is a bug
 *   the model should notice in the same turn)
 */
export function createWriteTool(
  projectRoot: string,
): AgentTool<typeof WriteParams, WriteToolDetails> {
  return {
    name: "write",
    label: "Write file",
    description:
      "Create or overwrite a file with the given content. Parent directories are created automatically.",
    parameters: WriteParams,
    execute: async (_toolCallId, params) => {
      const abs = resolveWorkspacePath(projectRoot, params.path);

      let previous: string | undefined;
      let created = false;
      try {
        previous = fs.readFileSync(abs, "utf8");
      } catch {
        created = true;
      }

      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, params.content, "utf8");

      const { added, removed } =
        previous === undefined
          ? { added: params.content.split("\n").length, removed: 0 }
          : (() => {
              // Diff against previous content for impact reporting.
              const stats = diffSummary(previous, params.content);
              const match = /^\+(\d+) -(\d+)$/.exec(stats);
              return { added: match ? Number(match[1]) : 0, removed: match ? Number(match[2]) : 0 };
            })();

      const details: WriteToolDetails = {
        path: toRelative(projectRoot, abs),
        created,
        added,
        removed,
        bytes: Buffer.byteLength(params.content, "utf8"),
      };

      const verdict = created
        ? "created"
        : `overwritten (${diffSummary(previous ?? "", params.content)})`;
      return {
        content: [
          {
            type: "text",
            text: `${details.path}: ${verdict}, ${details.bytes} bytes`,
          },
        ],
        details,
      };
    },
  };
}
