// A minimal stdio MCP server with one tool that echoes its input behind a prefix taken from the environment;
// TWICE lists that tool twice.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const echo = { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
const results = {
  initialize: () => ({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1.0.0" } }),
  ping: () => ({}),
  "tools/list": () => ({ tools: process.env.TWICE ? [echo, echo] : [echo] }),
  "tools/call": ({ arguments: args }) => ({ content: [{ type: "text", text: `${process.env.PREFIX ?? ""}${args.text}` }] }),
};

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  const result = results[method];
  send(result === undefined ? { id, error: { code: -32601, message: `unknown method ${method}` } } : { id, result: result(params) });
}
