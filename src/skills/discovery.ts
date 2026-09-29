import fs from "node:fs";
import path from "node:path";
import { dataHome } from "../session/manager.js";

/**
 * Skill discovery — ARCHITECTURE §8.
 *
 * A skill is `<skills-dir>/<name>/SKILL.md` with a frontmatter header:
 *
 *   ---
 *   name: code-review
 *   description: Review code changes for correctness and maintainability.
 *   ---
 *   # instructions…
 *
 * Two locations, layered: project `.tinycode/skills` wins over the
 * user-level mirror in the data home (`TINYCODE_HOME` or `~/.tinycode`).
 *
 * Progressive disclosure: discovery parses ONLY the frontmatter, so the
 * system prompt can carry a one-line `name: description` index and the body
 * is fetched through the load_skill tool when (and only when) the model
 * decides it needs it.
 */

export interface Skill {
  /** Skill identity — frontmatter `name`, else the directory name. */
  name: string;
  /** Single-line summary for the system prompt index. */
  description: string;
  /** Absolute path to SKILL.md (re-read on load so edits mid-session stick). */
  file: string;
  scope: "project" | "user";
}

export function projectSkillsDir(projectRoot: string): string {
  return path.join(projectRoot, ".tinycode", "skills");
}

export function userSkillsDir(): string {
  return path.join(dataHome(), "skills");
}

/**
 * Parse one SKILL.md. Returns undefined when the file is unreadable or is a
 * directory — discovery never throws: a malformed skill must not break boot.
 */
export function parseSkillFile(file: string, scope: Skill["scope"]): Skill | undefined {
  let raw: string;
  try {
    if (fs.statSync(file).isDirectory()) return undefined;
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }

  const dirName = path.basename(path.dirname(file));
  const { frontmatter, body } = splitFrontmatter(raw);

  const name = (frontmatter["name"] ?? "").trim() || dirName;
  const description =
    // Frontmatter values are treated as single-line; a folded multi-line
    // description collapses to its first line rather than blowing up the
    // one-line-per-skill index.
    (frontmatter["description"] ?? "").split(/\r?\n/)[0]?.trim() ||
    firstHeading(body) ||
    "(no description)";

  return { name, description, file, scope };
}

/** Extract `key: value` pairs from a leading `---` block plus the body. */
function splitFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const frontmatter: Record<string, string> = {};
  const normalized = raw.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);

  if (lines[0]?.trim() !== "---") return { frontmatter, body: normalized };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "---") {
      return { frontmatter, body: lines.slice(i + 1).join("\n") };
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key.length === 0) continue;
    frontmatter[key] = line.slice(colon + 1);
  }
  // Unterminated frontmatter: treat everything as body, keep parsed keys.
  return { frontmatter, body: normalized };
}

function firstHeading(body: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(body);
  return match?.[1]?.trim();
}

/** List SKILL.md files directly under `dir` (one directory level). */
function listSkillFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // no skills directory: perfectly normal
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name, "SKILL.md"))
    .sort();
}

/**
 * Discover all skills for a project, user-level first so a same-named project
 * skill overwrites it. Result is sorted by name for a stable prompt.
 */
export function discoverSkills(projectRoot: string): Skill[] {
  const byName = new Map<string, Skill>();
  for (const file of listSkillFiles(userSkillsDir())) {
    const skill = parseSkillFile(file, "user");
    if (skill && !byName.has(skill.name)) byName.set(skill.name, skill);
  }
  for (const file of listSkillFiles(projectSkillsDir(projectRoot))) {
    const skill = parseSkillFile(file, "project");
    // Project-level shadows user-level (and an earlier duplicate name).
    if (skill) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One `name: description` line per skill — the entire prompt footprint. */
export function skillIndex(skills: Skill[]): string | undefined {
  if (skills.length === 0) return undefined;
  return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}
