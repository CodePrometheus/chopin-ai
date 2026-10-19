import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
