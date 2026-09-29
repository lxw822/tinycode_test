import { describe, expect, it } from "vitest";
import { ModelRegistry, ModelResolutionError, mockRegistry } from "../src/model/registry.js";
import { createModels } from "@earendil-works/pi-ai";

describe("ModelRegistry", () => {
  it("resolves the mock model without any credentials", async () => {
    const { registry } = mockRegistry();
    const { model, mock } = await registry.resolve({ model: "mock" });
    expect(mock).toBe(true);
    expect(model.id).toBe("mock");
    expect(model.provider).toBe("faux");
  });

  it("accepts TINYCODE_MODEL=mock style refs", async () => {
    const registry = new ModelRegistry(createModels());
    expect(registry.isMockRef({ model: "mock" })).toBe(true);
    expect(registry.isMockRef({ provider: "faux", model: "mock" })).toBe(true);
    expect(registry.isMockRef({ provider: "anthropic", model: "claude" })).toBe(false);

    const { mock } = await registry.resolve({ provider: "mock", model: "anything" });
    expect(mock).toBe(true);
  });

  it("resolves an explicit provider/model pair from the catalog", async () => {
    const registry = new ModelRegistry();
    const { model, mock } = await registry.resolve({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    expect(mock).toBe(false);
    expect(model.provider).toBe("anthropic");
    expect(model.id).toBe("claude-haiku-4-5");
  });

  it("throws actionable guidance for an unknown model", async () => {
    const registry = new ModelRegistry();
    await expect(registry.resolve({ provider: "anthropic", model: "not-a-model" })).rejects.toThrow(
      ModelResolutionError,
    );

    await expect(registry.resolve({ provider: "anthropic", model: "not-a-model" })).rejects.toThrow(
      /Unknown model/,
    );
  });

  it("lists available models as provider/model strings", () => {
    const registry = new ModelRegistry();
    const list = registry.listAvailable();
    expect(list.length).toBeGreaterThan(10);
    expect(list.some((m) => m.startsWith("anthropic/"))).toBe(true);
    expect(list).toEqual([...list].sort());
  });

  it("applies maxOutputTokens as a cap", async () => {
    const registry = new ModelRegistry();
    registry.setMaxOutputTokens(16384);
    const { model } = await registry.resolve({ provider: "anthropic", model: "claude-haiku-4-5" });
    expect(model.maxTokens).toBe(16384);
  });

  it("enableMock is idempotent", () => {
    const { registry, handle } = mockRegistry();
    const again = registry.enableMock();
    expect(again).toBe(handle);
    expect(registry.getMockHandle()).toBe(handle);
  });

  it("resolves a bare provider id to its first model", async () => {
    const registry = new ModelRegistry();
    const { model } = await registry.resolve({ model: "anthropic" });
    expect(model.provider).toBe("anthropic");
  });

  it("mock provider streams without network", async () => {
    const { registry, handle } = mockRegistry();
    handle.setResponses([
      {
        role: "assistant",
        content: [{ type: "text", text: "offline reply" }],
        api: "test",
        provider: "faux",
        model: "mock",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    ]);
    const { model } = await registry.resolve({ model: "mock" });
    const stream = registry.collection.streamSimple(model, {
      messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
    });
    let text = "";
    for await (const event of stream) {
      if (event.type === "text_delta") text += event.delta;
    }
    expect(text).toBe("offline reply");
  });
});
