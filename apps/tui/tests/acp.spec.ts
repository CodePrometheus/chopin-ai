import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AgentService, launchToken, listen } from "@chopin-ai/harness-pi";
import type { Workspace, WorkspaceProvider } from "@chopin-ai/workspace";
import { describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const nowhere: WorkspaceProvider = {
  open: (owner): Workspace => ({
    owner, root: "/", state: async () => "running",
    start: async () => {}, pause: async () => {}, stop: async () => {}, destroy: async () => {}, command: (argv, env = {}) => ({ argv: [...argv], env: { ...env } }),
  }),
  list: async () => [],
};

describe("chopin acp", () => {
  it("names its usage for a service url it cannot dial", async () => {
    const child = spawn(process.execPath, [bin, "acp", "localhost:1234"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const [code] = await once(child, "exit");
    expect(code).toBe(2);
    expect(stderr).toContain("usage: chopin acp [service url]");
  });

  it("speaks ACP on its stdio for an agent of the service", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("Hello over stdio.")]);
    const model = faux.getModel();
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-acp-")), workspaces: nowhere, models: () => models,
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const child = spawn(process.execPath, [bin, "acp", `ws://127.0.0.1:${server.port}/`], {
      env: { ...process.env, CHOPIN_TOKEN: "secret" }, stdio: ["pipe", "pipe", "inherit"],
    });
    const texts: string[] = [];
    const client = new ClientSideConnection(() => ({
      requestPermission: async () => { throw new Error("unexpected"); },
      sessionUpdate: async ({ update }) => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") texts.push(update.content.text);
      },
    }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await client.newSession({ cwd: "/", mcpServers: [] });
      expect((await client.prompt({ sessionId, prompt: [{ type: "text", text: "Hi." }] })).stopReason).toBe("end_turn");
      expect(texts).toEqual(["Hello over stdio."]);
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
      await server.close();
      await service.close(context);
    }
  }, 30_000);
});
