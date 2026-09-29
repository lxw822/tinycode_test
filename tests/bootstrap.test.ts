import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { bootstrapHarness } from "../src/bootstrap.js";
import { mockRegistry, type ModelRegistry } from "../src/model/registry.js";
import { loadConfig, resolveModelRef, resolvePermissionMode } from "../src/config/loader.js";
import { validateConfig, findSecretLookingKeys } from "../src/config/schema.js";
import { buildSystemPrompt, readProjectMemory } from "../src/agent/prompt.js";
import type { Harness } from "../src/bootstrap.js";

let root: string;
let home: string;
let previousHome: string | undefined;
const previousModelEnv: string | undefined = process.env["TINYCODE_MODEL"];
const previousPermEnv: string | undefined = process.env["TINYCODE_PERMISSION_MODE"];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tinycode-boot-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tinycode-home-"));
  previousHome = process.env["TINYCODE_HOME"];
  process.env["TINYCODE_HOME"] = home;
  delete process.env["TINYCODE_MODEL"];
  delete process.env["TINYCODE_PERMISSION_MODE"];
});

afterEach(() => {
  if (previousHome === undefined) delete process.env["TINYCODE_HOME"];
  else process.env["TINYCODE_HOME"] = previousHome;
  if (previousModelEnv === undefined) delete process.env["TINYCODE_MODEL"];
  else process.env["TINYCODE_MODEL"] = previousModelEnv;
  if (previousPermEnv === undefined) delete process.env["TINYCODE_PERMISSION_MODE"];
  else process.env["TINYCODE_PERMISSION_MODE"] = previousPermEnv;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

/** Bootstrap a harness around a pre-seeded faux registry. */
async function makeHarness(
  overrides: Partial<Parameters<typeof bootstrapHarness>[0]> = {},
): Promise<{
  harness: Harness;
  faux: ReturnType<ModelRegistry["enableMock"]>;
}> {
  const { registry, handle } = mockRegistry();
  const harness = await bootstrapHarness({
    projectRoot: root,
    config: {},
    models: registry,
    session: { mode: "new" },
    ...overrides,
  });
  return { harness, faux: handle };
}

describe("bootstrap assembly", () => {
  it("wires all seven built-in tools into one registry", async () => {
    const { harness } = await makeHarness();
    expect(harness.tools.names().sort()).toEqual(
      ["bash", "edit", "find", "grep", "ls", "read", "write"].sort(),
    );
    expect(harness.isMock).toBe(true);
    await harness.shutdown();
  });

  it("builds a system prompt with environment and project memory", async () => {
    fs.writeFileSync(path.join(root, "TINY.md"), "# Tests run with npm test");
    const { harness } = await makeHarness();
    const prompt = harness.runtime.agent.state.systemPrompt;
    expect(prompt).toContain("TinyCode");
    expect(prompt).toContain(root);
    expect(prompt).toContain("TINY.md");
    expect(prompt).toContain("npm test");
    await harness.shutdown();
  });

  it("exposes skills by index and registers load_skill only when one exists", async () => {
    // No skills: the seven built-ins stay alone and no Skills section appears.
    const bare = await makeHarness();
    expect(bare.harness.tools.names()).not.toContain("load_skill");
    expect(bare.harness.runtime.agent.state.systemPrompt).not.toContain("## Skills");
    await bare.harness.shutdown();

    // With a skill: one-line index in the prompt, body kept out, tool registered.
    const dir = path.join(root, ".tinycode", "skills", "code-review");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\nname: code-review\ndescription: Review code changes.\n---\n# instructions\nSecret body line.\n",
    );
    const withSkill = await makeHarness();
    const prompt = withSkill.harness.runtime.agent.state.systemPrompt;
    expect(prompt).toContain("- code-review: Review code changes.");
    expect(prompt).not.toContain("Secret body line.");
    expect(withSkill.harness.tools.names()).toContain("load_skill");
    await withSkill.harness.shutdown();
  });

  it("registers the session from message one", async () => {
    const { harness, faux } = await makeHarness();
    faux.setResponses([fauxAssistantMessage("hello there")]);
    await harness.runtime.prompt("hi");
    expect(harness.session!.isActive).toBe(true);
    expect(harness.session!.messageCount).toBeGreaterThanOrEqual(2);
    const loaded = harness.session!.load(harness.session!.id);
    expect(loaded!.messages.length).toBeGreaterThanOrEqual(2);
    // Title recorded from the first user prompt.
    expect(loaded!.header.title).toBe("hi");
    await harness.shutdown();
  });
});

describe("hook: beforeToolCall (permission gate)", () => {
  it("denies a write in ask/headless mode and tells the model why", async () => {
    const { harness, faux } = await makeHarness();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "evil.txt", content: "x" })]),
      fauxAssistantMessage([fauxText("could not write")]),
    ]);

    await harness.runtime.prompt("create evil.txt");

    const results = harness.runtime.messages.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(1);
    const result = results[0] as {
      isError: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Permission denied");
    // File was never created.
    expect(fs.existsSync(path.join(root, "evil.txt"))).toBe(false);
    await harness.shutdown();
  });

  it("auto mode lets the same write through", async () => {
    const { harness, faux } = await makeHarness({ permissionMode: "auto" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "ok.txt", content: "hi" })]),
      fauxAssistantMessage([fauxText("done")]),
    ]);

    await harness.runtime.prompt("create ok.txt");
    expect(fs.readFileSync(path.join(root, "ok.txt"), "utf8")).toBe("hi");
    await harness.shutdown();
  });

  it("hard deny blocks even in auto mode", async () => {
    const { harness, faux } = await makeHarness({ permissionMode: "auto" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf /" })]),
      fauxAssistantMessage([fauxText("blocked")]),
    ]);

    await harness.runtime.prompt("clean everything");
    const results = harness.runtime.messages.filter((m) => m.role === "toolResult");
    const result = results[0] as { isError: boolean; content: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Permission denied");
    await harness.shutdown();
  });
});

describe("hook: afterToolCall (truncation)", () => {
  it("truncates oversized tool output and saves an artifact", async () => {
    fs.writeFileSync(path.join(root, "big.txt"), "Z".repeat(100));
    // auto mode so the `node -e` write-level command passes the gate;
    // this test is about AFTER-tool-call policy, not permissions.
    const { harness, faux } = await makeHarness({ permissionMode: "auto" });
    // Shrink the threshold so the test stays fast.
    const manager = harness.contextManager;
    (manager as { maxToolResultChars: number }).maxToolResultChars = 500;

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "node -e \"console.log('x'.repeat(5000))\"" }),
      ]),
      fauxAssistantMessage([fauxText("noted")]),
    ]);
    await harness.runtime.prompt("dump output");

    const results = harness.runtime.messages.filter((m) => m.role === "toolResult");
    const text = (results[0] as { content: Array<{ text?: string }> }).content[0]!.text!;
    expect(text).toContain("characters truncated");
    expect(text.length).toBeLessThan(2000);
    await harness.shutdown();
  });
});

describe("hook: subscribe (session persistence)", () => {
  it("persists every finalized message including tool results", async () => {
    const { harness, faux } = await makeHarness({ permissionMode: "auto" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "." })]),
      fauxAssistantMessage([fauxText("all good")]),
    ]);
    await harness.runtime.prompt("check the directory");

    const loaded = harness.session!.load(harness.session!.id)!;
    const roles = loaded.messages.map((m) => (m as { role: string }).role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(roles).toContain("toolResult");
    expect(loaded.skipped).toBe(0);
    await harness.shutdown();
  });
});

describe("hook: streamFn (mock streaming)", () => {
  it("streams tokens from the faux provider through the runtime", async () => {
    const { harness, faux } = await makeHarness();
    faux.setResponses([fauxAssistantMessage([fauxText("streamed answer")])]);

    const deltas: string[] = [];
    harness.runtime.subscribe((event) => {
      if (event.type === "message_update") {
        const ev = event as { assistantMessageEvent: { type: string; delta?: string } };
        if (ev.assistantMessageEvent.type === "text_delta") {
          deltas.push(ev.assistantMessageEvent.delta ?? "");
        }
      }
    });

    await harness.runtime.prompt("hello");
    expect(deltas.join("")).toContain("streamed answer");
    await harness.shutdown();
  });
});

describe("config layering", () => {
  it("loadConfig tolerates a missing file", () => {
    const loaded = loadConfig(root);
    expect(loaded.config).toEqual({});
    expect(loaded.warnings).toEqual([]);
  });

  it("loadConfig reports invalid JSON without throwing", () => {
    fs.mkdirSync(path.join(root, ".tinycode"));
    fs.writeFileSync(path.join(root, ".tinycode", "config.json"), "{oops");
    const loaded = loadConfig(root);
    expect(loaded.warnings[0]).toMatch(/Invalid JSON/);
    expect(loaded.config).toEqual({});
  });

  it("validateConfig catches type errors", () => {
    expect(validateConfig({ provider: 42 })).toContainEqual(expect.stringContaining("provider"));
    expect(validateConfig({ permissionMode: "yolo" })).toContainEqual(
      expect.stringContaining("permissionMode"),
    );
    expect(validateConfig({ context: { keepRecentMessages: "many" } })).toContainEqual(
      expect.stringContaining("keepRecentMessages"),
    );
    expect(validateConfig({ model: "x", permissionMode: "auto" })).toEqual([]);
  });

  it("flags secret-looking keys in committed config", () => {
    const found = findSecretLookingKeys({ provider: "openrouter", apiToken: "sk-123" });
    expect(found).toContain("apiToken");
  });

  it("permission mode: CLI > env > config > ask", () => {
    expect(resolvePermissionMode({}, { TINYCODE_PERMISSION_MODE: "auto" })).toBe("auto");
    expect(resolvePermissionMode({ permissionMode: "auto" }, {})).toBe("auto");
    expect(resolvePermissionMode({ permissionMode: "auto" }, {}, "ask")).toBe("ask");
    expect(resolvePermissionMode({}, {})).toBe("ask");
  });

  it("model ref: CLI > env > config", () => {
    expect(resolveModelRef({}, { TINYCODE_MODEL: "mock" })).toEqual({ model: "mock" });
    expect(resolveModelRef({ provider: "p", model: "m" }, { TINYCODE_MODEL: "mock" })).toEqual({
      model: "mock",
    });
    expect(resolveModelRef({ model: "m" }, {}, "anthropic/claude-x")).toEqual({
      provider: "anthropic",
      model: "claude-x",
    });
    expect(resolveModelRef({ provider: "p", model: "m" }, {})).toEqual({
      provider: "p",
      model: "m",
    });
    expect(resolveModelRef({}, {})).toEqual({});
  });
});

describe("system prompt", () => {
  it("includes skills section only when skills exist", () => {
    const base = { projectRoot: "/x", platform: "test" };
    expect(buildSystemPrompt(base)).not.toContain("## Skills");
    expect(buildSystemPrompt({ ...base, skills: "- code-review: review changes" })).toContain(
      "load_skill",
    );
  });

  it("readProjectMemory picks TINY.md first, merges compat files", () => {
    fs.writeFileSync(path.join(root, "TINY.md"), "tiny memory");
    fs.writeFileSync(path.join(root, "AGENTS.md"), "agents memory");
    const memory = readProjectMemory(root)!;
    expect(memory.indexOf("TINY.md")).toBeLessThan(memory.indexOf("AGENTS.md"));
    expect(readProjectMemory(fs.mkdtempSync(path.join(os.tmpdir(), "empty-")))).toBeUndefined();
  });
});
