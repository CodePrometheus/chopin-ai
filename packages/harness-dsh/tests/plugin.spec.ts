import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { AssistantStreamAccumulator, BlockAssembler, ToolCallId, createUserMessage, createToolResultMessage, type StreamChunk } from "@deepseek-ai/dsh-llm";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { chopinMeta } from "@chopin-ai/core";
import { describe, expect, it, onTestFinished } from "vitest";
import { runtime } from "./runtime.js";

async function layer(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chopin-dsh-layer-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const gates = "- tool: deliver\n  requires: [run_tests]\n  reason: Run the tests before delivering.\n";

describe("harness-dsh plugin", () => {
  it("refuses a gated call until the session log shows the required tool succeeded", async () => {
    const directory = await layer({ "gates.yaml": gates, "check.mjs": 'import assert from "node:assert/strict"; assert.equal(process.argv[2], "pass");\n' });
    const { root, create, call } = await runtime({ layer: directory });
    root.tools.register(defineTool({ name: "run_tests", description: "Run the local check", parameters: { pass: { type: "boolean", required: true } },
      output: { schema: { type: "string" }, render: (_args, text) => [{ type: "text", text }] },
      execute: async ({ pass }) => { await promisify(execFile)(process.execPath, [join(directory, "check.mjs"), pass ? "pass" : "fail"]); return "Check passed"; },
    }));
    root.tools.register(defineTool({ name: "deliver", description: "Write the result", parameters: {},
      output: { schema: { type: "string" }, render: (_args, text) => [{ type: "text", text }] },
      execute: async (_args, execution) => { if (execution.agent === undefined) throw new Error("test agent is required"); await writeFile(join(directory, `delivered-${execution.agent.id}`), "delivered"); return "Delivered"; },
    }));
    const first = await create(); const second = await create();
    expect(JSON.stringify((await call(first, "deliver")).content)).toContain("Run the tests before delivering.");
    expect((await call(first, "run_tests", { pass: false })).isError).toBe(true);
    expect((await call(first, "deliver")).isError).toBe(true);
    await expect(readFile(join(directory, `delivered-${first.id}`))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await call(first, "run_tests", { pass: true })).isError).toBeFalsy();
    expect((await call(first, "deliver")).isError).toBeFalsy();
    expect(await readFile(join(directory, `delivered-${first.id}`), "utf8")).toBe("delivered");
    expect((await call(second, "deliver")).isError).toBe(true);
    await expect(readFile(join(directory, `delivered-${second.id}`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("names a gate nothing could satisfy as a configuration error", async () => {
    const { root, create, call } = await runtime({ layer: await layer({ "gates.yaml": gates }) });
    root.tools.register(defineTool({ name: "deliver", description: "Must be refused", parameters: {}, output: { schema: { type: "string" }, render: (_args, text) => [{ type: "text", text }] }, execute: async () => { throw new Error("a denied body must not run"); } }));
    expect(JSON.stringify((await call(await create(), "deliver")).content)).toContain("requires run_tests, which no tool provides");
  });

  it("loads instructions and skills and calls real HTTP and stdio MCP services", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chopin-mcp-services-"));
    const file = join(directory, "input.txt");
    await writeFile(file, "Actual fixture content");
    const server = new McpServer({ name: "http-file-fixture", version: "1.0.0" });
    server.registerTool("read_fixture", { description: "Read this fixture's file" }, async () => {
      const text = await readFile(file, "utf8");
      await appendFile(`${file}.calls`, `${process.pid}\n`);
      return { content: [{ type: "text", text }] };
    });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await server.connect(transport);
    const errors: unknown[] = [];
    const http = createServer((request, response) => { void transport.handleRequest(request, response).catch((error) => { errors.push(error); response.writeHead(500).end(); }); });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    onTestFinished(async () => { await server.close(); http.closeAllConnections(); await new Promise<void>((resolve, reject) => http.close((error) => error === undefined ? resolve() : reject(error))); });
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
    const script = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
    const { root, create, call } = await runtime({
      layer: await layer({
        "AGENTS.md": "Prefer small diffs.\n",
        "skills/review-diff/SKILL.md": "---\nname: review-diff\ndescription: Review a diff.\n---\nCheck every hunk.\n",
        "mcp.json": JSON.stringify({ mcpServers: { docs: { command: process.execPath, args: [script], env: { CHOPIN_MCP_FIXTURE_FILE: file } }, web: { type: "http", url } } }),
      }),
    });
    expect((await root.systemPrompt.assemble()).sections.filter((s) => s.name === "chopin:guidance")).toEqual([{ name: "chopin:guidance", text: "Prefer small diffs.\n", interpolate: false }]);
    const [candidate] = await root.skills.list();
    expect(candidate).toMatchObject({ name: "review-diff", description: "Review a diff.", provider: "chopin-layer" });
    expect((await root.skills.get("review-diff"))?.content).toBe("Check every hunk.\n");
    const transports = [...root.registry.get(McpClient)!.fibers];
    await Promise.all(transports);
    await Promise.all(transports.map(async (fiber) => {
      const status = McpClient.connectionStatusOf(fiber);
      if (status === undefined) throw new Error("MCP instance did not expose its actual connection status");
      let stop = () => {};
      try {
        await new Promise<void>((resolve, reject) => {
          const observe = () => {
            const value = status.current();
            if (value.state === "connected") resolve();
            else if (value.state === "failed" || value.state === "closed") reject(new Error(`MCP fixture did not connect: ${JSON.stringify(value)}`));
          };
          stop = status.onChange(observe);
          observe();
        });
      } finally { stop(); }
    }));
    expect(transports.map((fiber) => fiber.config)).toEqual([
      { transport: "stdio", serverName: "docs", command: process.execPath, args: [script], env: { CHOPIN_MCP_FIXTURE_FILE: file } },
      { transport: "streamable-http", serverName: "web", url, headers: {} },
    ]);
    expect(transports.map((fiber) => McpClient.connectionStatusOf(fiber)?.current().state)).toEqual(["connected", "connected"]);
    const agent = await create();
    for (const name of ["mcp__docs__read_fixture", "mcp__web__read_fixture"]) {
      const result = await call(agent, name);
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: "text", text: "Actual fixture content" }]);
    }
    const processes = (await readFile(`${file}.calls`, "utf8")).trim().split("\n").map(Number);
    expect(processes).toHaveLength(2);
    expect(processes).toContain(process.pid);
    expect(new Set(processes).size).toBe(2);
    await root.fiber.dispose();
    expect(transports.every((fiber) => McpClient.connectionStatusOf(fiber)?.closure().closeConfirmed)).toBe(true);
    expect(errors).toEqual([]);
  });

  it("refuses a layer that names a transport not every harness speaks", async () => {
    const root = await layer({ "mcp.json": JSON.stringify({ mcpServers: { old: { type: "sse", url: "https://example.test/sse" } } }) });
    await expect(runtime({ layer: root })).rejects.toThrow("uses SSE");
  });

  it("records each session as ACP and ends each turn with its usage and model", async () => {
    const transcripts = await mkdtemp(join(tmpdir(), "chopin-dsh-transcripts-"));
    const { root } = await runtime({ layer: await layer({}), transcripts });
    const session = root.sessions.create(SessionId("s1"));
    session.append("turn/start", { turn: 1 });
    session.append("step/start", { turn: 1, step: 1 });
    session.append("user/message", createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "Fix it." }] }), { surfaceOp: "append" });
    session.append("user/message", createUserMessage({ source: { kind: "tool-registry" }, content: [{ type: "text", text: "Current tool context." }] }), { surfaceOp: "append" });
    const callId = ToolCallId("c1");
    const assembler = new BlockAssembler(); const stream = new AssistantStreamAccumulator();
    const chunks: StreamChunk[] = [
      { type: "reasoning-delta", index: 0, text: "Look." },
      { type: "tool-call-delta", index: 1, id: callId, name: "bash", argumentsDelta: '{"command":"ls"}' },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, reasoningTokens: 2 } },
    ];
    for (const chunk of chunks) { stream.push({ time: Date.now(), chunk }); assembler.push(chunk); }
    session.append("assistant/message", { turn: 1, step: 1, message: assembler.message({ provider: "provider-a", model: "model-a" }), stream: [...stream.snapshot()], usage: assembler.usage! }, { surfaceOp: "append" });
    session.append("tool/result", { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: "text", text: "a.txt" }], isError: false }) }, { surfaceOp: "append" });
    session.append("step/end", { turn: 1, step: 1 });
    session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await root.sessions.flush(session);

    const lines = (await readFile(join(transcripts, "s1.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.slice(0, -1).map((entry) => entry.notification.update.sessionUpdate))
      .toEqual(["user_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"]);
    expect(lines[2].notification.update).toMatchObject({ kind: "execute", rawInput: { command: "ls" } });
    const end = lines.at(-1);
    // Input counts what the cache served too, as the durable harness reports it.
    expect(end.turnEnd).toMatchObject({
      stopReason: "end_turn",
      usage: { inputTokens: 14, outputTokens: 5, totalTokens: 19, thoughtTokens: 2, cachedReadTokens: 4 },
    });
    expect(chopinMeta(end.turnEnd)).toEqual({ model: { provider: "provider-a", id: "model-a" } });

    session.append("turn/start", { turn: 2 });
    session.append("turn/end", { turn: 2, reason: { kind: "error", error: { message: "rate limited", code: "429" } } });
    await root.sessions.flush(session);
    const failed = JSON.parse((await readFile(join(transcripts, "s1.jsonl"), "utf8")).trim().split("\n").at(-1) ?? "");
    expect(chopinMeta(failed.turnEnd)?.error).toBe("rate limited");

    session.append("turn/start", { turn: 3 });
    session.append("turn/end", { turn: 3, reason: { kind: "interrupted" } });
    await root.sessions.flush(session);
    const cut = JSON.parse((await readFile(join(transcripts, "s1.jsonl"), "utf8")).trim().split("\n").at(-1) ?? "");
    expect(chopinMeta(cut.turnEnd)?.error).toContain("interrupted");
  });
});
