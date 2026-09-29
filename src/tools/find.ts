import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveWorkspacePath, toRelative } from "./paths.js";

const FindParams = Type.Object({
  pattern: Type.String({
    description: 'Glob pattern, e.g. "**/*.ts", "src/*.js", "package.json"',
  }),
  path: Type.Optional(
    Type.String({ description: "Directory to search from (default: project root)" }),
  ),
  maxResults: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 2000, description: "Cap on returned paths (default 500)" }),
  ),
});

export type FindParams = Static<typeof FindParams>;

export interface FindToolDetails {
  count: number;
  truncated: boolean;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);
const DEFAULT_MAX_RESULTS = 500;

/** Convert a glob to a RegExp; `**` crosses directories, `*`/`?` do not. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * find — glob path lookup.
 *
 * Returns sorted relative paths so output is stable across runs (a test can
 * assert exact arrays, and the model can rely on ordering).
 */
export function createFindTool(projectRoot: string): AgentTool<typeof FindParams, FindToolDetails> {
  return {
    name: "find",
    label: "Find files",
    description:
      "Find files by glob pattern (** crosses directories). Returns sorted relative paths.",
    parameters: FindParams,
    execute: async (_toolCallId, params) => {
      const searchRoot = params.path
        ? resolveWorkspacePath(projectRoot, params.path)
        : path.resolve(projectRoot);
      const re = globToRegExp(params.pattern);
      const maxResults = params.maxResults ?? DEFAULT_MAX_RESULTS;

      const results: string[] = [];
      let truncated = false;

      const walk = (dir: string) => {
        if (truncated) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (truncated) return;
          const full = path.join(dir, entry.name);
          const rel = toRelative(projectRoot, full).split(path.sep).join("/");
          if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
            // A directory itself may match (e.g. pattern "src")
            if (re.test(rel)) push(rel);
            walk(full);
          } else if (entry.isFile() || entry.isSymbolicLink()) {
            if (re.test(rel)) push(rel);
          }
        }
      };
      const push = (rel: string) => {
        if (results.length >= maxResults) {
          truncated = true;
          return;
        }
        results.push(rel);
      };

      walk(searchRoot);
      results.sort();

      const details: FindToolDetails = { count: results.length, truncated };
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No files matching ${params.pattern}` }],
          details,
        };
      }
      const header = truncated
        ? `${results.length}+ paths (capped at ${maxResults}; narrow the pattern)`
        : `${results.length} path(s)`;
      return {
        content: [{ type: "text", text: `${header}\n${results.join("\n")}` }],
        details,
      };
    },
  };
}
