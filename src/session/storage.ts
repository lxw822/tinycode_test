import fs from "node:fs";
import path from "node:path";
import type { LoadedSession, SessionHeader, SessionRecord } from "./types.js";

/**
 * Append-only JSONL session storage.
 *
 * Durability rules:
 * - writes are synchronous appends; files are never truncated after creation
 *   (the first prompt rewrites ONLY the not-yet-valuable header line to add a
 *   title — message records are immutable)
 * - a torn final line (crash mid-append) is skipped on load instead of
 *   failing the whole session
 * - `load` is strictly read-only
 *
 * One file per session keeps concurrent sessions isolated; tests redirect the
 * root via TINYCODE_HOME.
 */
export class SessionStorage {
  constructor(readonly rootDir: string) {}

  filePath(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid session id: ${id}`);
    return path.join(this.rootDir, `${id}.jsonl`);
  }

  exists(id: string): boolean {
    return fs.existsSync(this.filePath(id));
  }

  /** Create the file with a header record. */
  create(header: SessionHeader): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
    const file = this.filePath(header.id);
    if (fs.existsSync(file)) throw new Error(`Session file already exists: ${header.id}`);
    fs.writeFileSync(file, `${JSON.stringify(header)}\n`, "utf8");
  }

  /** Append one record (synchronous — a crash can tear only the last line). */
  append(id: string, record: SessionRecord): void {
    const file = this.filePath(id);
    // Self-heal after a torn write: a partial line has no trailing newline,
    // and appending directly onto it would glue two records into one
    // unparseable line (losing BOTH). Start a fresh line instead.
    let prefix = "";
    try {
      if (fs.existsSync(file)) {
        const stat = fs.statSync(file);
        if (stat.size > 0) {
          const fd = fs.openSync(file, "r");
          try {
            const buf = Buffer.alloc(1);
            fs.readSync(fd, buf, 0, 1, stat.size - 1);
            if (buf[0] !== 0x0a) prefix = "\n";
          } finally {
            fs.closeSync(fd);
          }
        }
      }
    } catch {
      // If we cannot inspect the tail, plain append is the best fallback.
      prefix = "";
    }
    fs.appendFileSync(file, `${prefix}${JSON.stringify(record)}\n`, "utf8");
  }

  /**
   * Rewrite ONLY the header line (adds the title recorded at first prompt).
   * Message lines are never touched.
   */
  updateHeader(id: string, patch: Partial<SessionHeader>): SessionHeader | undefined {
    const file = this.filePath(id);
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    const firstBreak = content.indexOf("\n");
    const headLine = firstBreak === -1 ? content : content.slice(0, firstBreak);
    let header: SessionHeader;
    try {
      header = JSON.parse(headLine) as SessionHeader;
    } catch {
      return undefined;
    }
    if (header.type !== "session") return undefined;
    const merged: SessionHeader = { ...header, ...patch, type: "session" };
    const rest = firstBreak === -1 ? "\n" : content.slice(firstBreak);
    fs.writeFileSync(file, `${JSON.stringify(merged)}${rest}`, "utf8");
    return merged;
  }

  /**
   * Read a session. Torn/unparseable lines are skipped and counted; a file
   * whose FIRST line is broken cannot yield a header and returns undefined.
   */
  load(id: string): LoadedSession | undefined {
    const file = this.filePath(id);
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }

    const lines = content.split("\n");
    let header: SessionHeader | undefined;
    const messages: unknown[] = [];
    let skipped = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let record: SessionRecord;
      try {
        record = JSON.parse(trimmed) as SessionRecord;
      } catch {
        // Torn line (crash mid-append) — skip it, keep the rest.
        skipped++;
        continue;
      }
      if (record.type === "session" && header === undefined) {
        header = record;
      } else if (record.type === "message") {
        messages.push(record.message);
      } else {
        skipped++;
      }
    }

    if (!header) return undefined;
    return { header, messages, skipped };
  }

  /** Session ids (without extension), newest first (UUIDv7 sorts by time). */
  list(): string[] {
    if (!fs.existsSync(this.rootDir)) return [];
    const ids = fs
      .readdirSync(this.rootDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, -".jsonl".length))
      .sort((a, b) => b.localeCompare(a));
    return ids;
  }

  /** Newest session created from `cwd` (project isolation). */
  listForCwd(cwd: string): string[] {
    const normalized = path.resolve(cwd);
    return this.list().filter((id) => {
      const loaded = this.load(id);
      return loaded !== undefined && path.resolve(loaded.header.cwd) === normalized;
    });
  }

  remove(id: string): void {
    try {
      fs.rmSync(this.filePath(id));
    } catch {
      // already gone
    }
  }
}
