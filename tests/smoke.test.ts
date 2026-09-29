import { describe, expect, it } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";

/**
 * M0 smoke: a scripted faux model drives the REAL Pi agent loop.
 * This is the offline foundation every later test builds on.
 */
describe("pi smoke", () => {
  it("runs a tool call through the real Agent loop, offline", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);

    const toolCalls: Array<{ name: string; args: unknown }> = [];

    const echoTool = {
      name: "echo",
      description: "Echo back the text",
      label: "echo",
      parameters: Type.Object({ text: Type.String() }),
      execute: async (_id: string, raw: unknown) => {
        const params = raw as { text: string };
        toolCalls.push({ name: "echo", args: params });
        return {
          content: [{ type: "text" as const, text: `echo: ${params.text}` }],
          details: { echoed: params.text },
        };
      },
    };

    const agent = new Agent({
      streamFn: (model, context, options) => models.streamSimple(model, context, options),
      initialState: {
        systemPrompt: "You are a test agent.",
        model: models.getModel("faux", faux.models[0]!.id)!,
        tools: [echoTool],
      },
    });

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })]),
      fauxAssistantMessage([fauxText("done")]),
    ]);

    await agent.prompt("please echo hello");

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.args).toEqual({ text: "hello" });

    const last = agent.state.messages[agent.state.messages.length - 1]!;
    expect(last.role).toBe("assistant");
    if (last.role === "assistant") {
      const text = last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      expect(text).toBe("done");
    }
  });

  it("emits lifecycle events in order", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);

    const agent = new Agent({
      streamFn: (model, context, options) => models.streamSimple(model, context, options),
      initialState: {
        systemPrompt: "s",
        model: models.getModel("faux", faux.models[0]!.id)!,
        tools: [],
      },
    });

    const events: string[] = [];
    agent.subscribe((event) => {
      events.push(event.type);
    });

    faux.setResponses([fauxAssistantMessage("hi")]);
    await agent.prompt("hey");

    expect(events).toContain("agent_start");
    expect(events).toContain("message_end");
    expect(events[events.length - 1]).toBe("agent_end");
  });
});
