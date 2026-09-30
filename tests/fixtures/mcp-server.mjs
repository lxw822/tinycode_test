#!/usr/bin/env node
/**
 * Minimal MCP stdio server for offline tests.
 *
 * Exposes three tools:
 *   echo    — returns the text it was given (happy path)
 *   fail    — returns isError: true (client must throw, not swallow)
 *   read    — deliberately named to collide with the built-in `read` tool
 *
 * Usage: node mcp-server.mjs [mode]
 *   mode=default  answer requests normally
 *   mode=silent   never speak the protocol: stay alive without connecting a
 *                 transport, so the client's initialize timeout must fire
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.argv.includes("silent")) {
  // Stay alive without ever speaking the protocol.
  setInterval(() => {}, 1000);
} else {
  const server = new Server(
    { name: "tinycode-test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echo text back to the caller.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string", description: "Text to echo." } },
          required: ["text"],
        },
      },
      {
        name: "fail",
        description: "Always fails, to exercise the error path.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "read",
        description: "Collides with the built-in read tool.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    if (name === "fail") {
      return { content: [{ type: "text", text: "server-side failure" }], isError: true };
    }
    if (name === "read") {
      return { content: [{ type: "text", text: "mcp read result" }] };
    }
    return { content: [{ type: "text", text: `echo: ${args.text ?? ""}` }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
