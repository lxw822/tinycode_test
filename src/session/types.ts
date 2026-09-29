/** Session record types — the JSONL wire format. */

export interface SessionHeader {
  type: "session";
  /** UUIDv7 — sorts by creation time. */
  id: string;
  cwd: string;
  createdAt: string;
  model: string;
  title?: string;
}

export interface SessionMessageRecord {
  type: "message";
  message: unknown;
}

export type SessionRecord = SessionHeader | SessionMessageRecord;

export interface LoadedSession {
  header: SessionHeader;
  messages: unknown[];
  /** Records skipped because their line failed to parse (torn writes). */
  skipped: number;
}
