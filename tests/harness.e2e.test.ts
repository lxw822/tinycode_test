import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { bootstrapHarness, type Harness } from "../src/bootstrap.js";
import { ModelRegistry } from "../src/model/registry.js";
import type { PermissionRequest } from "../src/permissions/manager.js";

/**
 * The flagship test — the whole story as one executable scenario.
 *
 * A deterministic mock model drives the REAL agent loop through
 *   bash(fail) → read → edit → bash(pass) → final
 * against a copy of fixtures/broken-project. We then assert:
 *   1. the fixture's own tests pass after the run,
 *   2. the permission dialog saw every ask-level operation,
 *   3. the session JSONL records the complete conversation,
 *   4. the final assistant message says the job is done.
 *
 * Fully offline: no API key, no network, ever.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureSource = path.join(here, "..", "fixtures", "broken-project");

let projectRoot: string;
let home: string;
let previousHome: string | undefined;
let harness: Harness | undefined;

beforeEach(() => {
  // Copy the fixture so each run starts from the broken state.
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tinycode-e2e-"));
  for (const entry of fs.readdirSync(fixtureSource)) {
    fs.copyFileSync(path.join(fixtureSource, entry), path.join(projectRoot, entry));
  }
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tinycode-e2e-home-"));
  previousHome = process.env["TINYCODE_HOME"];
  process.env["TINYCODE_HOME"] = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env["TINYCODE_HOME"];
  else process.env["TINYCODE_HOME"] = previousHome;
  await harness?.shutdown();
  harness = undefined;
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function runFixtureTests(): number {
  const result = spawnSync(process.execPath, ["--test"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  return result.status ?? 1;
}

describe("flagship E2E: scripted mock fixes the broken project", () => {
  it("drives bash → read → edit → bash → final through the real loop", async () => {
    // The fixture starts broken.
    expect(runFixtureTests()).not.toBe(0);

    const registry = new ModelRegistry();
    const faux = registry.enableMock();

    const dialogRequests: PermissionRequest[] = [];
    const prompt = async (request: PermissionRequest) => {
      dialogRequests.push(request);
      // Approve everything the dialog sees — safety is covered elsewhere.
      return "allow-always" as const;
    };

    harness = await bootstrapHarness({
      projectRoot,
      config: {},
      models: registry,
      permissionMode: "ask",
      permissionPrompt: prompt,
      session: { mode: "new" },
    });

    // Scripted turns: the mock does not read context — it plays a script.
    faux.setResponses([
      // 1. run the tests → they fail
      fauxAssistantMessage([fauxToolCall("bash", { command: "node --test" })], {
        stopReason: "toolUse",
      }),
      // 2. inspect the source
      fauxAssistantMessage([fauxToolCall("read", { path: "math.js" })], {
        stopReason: "toolUse",
      }),
      // 3. apply the fix
      fauxAssistantMessage(
        [
          fauxToolCall("edit", {
            path: "math.js",
            oldText: "  return a - b;",
            newText: "  return a + b;",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      // 4. re-run the tests → they pass
      fauxAssistantMessage([fauxToolCall("bash", { command: "node --test" })], {
        stopReason: "toolUse",
      }),
      // 5. final report
      fauxAssistantMessage([fauxText("Fixed add() and verified: node --test passes.")]),
    ]);

    await harness.runtime.prompt("the tests fail, fix it");
    await harness.runtime.waitForIdle();

    // --- 1. observable outcome: fixture tests now pass ----------------------
    expect(runFixtureTests()).toBe(0);
    const fixed = fs.readFileSync(path.join(projectRoot, "math.js"), "utf8");
    expect(fixed).toContain("return a + b;");
    expect(fixed).not.toContain("return a - b;");

    // --- 2. permission dialog saw ask-level ops (edit), reads flowed free ---
    const askedTools = dialogRequests.map((r) => r.toolName);
    expect(askedTools).toContain("edit");
    expect(askedTools).not.toContain("read"); // reads inside project never ask

    // --- 3. session JSONL is complete --------------------------------------
    const sessionFile = path.join(home, "sessions", `${harness.session!.id}.jsonl`);
    expect(fs.existsSync(sessionFile)).toBe(true);
    const raw = fs.readFileSync(sessionFile, "utf8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: "session", cwd: projectRoot });
    expect(lines[0]!.title).toBe("the tests fail, fix it");

    const messages = lines
      .filter((l: { type: string }) => l.type === "message")
      .map((l: { message: { role: string } }) => l.message.role);
    // user + 5 assistant turns + 4 toolResults
    expect(messages[0]).toBe("user");
    expect(messages.filter((r: string) => r === "assistant")).toHaveLength(5);
    expect(messages.filter((r: string) => r === "toolResult")).toHaveLength(4);
    // Appends are intact: no torn lines.
    expect(raw.endsWith("\n")).toBe(true);

    // --- 4. final assistant message is the report ---------------------------
    const last = harness.runtime.messages[harness.runtime.messages.length - 1]!;
    expect(last.role).toBe("assistant");
    const text = (last as { content: Array<{ type: string; text?: string }> }).content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(text).toContain("Fixed add()");
  }, 60_000);

  it("a denied edit blocks the loop but keeps the run alive", async () => {
    const registry = new ModelRegistry();
    const faux = registry.enableMock();

    // Headless: no dialog → edit is denied, model gets an error result.
    harness = await bootstrapHarness({
      projectRoot,
      config: {},
      models: registry,
      permissionMode: "ask",
      session: { mode: "new" },
    });

    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("edit", {
            path: "math.js",
            oldText: "  return a - b;",
            newText: "  return a + b;",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("could not edit: permission denied")]),
    ]);

    await harness.runtime.prompt("fix it");
    await harness.runtime.waitForIdle();

    // Fixture untouched.
    expect(fs.readFileSync(path.join(projectRoot, "math.js"), "utf8")).toContain("a - b");
    // Model saw a readable denial, not a crash.
    const results = harness.runtime.messages.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(1);
    expect((results[0] as { isError: boolean }).isError).toBe(true);
    const text = (results[0] as { content: Array<{ text?: string }> }).content[0]!.text!;
    expect(text).toContain("Permission denied");
    expect(text).toMatch(/no dialog is available/);
  }, 30_000);

  it("auto mode approves the edit without a dialog", async () => {
    const registry = new ModelRegistry();
    const faux = registry.enableMock();

    harness = await bootstrapHarness({
      projectRoot,
      config: {},
      models: registry,
      permissionMode: "auto",
      session: { mode: "new" },
    });

    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("edit", {
            path: "math.js",
            oldText: "  return a - b;",
            newText: "  return a + b;",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("done")]),
    ]);

    await harness.runtime.prompt("fix it silently");
    await harness.runtime.waitForIdle();

    expect(fs.readFileSync(path.join(projectRoot, "math.js"), "utf8")).toContain("a + b;");
  }, 30_000);

  it("resuming an attached session restores the transcript", async () => {
    const registry = new ModelRegistry();
    const faux = registry.enableMock();
    faux.setResponses([fauxAssistantMessage("first answer")]);

    harness = await bootstrapHarness({
      projectRoot,
      config: {},
      models: registry,
      session: { mode: "new" },
    });
    await harness.runtime.prompt("question one");
    await harness.runtime.waitForIdle();
    const sessionId = harness.session!.id;
    const firstCount = harness.runtime.messages.length;
    expect(firstCount).toBeGreaterThanOrEqual(2);
    await harness.shutdown();

    // Relaunch: attach to the same session.
    const registry2 = new ModelRegistry();
    const faux2 = registry2.enableMock();
    faux2.setResponses([fauxAssistantMessage("second answer")]);
    harness = await bootstrapHarness({
      projectRoot,
      config: {},
      models: registry2,
      session: { mode: "attach", id: sessionId },
    });

    expect(harness.runtime.messages).toHaveLength(firstCount);
    await harness.runtime.prompt("question two");
    await harness.runtime.waitForIdle();

    // Same file received the new turns; nothing was lost or duplicated.
    const loaded = harness.session!.load(sessionId)!;
    expect(loaded.messages).toHaveLength(harness.runtime.messages.length);
    expect(loaded.skipped).toBe(0);
    const roles = loaded.messages.map((m) => (m as { role: string }).role);
    expect(roles.filter((r) => r === "user")).toHaveLength(2);
  }, 30_000);
});
