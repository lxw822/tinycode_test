import fs from "node:fs";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveWorkspacePath, toRelative } from "./paths.js";

const ReadParams = Type.Object({
  path: Type.String({ description: "File path (relative to the project root)" }),
  offset: Type.Optional(
    Type.Integer({ minimum: 1, description: "1-based line number to start reading from" }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, description: "Maximum number of lines to return" }),
  ),
});

export type ReadParams = Static<typeof ReadParams>;

/** Lines per chunk: a window keeps huge files from flooding the context. */
const DEFAULT_LIMIT = 2000;
/** Bytes above which we treat a file as binary and refuse to decode. */
const BINARY_SNIFF_BYTES = 8000;

function looksBinary(buf: Buffer): boolean {
  const sniff = buf.subarray(0, BINARY_SNIFF_BYTES);
  if (sniff.includes(0)) return true;
  // Heuristic: high ratio of control characters ⇒ not text.
  let control = 0;
  for (const byte of sniff) {
    if (byte < 9 || (byte > 13 && byte < 32)) control++;
  }
  return sniff.length > 0 && control / sniff.length > 0.3;
}

export interface ReadToolDetails {
  path: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

/**
 * read — numbered lines with offset/limit windows.
 *
 * Behavior contract (the model relies on these):
 * - output is `N→ content`, 1-based, so the model can quote line numbers
 * - missing file / directory / binary produce readable errors, not stack traces
 * - the window is explicit: the model always knows where it is in the file
 */
export function createReadTool(projectRoot: string): AgentTool<typeof ReadParams, ReadToolDetails> {
  return {
    name: "read",
    label: "Read file",
    description:
      "Read a text file from the project. Returns lines prefixed with 1-based line numbers. " +
      "Use offset/limit to window large files.",
    parameters: ReadParams,
    execute: async (_toolCallId, params) => {
      const abs = resolveWorkspacePath(projectRoot, params.path);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        throw new Error(`File not found: ${params.path}`);
      }
      if (stat.isDirectory()) {
        throw new Error(`Path is a directory, not a file: ${params.path} (use ls to list it)`);
      }

      const buf = fs.readFileSync(abs);
      if (looksBinary(buf)) {
        throw new Error(
          `Binary file, refusing to read as text: ${params.path} (${stat.size} bytes)`,
        );
      }

      const text = buf.toString("utf8");
      // Normalize: keep the final newline out of the line array.
      const lines = text.split(/\r?\n/);
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      const total = lines.length;

      const start = params.offset !== undefined ? Math.max(1, params.offset) : 1;
      const limit = params.limit !== undefined ? params.limit : DEFAULT_LIMIT;
      const window = lines.slice(start - 1, start - 1 + limit);
      const endLine = start - 1 + window.length;

      const numbered = window
        .map((line, i) => `${String(start + i).padStart(6)}→ ${line}`)
        .join("\n");

      const details: ReadToolDetails = {
        path: toRelative(projectRoot, abs),
        totalLines: total,
        startLine: start,
        endLine,
        truncated: endLine < total,
      };

      const header = `(${start}-${endLine} of ${total} lines)`;
      const body = window.length === 0 ? "(no lines in window)" : numbered;
      return {
        content: [{ type: "text", text: `${header}\n${body}` }],
        details,
      };
    },
  };
}
