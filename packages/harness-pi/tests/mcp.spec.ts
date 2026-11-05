import { once } from "node:events";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Layer } from "@chopin-ai/core";
import type { Workspace, WorkspaceProvider, WorkspaceState } from "@chopin-ai/workspace";
import { describe, expect, it } from "vitest";
import { AgentService, McpServers } from "../src/index.js";

const server = fileURLToPath(new URL("./fixtures/echo-mcp.mjs", import.meta.url));

/** A workspace that runs commands on this machine, so the test needs no container engine. */
const local: WorkspaceProvider = {
  open: (owner): Workspace => ({
    owner, root: tmpdir(),
    state: async () => "running", start: async () => {}, pause: async () => {}, stop: async () => {}, destroy: async () => {},
    command: (argv, env = {}) => ({ argv: [...argv], env: { ...env } }),
  }),
  list: async () => [],
};

describe("MCP servers from the layer", () => {
  it("runs command servers through the workspace and offers their tools", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("mcp__echo__echo", { text: "hi" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    ]);
    const reports: unknown[] = [];
    const layer: Layer = {
      instructions: undefined, skills: [], gates: [],
      mcpServers: {
        echo: { command: process.execPath, args: [server], env: { PREFIX: "echo: " } },
        missing: { command: "/nonexistent/server" },
      },
    };
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-mcp-")), workspaces: local, models: () => models, layer,
      agent: { model: { provider: model.provider, modelId: model.id } }, report: (error) => reports.push(error),
    });
    try {
      const root = await (await service.harness("alice")).root(context);
      await (await root.submit({ type: "input", content: "Echo hi." }, context)).wait(context);
      const results = (await root.context(context)).entries
        .filter((entry) => entry.kind === "pi.tool-result")
        .flatMap((entry) => (entry.model ?? []) as readonly { content: { text?: string }[] }[]);
      expect(results.map((result) => result.content.map((c) => c.text).join(""))).toEqual(["echo: hi"]);
      expect(String(reports[0])).toContain("MCP server missing is unavailable");
    } finally {
      await service.close(context);
    }
  });

  it("opens without a server that did not answer, refusing the calls gated on its tools and saying why", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "true" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    ]);
    const reports: unknown[] = [];
    const layer: Layer = {
      instructions: undefined, skills: [],
      mcpServers: { missing: { command: "/nonexistent/server" } },
      gates: [{ tool: "bash", requires: ["mcp__missing__lookup"], reason: "Look it up first." }],
    };
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-mcp-")), workspaces: local, models: () => models, layer,
      agent: { model: { provider: model.provider, modelId: model.id } }, report: (error) => reports.push(error),
    });
    try {
      const root = await (await service.harness("alice")).root(context);
      await (await root.submit({ type: "input", content: "Run true." }, context)).wait(context);
      const results = (await root.context(context)).entries
        .filter((entry) => entry.kind === "pi.tool-result")
        .flatMap((entry) => (entry.model ?? []) as readonly { content: { text?: string }[] }[]);
      expect(results.map((result) => result.content.map((c) => c.text).join(""))).toEqual([
        expect.stringContaining("requires mcp__missing__lookup, which no tool provides\nLook it up first."),
      ]);
      expect(reports.map(String)).toContainEqual(expect.stringContaining("gates name mcp__missing__lookup"));
    } finally {
      await service.close(context);
    }
  });

  it("offers a tool its server lists twice once, and says so", async () => {
    const servers = new McpServers({ echo: { command: process.execPath, args: [server], env: { TWICE: "1" } } }, local.open("alice"));
    const reports: unknown[] = [];
    try {
      const [offered] = await servers.connect((error) => reports.push(error));
      expect(offered?.tools?.map((tool) => tool.name)).toEqual(["mcp__echo__echo"]);
      expect(String(reports[0])).toContain("lists a tool name twice");
    } finally {
      await servers.close();
    }
  });

  it("offers a server's tools once it answers a retry, and never wakes a stopped workspace to try", async () => {
    // A command whose path has "=" in it is still the command.
    const launcher = join(await mkdtemp(join(tmpdir(), "chopin-mcp-later=")), "server");
    let state: WorkspaceState = "running";
    let starts = 0;
    const workspace: Workspace = { ...local.open("alice"), state: async () => state, start: async () => void starts++ };
    const servers = new McpServers({ later: { command: launcher } }, workspace);
    const reports: unknown[] = [];
    try {
      expect(await servers.connect((error) => reports.push(error))).toEqual([]);
      expect([...servers.unavailable]).toEqual(["later"]);
      expect(await servers.retry((error) => reports.push(error))).toEqual([]);
      expect(reports).toHaveLength(1);

      await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`);
      await chmod(launcher, 0o755);
      state = "stopped";
      expect(await servers.retry((error) => reports.push(error))).toEqual([]);
      expect(starts).toBe(1);
      state = "running";
      const [back] = await servers.retry((error) => reports.push(error));
      expect(back?.tools?.map((tool) => tool.name)).toEqual(["mcp__later__echo"]);
      expect([...servers.unavailable]).toEqual([]);
    } finally {
      await servers.close();
    }
  });

  it("connects nothing once closed, even for a retry under way", async () => {
    const launcher = join(await mkdtemp(join(tmpdir(), "chopin-mcp-closed-")), "server");
    const servers = new McpServers({ later: { command: launcher } }, local.open("alice"));
    expect(await servers.connect(() => {})).toEqual([]);
    await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`);
    await chmod(launcher, 0o755);
    await servers.close();
    expect(await servers.retry(() => {})).toEqual([]);
  });

  it("tells of a gate naming a tool its MCP server does not offer, and opens all the same", async () => {
    const layer: Layer = {
      instructions: undefined, skills: [],
      mcpServers: { echo: { command: process.execPath, args: [server] } },
      gates: [{ tool: "bash", requires: ["mcp__echo__nope"], reason: "Never satisfiable." }],
    };
    const reports: unknown[] = [];
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-mcp-")), workspaces: local, models: () => createModels(), layer,
      report: (error) => reports.push(error),
    });
    try {
      await service.harness("alice");
      expect(reports.map(String)).toContainEqual(expect.stringContaining("gates name mcp__echo__nope, which no MCP server offers yet"));
    } finally {
      await service.close(context);
    }
  });
});

/**
 * An MCP server over HTTP with one tool that answers with the authorization header it was called with, listing its
 * tools after `slowMs`.
 */
async function whoServer(slowMs = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const http = createServer(async (request, response) => {
    if (request.method !== "POST") return void response.writeHead(405).end();
    let body = "";
    for await (const chunk of request) body += chunk;
    const { id, method } = JSON.parse(body) as { id?: number; method: string };
    if (id === undefined) return void response.writeHead(202).end();
    const results: Record<string, unknown> = {
      initialize: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "who", version: "1.0.0" } },
      "tools/list": { tools: [{ name: "whoami", description: "Who calls", inputSchema: { type: "object", properties: {} } }] },
      "tools/call": { content: [{ type: "text", text: request.headers.authorization ?? "nobody" }] },
    };
    if (method === "tools/list") await sleep(slowMs);
    const reply = method in results ? { result: results[method] } : { error: { code: -32601, message: `unknown method ${method}` } };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, close: () => new Promise((resolve) => http.close(() => resolve())) };
}

describe("MCP servers a client sets", () => {
  it("offers their tools at once with the headers set, and takes new headers or the server away as told", async () => {
    const who = await whoServer();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const ask = () => [fauxAssistantMessage(fauxToolCall("mcp__who__whoami", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Done.")];
    faux.setResponses([...ask(), ...ask()]);
    const layer: Layer = { instructions: undefined, skills: [], gates: [], mcpServers: { layered: { type: "http", url: "http://127.0.0.1:9/" } } };
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-mcp-")), workspaces: local, models: () => models, layer,
      agent: { model: { provider: model.provider, modelId: model.id } }, report: () => {},
    });
    const answers = async () => {
      const root = await (await service.harness("alice")).root(context);
      await (await root.submit({ type: "input", content: "Who am I?" }, context)).wait(context);
      return (await root.context(context)).entries.filter((entry) => entry.kind === "pi.tool-result")
        .flatMap((entry) => (entry.model ?? []) as readonly { content: { text?: string }[] }[])
        .map((result) => result.content.map((c) => c.text).join(""));
    };
    try {
      expect(await service.setMcpServer("alice", "who", who.url, { authorization: "Bearer one" })).toBeUndefined();
      expect(await service.mcpServers("alice")).toEqual([{ name: "who", url: who.url, tools: 1 }]);
      expect(await answers()).toEqual(["Bearer one"]);
      // Set again by its name, a server takes its new headers, as a renewed credential does.
      await service.setMcpServer("alice", "who", who.url, { authorization: "Bearer two" });
      expect(await answers()).toEqual(["Bearer one", "Bearer two"]);
      expect((await service.loaded("alice", context)).mcpServers).toEqual(["layered", "who"]);

      await service.removeMcpServer("alice", "who");
      expect(await service.mcpServers("alice")).toEqual([]);
      expect(await service.setMcpServer("alice", "layered", who.url, {})).toContain("the layer already serves");
      expect(await service.setMcpServer("alice", "files", "file:///etc", {})).toContain("no http or https address");
    } finally {
      await service.close(context);
      await who.close();
    }
  });
});

describe("reaching MCP servers", () => {
  it("offers nothing of a server taken away while it was being reached", async () => {
    const slow = await whoServer(300);
    const mcp = new McpServers({}, local.open("alice"));
    try {
      const offering = mcp.set("slow", { type: "http", url: slow.url }, () => {});
      mcp.remove("slow");
      expect(await offering).toEqual([]);
      expect(mcp.status("slow")).toEqual({ tools: 0 });
    } finally {
      await mcp.close();
      await slow.close();
    }
  });

  it("logs only the kind of failure a server met, keeping its own words, which may quote a credential, for its owner", async () => {
    const answering = createServer((request, response) => {
      const unauthorized = request.headers.authorization === "Bearer refused";
      response.writeHead(unauthorized ? 401 : 500, { "content-type": "text/plain" }).end("token sk-quoted-secret is not valid");
    }).listen(0, "127.0.0.1");
    await once(answering, "listening");
    const url = `http://127.0.0.1:${(answering.address() as AddressInfo).port}/mcp`;
    const reports: string[] = [];
    const mcp = new McpServers({
      failing: { type: "http", url },
      refusing: { type: "http", url, headers: { authorization: "Bearer refused" } },
      unreachable: { type: "http", url: "http://127.0.0.1:9/mcp" },
    }, local.open("alice"));
    try {
      expect(await mcp.connect((error) => reports.push(error.message))).toEqual([]);
      expect(reports.sort()).toEqual([
        "MCP server failing is unavailable: it answered HTTP 500",
        "MCP server refusing is unavailable: it refused its credentials",
        "MCP server unreachable is unavailable: it could not be reached",
      ]);
      expect(mcp.status("failing").error).toContain("sk-quoted-secret");
    } finally {
      await mcp.close();
      answering.close();
    }
  });

  it("says once that a workspace will not run a command server, and does not try it again", async () => {
    const refusing: Workspace = {
      ...local.open("alice"),
      command: () => {
        throw new Error("this workspace runs only its execution daemon");
      },
    };
    const reports: string[] = [];
    const mcp = new McpServers({ echo: { command: process.execPath, args: [server] } }, refusing);
    try {
      expect(await mcp.connect((error) => reports.push(error.message))).toEqual([]);
      expect(reports).toEqual(["MCP server echo cannot run here"]);
      expect(mcp.unavailable.size).toBe(0);
      expect(mcp.status("echo")).toEqual({ tools: 0, error: "this workspace runs only its execution daemon" });
    } finally {
      await mcp.close();
    }
  });
});
