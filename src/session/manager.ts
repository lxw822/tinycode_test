import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SessionStorage } from "./storage.js";
import type { LoadedSession, SessionHeader } from "./types.js";

/**
 * SessionManager = storage + lifecycle policy.
 *
 * Lifecycle (per launch):
 *   start  — brand-new session, header written immediately
 *   attach — read-only load of an existing session; the live transcript is
 *            restored by the caller, then appends continue into the SAME file
 *
 * `record()` is the only writer called at runtime (via the agent's subscribe
 * hook); it appends one `{"type":"message"}` line per finalized message.
 */
export interface SessionManagerOptions {
  /** Write title into the header after the first user prompt. */
  titleFrom?: (message: unknown) => string | undefined;
}

/** Data home: TINYCODE_HOME env (tests) → ~/.tinycode */
export function dataHome(): string {
  const override = process.env["TINYCODE_HOME"];
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".tinycode");
}

export function sessionsDir(): string {
  return path.join(dataHome(), "sessions");
}

export class SessionManager {
  readonly storage: SessionStorage;
  private header: SessionHeader | undefined;
  private titled = false;
  private recorded = 0;

  constructor(
    rootDir: string = sessionsDir(),
    private readonly options: SessionManagerOptions = {},
  ) {
    this.storage = new SessionStorage(rootDir);
  }

  get id(): string {
    if (!this.header) throw new Error("No active session");
    return this.header.id;
  }

  get isActive(): boolean {
    return this.header !== undefined;
  }

  get messageCount(): number {
    return this.recorded;
  }

  /** Begin a new session. */
  start(cwd: string, model: string): string {
    const id = randomUUID();
    const header: SessionHeader = {
      type: "session",
      id,
      cwd: path.resolve(cwd),
      createdAt: new Date().toISOString(),
      model,
    };
    this.storage.create(header);
    this.header = header;
    this.titled = false;
    this.recorded = 0;
    return id;
  }

  /**
   * Attach to an existing session.
   * Does NOT load messages — call `load()`; appending resumes immediately so
   * a crash during resume can never destroy history.
   */
  attach(id: string, cwd: string, model: string): LoadedSession | undefined {
    const loaded = this.storage.load(id);
    if (!loaded) return undefined;
    this.header = loaded.header;
    this.titled = loaded.header.title !== undefined;
    this.recorded = loaded.messages.length;
    // Refresh cwd/model to the current launch (the file header stays
    // untouched unless a title appears — append-only discipline).
    this.header = { ...loaded.header, cwd: path.resolve(cwd), model };
    return loaded;
  }

  /** Append one finalized message. Never throws into the agent loop. */
  record(message: unknown): void {
    if (!this.header) return;
    try {
      this.storage.append(this.header.id, { type: "message", message });
      this.recorded++;

      if (!this.titled && this.options.titleFrom) {
        const title = this.options.titleFrom(message);
        if (title) {
          this.storage.updateHeader(this.header.id, { title });
          this.header = { ...this.header, title };
          this.titled = true;
        }
      }
    } catch {
      // Persistence must not break the agent loop; the transcript in memory
      // remains the source of truth for this run.
    }
  }

  /** Read-only load of another (or the same) session. */
  load(id: string): LoadedSession | undefined {
    return this.storage.load(id);
  }

  /** Newest session of `cwd`, or undefined when none matches. */
  newestFor(cwd: string): string | undefined {
    return this.storage.listForCwd(cwd)[0];
  }

  list(): string[] {
    return this.storage.list();
  }
}
