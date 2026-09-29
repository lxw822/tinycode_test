import fs from "node:fs";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai";

/**
 * Human-readable mock scripts for offline runs.
 *
 * A script is a JSON array; each entry becomes one scripted assistant turn:
 *
 *   [
 *     { "toolCalls": [{ "name": "read", "arguments": { "path": "a.ts" } }] },
 *     { "text": "final answer" }
 *   ]
 *
 * Loaded via TINYCODE_MOCK_SCRIPT=/path/to/script.json so headless `-p` runs
 * and E2E tests can drive the REAL agent loop with zero network.
 */
export interface MockScriptStep {
  text?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  stopReason?: "stop" | "toolUse" | "length";
}

export function parseMockScript(raw: string): FauxResponseStep[] {
  const steps: unknown = JSON.parse(raw);
  if (!Array.isArray(steps)) throw new Error("mock script must be a JSON array");
  return (steps as MockScriptStep[]).map((step, index) => {
    const blocks = [
      ...(step.toolCalls ?? []).map((call, i) =>
        fauxToolCall(call.name, call.arguments ?? {}, { id: `call_${index}_${i}` }),
      ),
      ...(step.text !== undefined ? [fauxText(step.text)] : []),
    ];
    if (blocks.length === 0) {
      throw new Error(`mock script step ${index} has neither text nor toolCalls`);
    }
    const stopReason = step.stopReason ?? ((step.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop");
    return fauxAssistantMessage(blocks, { stopReason });
  });
}

export function loadMockScriptFile(file: string): FauxResponseStep[] {
  return parseMockScript(fs.readFileSync(file, "utf8"));
}
