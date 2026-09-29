/**
 * Shell command risk classifier.
 *
 * Commands are split quote-aware on `&&` / `;` / `|` / newlines and each
 * segment is classified; the overall command takes the highest risk found.
 *
 *   blocked      catastrophic, refused unconditionally (rm -rf /, mkfs, …)
 *   destructive  data loss / system change (rm, git reset --hard, sudo, …)
 *   write        changes state (npm install, redirections, unknown verbs)
 *   safe         read-only (git status, npm test, cat, …)
 *
 * Design rule: unknown verbs are `write`, never `safe` — the classifier must
 * fail toward approval, not toward freedom.
 */

export type ShellRisk = "blocked" | "destructive" | "write" | "safe";

export interface ShellSegment {
  text: string;
  /** True when the segment is the right-hand side of a pipe. */
  viaPipe: boolean;
}

export interface ShellClassification {
  risk: ShellRisk;
  reason: string;
  segments: Array<ShellSegment & { risk: ShellRisk; reason: string }>;
  /** Pattern for "always allow" memory (undefined for safe commands). */
  pattern?: string;
}

const RISK_ORDER: Record<ShellRisk, number> = { safe: 0, write: 1, destructive: 2, blocked: 3 };

/** Read-only commands; no state change beyond reading. */
const SAFE_VERBS = new Set([
  "ls",
  "dir",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "fd",
  "find",
  "echo",
  "printf",
  "pwd",
  "which",
  "whereis",
  "where",
  "file",
  "stat",
  "du",
  "df",
  "env",
  "printenv",
  "uname",
  "date",
  "whoami",
  "id",
  "true",
  "false",
  "test",
  "history",
  "diff",
  "sort",
  "uniq",
  "cut",
  "tr",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "md5sum",
  "sha256sum",
  "tree",
  "alias",
  "sleep",
  "curl",
  "wget",
  "code",
  "less",
  "more",
]);

/** Commands that always require approval regardless of arguments. */
const WRITE_VERBS = new Set([
  "mkdir",
  "touch",
  "cp",
  "mv",
  "ln",
  "chmod",
  "chown",
  "chgrp",
  "pip",
  "pip3",
  "yarn",
  "pnpm",
  "bun",
  "apt",
  "apt-get",
  "brew",
  "winget",
  "docker",
  "kubectl",
  "helm",
  "terraform",
  "psql",
  "mysql",
  "redis-cli",
  "mkdirp",
  "rimraf",
  "cpx",
  "shx",
  "patch",
  "git",
]);

/** Commands whose presence makes the segment destructive. */
const DESTRUCTIVE_VERBS = new Set([
  "rm",
  "rmdir",
  "rd",
  "del",
  "mkfs",
  "dd",
  "shred",
  "wipefs",
  "diskpart",
  "sudo",
  "su",
  "doas",
  "shutdown",
  "reboot",
  "poweroff",
  "halt",
  "taskkill",
  "format",
  "reg",
  "bcdedit",
  "iex",
  "Invoke-Expression",
]);

/** Interpreters: only version flags count as read-only. */
const INTERPRETERS = new Set([
  "node",
  "python",
  "python3",
  "go",
  "rustc",
  "java",
  "ruby",
  "perl",
  "deno",
  "bunx",
]);

const VERSION_FLAGS = new Set(["--version", "-v", "-V", "--help", "-h", "version", "-help"]);

/** git subcommands that only read state. */
const SAFE_GIT = new Set([
  "status",
  "log",
  "diff",
  "show",
  "remote",
  "rev-parse",
  "ls-files",
  "blame",
  "describe",
  "reflog",
  "shortlog",
  "grep",
  "help",
  "whatchanged",
]);
/** git subcommands that destroy local state. */
const DESTRUCTIVE_GIT = new Set(["push", "clean", "filter-branch", "gc", "prune"]);

/** npm subcommands that run read-only operations. */
const SAFE_NPM = new Set([
  "test",
  "t",
  "ls",
  "list",
  "view",
  "info",
  "outdated",
  "help",
  "docs",
  "root",
  "prefix",
  "ping",
  "pkg",
  "query",
  "search",
  "--version",
  "-v",
  "-V",
]);

/** Shells that make a piped segment "pipe into shell" — destructive. */
const PIPE_SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "ksh",
  "fish",
  "pwsh",
  "powershell",
  "cmd",
  "cmd.exe",
  "python",
  "python3",
  "node",
]);

/** Catastrophic patterns: never approvable, not even in auto mode. */
const BLOCKED_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  {
    re: /\brm\s+(?:-[a-zA-Z]+\s+)*(?:--[a-z-]+\s+)*["']?(?:\/|~|\$HOME)["']?(?:\s|$|\*)/i,
    reason: "rm targeting root or home directory",
  },
  { re: /\brm\s+.*--no-preserve-root/i, reason: "rm with --no-preserve-root" },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: "filesystem format (mkfs)" },
  { re: /\bdd\b[^;&|]*\bof=\/dev\//i, reason: "raw disk write (dd to device)" },
  { re: />?\s*\/dev\/sd[a-z]\d*/i, reason: "write to raw disk device" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  { re: /\b(shutdown|reboot|poweroff|halt)\b/i, reason: "system power command" },
  { re: /\bformat\s+[a-zA-Z]:/i, reason: "disk format" },
  {
    re: /\bRemove-Item\b[^;&|]*\s-[Rr]ecursive[^;&|]*\s+[a-zA-Z]:\\?\s*$/i,
    reason: "recursive delete of drive root",
  },
  {
    re: /\bchmod\s+-[a-zA-Z]*R[a-zA-Z]*\s+777\s+\/(\s|$)/i,
    reason: "recursive chmod of filesystem root",
  },
];

/** Split on shell operators, keeping quote contents intact. */
export function splitShellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let current = "";
  let quote: string | null = null;
  let pendingPipe = false;

  const push = () => {
    const text = current.trim();
    if (text.length > 0) segments.push({ text, viaPipe: pendingPipe });
    current = "";
    pendingPipe = false;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      push();
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      push();
      i++;
      continue;
    }
    if (ch === "|" && command[i + 1] === "|") {
      push();
      i++;
      continue;
    }
    if (ch === "|") {
      push();
      pendingPipe = true;
      continue;
    }
    current += ch;
  }
  push();
  return segments;
}

/** First executable word, skipping `VAR=value` prefixes. */
function firstVerb(segment: string): string {
  for (const token of segment.split(/\s+/)) {
    if (token.length === 0) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // env assignment
    // strip wrappers like `env FOO=1`, `command`, `time`, `xargs`
    if (token === "env" || token === "command" || token === "time" || token === "exec") continue;
    return token.replace(/^.*[\\/]/, ""); // drop path prefix: /bin/rm → rm
  }
  return "";
}

/** Sub-command for verbs like `git status` / `npm install`. */
function subVerb(segment: string, verb: string): string | undefined {
  const idx = segment.indexOf(verb);
  if (idx === -1) return undefined;
  const rest = segment.slice(idx + verb.length).trim();
  for (const token of rest.split(/\s+/)) {
    if (token.length === 0) continue;
    if (token.startsWith("-")) return undefined; // flags first ⇒ no subcommand
    return token;
  }
  return undefined;
}

function hasRedirection(segment: string): boolean {
  // `>` outside quotes; `2>` and `&>` also write.
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">" || ch === "<") return true;
  }
  return false;
}

function classifySegment(segment: ShellSegment): {
  risk: ShellRisk;
  reason: string;
  pattern?: string;
} {
  const text = segment.text;

  // Catastrophic patterns short-circuit everything.
  for (const { re, reason } of BLOCKED_PATTERNS) {
    if (re.test(text)) return { risk: "blocked", reason };
  }

  const verb = firstVerb(text);

  // Pipe into a shell/interpreter executes whatever came before it.
  if (segment.viaPipe && PIPE_SHELLS.has(verb)) {
    return { risk: "destructive", reason: "pipe into shell/interpreter", pattern: text };
  }

  if (verb.length === 0) return { risk: "safe", reason: "empty segment" };

  if (BLOCKED_PATTERNS.some(({ re }) => re.test(verb))) {
    return { risk: "blocked", reason: "blocked command" };
  }

  if (DESTRUCTIVE_VERBS.has(verb)) {
    // `rm` without flags still destroys data; `sudo` runs anything.
    return { risk: "destructive", reason: `${verb} can destroy data`, pattern: text };
  }

  if (verb === "git") {
    const sub = subVerb(text, verb);
    if (sub === undefined)
      return { risk: "write", reason: "git without subcommand", pattern: "git" };
    if (DESTRUCTIVE_GIT.has(sub)) {
      const force = /\s(--force|-f|--hard|-fdx|-ffdx)\b/.test(text);
      if (sub === "push" && !force) {
        return { risk: "write", reason: "git push", pattern: "git push" };
      }
      return { risk: "destructive", reason: `git ${sub} can lose state`, pattern: text };
    }
    if (sub === "reset" && /\s--hard\b/.test(text)) {
      return { risk: "destructive", reason: "git reset --hard discards changes", pattern: text };
    }
    if (sub === "branch" && /\s-D\b/.test(text)) {
      return { risk: "destructive", reason: "git branch -D force-deletes", pattern: text };
    }
    if (SAFE_GIT.has(sub)) return { risk: "safe", reason: `git ${sub} (read-only)` };
    return { risk: "write", reason: `git ${sub}`, pattern: `git ${sub}` };
  }

  if (verb === "npm" || verb === "pnpm" || verb === "yarn") {
    const sub = subVerb(text, verb);
    const safeSet =
      verb === "npm" ? SAFE_NPM : new Set(["test", "t", "ls", "list", "info", "why", "licenses"]);
    if (sub !== undefined && safeSet.has(sub)) {
      return { risk: "safe", reason: `${verb} ${sub} (read-only)` };
    }
    if (sub === "run") {
      // Project-defined script: same trust domain as `npm test`.
      const script = subVerbAfter(text, verb, "run");
      if (script === "test") return { risk: "safe", reason: "npm run test" };
      return {
        risk: "write",
        reason: `${verb} run ${script ?? ""}`.trim(),
        pattern: `${verb} run`,
      };
    }
    return {
      risk: "write",
      reason: `${verb} ${sub ?? "default"} installs/changes state`,
      pattern: `${verb} ${sub ?? "install"}`,
    };
  }

  if (INTERPRETERS.has(verb)) {
    const tokens = text.split(/\s+/).slice(1);
    if (tokens.length > 0 && tokens.every((t) => VERSION_FLAGS.has(t) || !t.startsWith("-"))) {
      // `node script.js` runs arbitrary code ⇒ write; `node --version` is safe.
      if (tokens.every((t) => VERSION_FLAGS.has(t))) {
        return { risk: "safe", reason: `${verb} version check` };
      }
    }
    return { risk: "write", reason: `${verb} executes a script`, pattern: verb };
  }

  if (SAFE_VERBS.has(verb)) {
    if (hasRedirection(text)) {
      return { risk: "write", reason: `${verb} with redirection writes a file`, pattern: verb };
    }
    return { risk: "safe", reason: `${verb} (read-only)` };
  }

  if (WRITE_VERBS.has(verb)) {
    return {
      risk: "write",
      reason: `${verb} changes state`,
      pattern: subVerb(text, verb) ? `${verb} ${subVerb(text, verb)}` : verb,
    };
  }

  return {
    risk: "write",
    reason: `unknown command "${verb}" treated as state-changing`,
    pattern: verb,
  };
}

function subVerbAfter(text: string, verb: string, marker: string): string | undefined {
  const idx = text.indexOf(`${verb} ${marker}`);
  if (idx === -1) return undefined;
  const rest = text.slice(idx + verb.length + marker.length).trim();
  for (const token of rest.split(/\s+/)) {
    if (token.length === 0) continue;
    if (token.startsWith("-")) return undefined;
    return token;
  }
  return undefined;
}

/** Classify a full shell command (may contain multiple segments). */
export function classifyShellCommand(command: string): ShellClassification {
  // Hard-deny patterns run against the RAW command first: operators like the
  // fork bomb `:(){:|:&};:` would otherwise be shredded by segmentation
  // before any pattern sees them.
  for (const { re, reason } of BLOCKED_PATTERNS) {
    if (re.test(command)) {
      return {
        risk: "blocked",
        reason,
        segments: splitShellSegments(command).map((seg) => ({
          ...seg,
          risk: "blocked" as const,
          reason,
        })),
      };
    }
  }

  const segments = splitShellSegments(command);
  if (segments.length === 0) {
    return { risk: "safe", reason: "empty command", segments: [] };
  }

  const classified = segments.map((seg) => ({ ...seg, ...classifySegment(seg) }));

  let worst: (typeof classified)[number] = classified[0]!;
  for (const seg of classified) {
    if (RISK_ORDER[seg.risk] > RISK_ORDER[worst.risk]) worst = seg;
  }

  // Pattern for memory: widest useful unit for write, exact segment for destructive.
  let pattern: string | undefined;
  if (worst.risk === "write") pattern = worst.pattern;
  else if (worst.risk === "destructive") pattern = worst.pattern;

  return {
    risk: worst.risk,
    reason: worst.reason,
    segments: classified,
    ...(pattern !== undefined ? { pattern } : {}),
  };
}
