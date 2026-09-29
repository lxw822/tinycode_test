import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveWorkspacePath, toRelative } from "./paths.js";

const LsParams = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to list (default: project root)" })),
});

export type LsParams = Static<typeof LsParams>;

export interface LsEntry {
  name: string;
  type: "dir" | "file" | "symlink" | "other";
  size: number;
}

export interface LsToolDetails {
  path: string;
  entries: LsEntry[];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

/**
 * ls — one directory, dirs first, with type markers and sizes.
 *
 * Deliberately non-recursive: the model navigates step by step and never
 * drowns in a deep listing.
 */
export function createLsTool(projectRoot: string): AgentTool<typeof LsParams, LsToolDetails> {
  return {
    name: "ls",
    label: "List directory",
    description: "List a directory: subdirectories first, then files, with sizes.",
    parameters: LsParams,
    execute: async (_toolCallId, params) => {
      const dir = params.path
        ? resolveWorkspacePath(projectRoot, params.path)
        : path.resolve(projectRoot);

      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw new Error(`Directory not found: ${params.path ?? "."}`);
        if (code === "ENOTDIR") throw new Error(`Not a directory: ${params.path ?? "."}`);
        throw error;
      }

      const entries: LsEntry[] = dirents
        .map((d) => {
          let type: LsEntry["type"] = "other";
          let size = 0;
          if (d.isDirectory()) type = "dir";
          else if (d.isFile()) type = "file";
          else if (d.isSymbolicLink()) type = "symlink";
          if (type === "file") {
            try {
              size = fs.statSync(path.join(dir, d.name)).size;
            } catch {
              size = 0;
            }
          }
          return { name: d.name, type, size };
        })
        .sort((a, b) => {
          const rank = (e: LsEntry) => (e.type === "dir" ? 0 : 1);
          if (rank(a) !== rank(b)) return rank(a) - rank(b);
          return a.name.localeCompare(b.name);
        });

      const marker = (e: LsEntry) => (e.type === "dir" ? "/" : "");
      const text =
        entries.length === 0
          ? "(empty directory)"
          : entries
              .map((e) =>
                e.type === "dir" ? `${e.name}/` : `${e.name}${marker(e)}\t${formatSize(e.size)}`,
              )
              .join("\n");

      return {
        content: [{ type: "text", text: `${toRelative(projectRoot, dir)}/\n${text}` }],
        details: { path: toRelative(projectRoot, dir), entries },
      };
    },
  };
}
