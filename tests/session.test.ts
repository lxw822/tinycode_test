import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager, SessionStorage } from "../src/session/index.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tinycode-sess-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function header(id: string, cwd = dir) {
  return {
    type: "session" as const,
    id,
    cwd,
    createdAt: new Date().toISOString(),
    model: "faux/mock",
  };
}

describe("SessionStorage", () => {
  it("creates, appends and loads a session", () => {
    const storage = new SessionStorage(dir);
    storage.create(header("s1"));
    storage.append("s1", { type: "message", message: { role: "user", content: "hi" } });
    storage.append("s1", { type: "message", message: { role: "assistant", content: "yo" } });

    const loaded = storage.load("s1");
    expect(loaded).toBeDefined();
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.skipped).toBe(0);
    expect(loaded!.header.model).toBe("faux/mock");
  });

  it("is append-only: message records are never rewritten", () => {
    const storage = new SessionStorage(dir);
    storage.create(header("s2"));
    storage.append("s2", { type: "message", message: { role: "user", content: "keep me" } });
    storage.updateHeader("s2", { title: "first prompt" });

    const raw = fs.readFileSync(storage.filePath("s2"), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "session", title: "first prompt" });
    expect(JSON.parse(lines[1]!)).toMatchObject({
      type: "message",
      message: { content: "keep me" },
    });
  });

  it("skips a torn final line (crash mid-append)", () => {
    const storage = new SessionStorage(dir);
    storage.create(header("s3"));
    storage.append("s3", { type: "message", message: { role: "user", content: "ok" } });

    // Simulate a crash: half a JSON line.
    fs.appendFileSync(storage.filePath("s3"), '{"type":"message","message":{"role":"ass');

    const loaded = storage.load("s3");
    expect(loaded).toBeDefined();
    expect(loaded!.messages).toHaveLength(1);
    expect(loaded!.skipped).toBe(1);
  });

  it("tolerates a torn line followed by later appends (recovery continues)", () => {
    const storage = new SessionStorage(dir);
    storage.create(header("s3b"));
    fs.appendFileSync(storage.filePath("s3b"), '{"type":"message","message":{"torn');
    storage.append("s3b", { type: "message", message: { role: "user", content: "after" } });

    const loaded = storage.load("s3b");
    expect(loaded!.messages).toHaveLength(1);
    expect(loaded!.skipped).toBe(1);
    expect((loaded!.messages[0] as { content: string }).content).toBe("after");
  });

  it("returns undefined when the header line itself is broken", () => {
    fs.writeFileSync(path.join(dir, "broken.jsonl"), '{"type":"sess');
    expect(new SessionStorage(dir).load("broken")).toBeUndefined();
  });

  it("rejects unsafe session ids (path traversal)", () => {
    const storage = new SessionStorage(dir);
    expect(() => storage.filePath("../evil")).toThrow(/Invalid session id/);
    expect(() => storage.filePath("a/b")).toThrow(/Invalid session id/);
  });

  it("lists ids newest first (UUIDv7 order)", () => {
    const storage = new SessionStorage(dir);
    storage.create(header("00000000-0000-0000-0000-000000000001"));
    storage.create(header("00000000-0000-0000-0000-000000000002"));
    expect(storage.list()).toEqual([
      "00000000-0000-0000-0000-000000000002",
      "00000000-0000-0000-0000-000000000001",
    ]);
  });

  it("filters sessions by cwd so --continue never crosses projects", () => {
    const storage = new SessionStorage(dir);
    storage.create({ ...header("00000000-0000-0000-0000-00000000000a"), cwd: "C:/project-a" });
    storage.create({ ...header("00000000-0000-0000-0000-00000000000b"), cwd: "C:/project-b" });

    const forA = storage.listForCwd("C:/project-a");
    expect(forA).toEqual(["00000000-0000-0000-0000-00000000000a"]);
  });
});

describe("SessionManager lifecycle", () => {
  it("start creates an active session and records messages", () => {
    const manager = new SessionManager(dir);
    const id = manager.start(process.cwd(), "faux/mock");
    expect(manager.isActive).toBe(true);
    expect(fs.existsSync(path.join(dir, `${id}.jsonl`))).toBe(true);

    manager.record({ role: "user", content: "hello" });
    manager.record({ role: "assistant", content: "hi" });
    expect(manager.messageCount).toBe(2);

    const loaded = manager.load(id);
    expect(loaded!.messages).toHaveLength(2);
  });

  it("writes the title once, from the first user prompt", () => {
    const manager = new SessionManager(dir, {
      titleFrom: (message) => {
        const m = message as { role?: string; content?: unknown };
        if (m.role !== "user") return undefined;
        const text = typeof m.content === "string" ? m.content : "";
        return text.slice(0, 20);
      },
    });
    const id = manager.start(process.cwd(), "faux/mock");
    manager.record({ role: "assistant", content: "nope" }); // no title yet
    manager.record({ role: "user", content: "fix the failing tests now" });
    manager.record({ role: "user", content: "another later prompt" });

    const raw = fs.readFileSync(path.join(dir, `${id}.jsonl`), "utf8");
    const headerLine = JSON.parse(raw.split("\n")[0]!);
    expect(headerLine.title).toBe("fix the failing test"); // first 20 chars
    // Only ONE rewrite: still exactly 1 header + 3 messages.
    expect(raw.trim().split("\n")).toHaveLength(4);
  });

  it("attach resumes appends into the same file without reloading history", () => {
    const first = new SessionManager(dir);
    const id = first.start(process.cwd(), "faux/mock");
    first.record({ role: "user", content: "part one" });

    // Relaunch: attach, then continue appending.
    const second = new SessionManager(dir);
    const loaded = second.attach(id, process.cwd(), "faux/mock");
    expect(loaded).toBeDefined();
    expect(loaded!.messages).toHaveLength(1);
    expect(second.messageCount).toBe(1);
    second.record({ role: "assistant", content: "part two" });

    const after = second.load(id);
    expect(after!.messages).toHaveLength(2);
  });

  it("attach to a missing session returns undefined and stays inactive", () => {
    const manager = new SessionManager(dir);
    expect(manager.attach("nope", process.cwd(), "m")).toBeUndefined();
    expect(manager.isActive).toBe(false);
    // record() on an inactive manager is a no-op, not a crash.
    expect(() => manager.record({ role: "user", content: "x" })).not.toThrow();
  });

  it("newestFor matches the current directory only", () => {
    const a = new SessionManager(dir);
    const idA = a.start("C:/proj-a", "m");
    const b = new SessionManager(dir);
    b.start("C:/proj-b", "m");

    expect(new SessionManager(dir).newestFor("C:/proj-a")).toBe(idA);
    expect(new SessionManager(dir).newestFor("C:/proj-c")).toBeUndefined();
  });

  it("a corrupted line in one session never affects another", () => {
    const manager = new SessionManager(dir);
    const good = manager.start(process.cwd(), "m");
    manager.record({ role: "user", content: "solid" });
    fs.appendFileSync(path.join(dir, `${good}.jsonl`), "GARBAGE NOT JSON\n");

    const other = new SessionManager(dir);
    other.start(process.cwd(), "m");
    other.record({ role: "user", content: "different file" });

    expect(manager.load(good)!.messages).toHaveLength(1);
    expect(manager.load(good)!.skipped).toBe(1);
    expect(other.load(other.id)!.messages).toHaveLength(1);
  });
});

describe("TINYCODE_HOME redirect", () => {
  it("honors the env override", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tinycode-home-"));
    const previous = process.env["TINYCODE_HOME"];
    process.env["TINYCODE_HOME"] = home;
    try {
      const { dataHome, sessionsDir } = await import("../src/session/index.js");
      expect(dataHome()).toBe(home);
      expect(sessionsDir()).toBe(path.join(home, "sessions"));
    } finally {
      if (previous === undefined) delete process.env["TINYCODE_HOME"];
      else process.env["TINYCODE_HOME"] = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
