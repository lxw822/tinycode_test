import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveWorkspacePath, toRelative } from "./paths.js";

const GrepParams = Type.Object({
  pattern: Type.String({ description: "JavaScript regular expression to search for" }),
  path: Type.Optional(Type.String({ description: "Directory to search (default: project root)" })),
  include: Type.Optional(
    Type.String({ description: 'Glob filter for file names, e.g. "*.ts" or "src/**/*.md"' }),
  ),
  caseInsensitive: Type.Optional(Type.Boolean({ description: "Match case-insensitively" })),
  maxResults: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 1000,
      description: "Cap on returned matches (default 100)",
    }),
  ),
});

export type GrepParams = Static<typeof GrepParams>;

export interface GrepToolDetails {
  matches: number;
  files: number;
  truncated: boolean;
  skipped: number;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".tinycode"]);
const MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_RESULTS = 100;

/** Simple glob: `**` crosses directories, `*` does not, `?` single char. */
function globToRegExp(glob: string): RegExp {
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

function* walkFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".tinycode") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * grep — regex search over project text files.
 *
 * Skips node_modules/.git/binaries, caps results, and reports truncation
 * explicitly so the model knows to narrow the query instead of trusting an
 * accidental subset.
 */
export function createGrepTool(projectRoot: string): AgentTool<typeof GrepParams, GrepToolDetails> {
  return {
    name: "grep",
    label: "Search files",
    description:
      "Search text files with a JavaScript regular expression. Returns file:line:content matches. " +
      "Use include (e.g. *.ts) to narrow by file name.",
    parameters: GrepParams,
    execute: async (_toolCallId, params) => {
      const searchRoot = params.path
        ? resolveWorkspacePath(projectRoot, params.path)
        : path.resolve(projectRoot);

      let regex: RegExp;
      try {
        regex = new RegExp(params.pattern, params.caseInsensitive ? "i" : "");
      } catch (error) {
        throw new Error(`Invalid regular expression: ${(error as Error).message}`);
      }
      const includeRe = params.include ? globToRegExp(params.include) : undefined;
      const maxResults = params.maxResults ?? DEFAULT_MAX_RESULTS;

      const lines: string[] = [];
      let matches = 0;
      let files = 0;
      let skipped = 0;
      let truncated = false;

      for (const file of walkFiles(searchRoot)) {
        if (truncated) break;
        const base = path.basename(file);
        if (includeRe && !includeRe.test(base) && !includeRe.test(toRelative(projectRoot, file))) {
          continue;
        }

        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (stat.size > MAX_FILE_BYTES) {
          skipped++;
          continue;
        }

        let text: string;
        try {
          const buf = fs.readFileSync(file);
          if (buf.includes(0)) {
            skipped++;
            continue;
          }
          text = buf.toString("utf8");
        } catch {
          skipped++;
          continue;
        }

        const rel = toRelative(projectRoot, file);
        const fileLines = text.split(/\r?\n/);
        let fileHit = false;
        for (let i = 0; i < fileLines.length; i++) {
          const line = fileLines[i]!;
          if (!regex.test(line)) continue;
          fileHit = true;
          matches++;
          if (lines.length < maxResults) {
            lines.push(`${rel}:${i + 1}:${line.trimEnd()}`);
          } else {
            truncated = true;
            break;
          }
        }
        if (fileHit) files++;
      }

      const details: GrepToolDetails = { matches, files, truncated, skipped };
      if (matches === 0) {
        return {
          content: [{ type: "text", text: `No matches for /${params.pattern}/` }],
          details,
        };
      }
      const header =
        `${matches} match(es) in ${files} file(s)` +
        (truncated ? ` (showing first ${lines.length}; narrow your query)` : "") +
        (skipped > 0 ? `, ${skipped} file(s) skipped (binary/too large)` : "");
      return {
        content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
        details,
      };
    },
  };
}
