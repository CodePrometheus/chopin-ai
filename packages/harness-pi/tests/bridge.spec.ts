import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client as createClient, methods, ndJsonStream, PROTOCOL_VERSION, type SessionNotification } from "@agentclientprotocol/sdk";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Workspace, WorkspaceProvider } from "@chopin-ai/workspace";
import type { ConversationId } from "@earendil-works/pi-durable";
import { proxy } from "./bridge-proxy.js";
import { describe, expect, it } from "vitest";
import { AgentService, launchToken, listen, serveAcp } from "../src/index.js";
import { connect, Conversation, contracts } from "../src/protocol.js";

const nowhere: WorkspaceProvider = {
  open: (owner): Workspace => ({
    owner, root: "/", state: async () => "running",
    start: async () => { }, pause: async () => { }, stop: async () => { }, destroy: async () => { }, command: (argv, env = {}) => ({ argv: [...argv], env: { ...env } }),
  }),
  list: async () => [],
};

const lookup = defineExtension({
  name: "lookup",
  tools: [defineTool({
    name: "lookup", description: "Look the answer up", parameters: Type.Object({}),
    execute: async () => ({ output: [{ type: "text", text: "42" }] }),
  })],
});

describe("ACP bridge", () => {
  it("lets an ACP client drive the agent through the service", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("lookup", {}, { id: "call-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The answer is 42."),
    ]);
    const model = faux.getModel();
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-bridge-")), workspaces: nowhere, models: () => models,
      agent: { model: { provider: model.provider, modelId: model.id } }, extensions: [lookup],
    });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const host = connect(`ws://127.0.0.1:${server.port}/?token=secret`);

    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    const bridge = serveAcp(ndJsonStream(toClient.writable, toAgent.readable), host);
    const updates: SessionNotification[] = [];
    const connection = createClient()
      .onRequest(methods.client.session.requestPermission, () => { throw new Error("no permission requests expected"); })
      .onNotification(methods.client.session.update, ({ params }) => { updates.push(params); })
      .connect(ndJsonStream(toAgent.writable, toClient.readable));
    const client = connection.agent;

    try {
      await client.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await client.request(methods.agent.session.new, { cwd: "/", mcpServers: [] });
      const response = await client.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "What is the answer?" }] });

      expect(response.stopReason).toBe("end_turn");
      expect(updates.every((n) => n.sessionId === sessionId)).toBe(true);
      expect(updates.map((n) => n.update)).toEqual([
        expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: "call-1", title: "lookup", status: "pending" }),
        expect.objectContaining({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" }),
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The answer is 42." } },
      ]);
    } finally {
      connection.close();
      bridge.close();
      await Promise.all([connection.closed, bridge.closed]);
      await host.close();
      await server.close();
      await service.close(context);
    }
  });

  it("ends a prompt whose service stays away instead of waiting for good", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    let answer = (): void => { };
    faux.setResponses([() => new Promise((resolve) => { answer = () => resolve(fauxAssistantMessage("Too late.")); })]);
    const model = faux.getModel();
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-bridge-")), workspaces: nowhere, models: () => models,
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const host = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    const bridge = serveAcp(ndJsonStream(toClient.writable, toAgent.readable), host, { lostAfterMs: 200 });
    const connection = createClient()
      .onRequest(methods.client.session.requestPermission, () => { throw new Error("no permission requests expected"); })
      .onNotification(methods.client.session.update, () => {})
      .connect(ndJsonStream(toAgent.writable, toClient.readable));
    const client = connection.agent;
    try {
      await client.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await client.request(methods.agent.session.new, { cwd: "/", mcpServers: [] });
      const prompt = client.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "Think forever." }] });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await server.close();
      await expect(prompt).rejects.toMatchObject({ data: { reason: "lost", detail: "the service stopped answering" } });
      await expect(client.request(methods.agent.session.new, { cwd: "/", mcpServers: [] })).rejects.toThrow();
    } finally {
      answer();
      connection.close();
      bridge.close();
      await Promise.all([connection.closed, bridge.closed]);
      await host.close();
      await service.close(context);
    }
  });

  for (const loss of [true, false]) {
    it(loss ? "recovers a committed submission after its response is lost" : "does not resend a refusal on a live connection", async () => {
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage("Answered once.")]);
      const model = faux.getModel();
      const service = new AgentService({
        dataDir: await mkdtemp(join(tmpdir(), "chopin-bridge-wire-")), workspaces: nowhere, models: () => models,
        agent: { model: { provider: model.provider, modelId: model.id } },
      });
      const server = await listen(service, { authenticate: launchToken("secret") });
      const declaration = contracts.find((entry) => entry.type === Conversation)!;
      const method = Object.keys(declaration.spec.variants.owner.methods).sort().indexOf("submit");
      expect(method).toBeGreaterThanOrEqual(0);
      const holds = new Map<string, string>();
      const requests: string[] = [];
      let pending: string | undefined;
      let dropped = false;
      const transport = await proxy(`ws://127.0.0.1:${server.port}/`, ({ link, direction, message, disconnect }) => {
        if (direction === "client" && message.kind === "hold") holds.set(`${link}:${message.hold}`, message.type);
        if (direction === "client" && message.kind === "call" && holds.get(`${link}:${message.hold}`) === Conversation.name && message.method === method) {
          expect(message.args).toBeInstanceOf(Uint8Array);
          const args = JSON.parse(new TextDecoder().decode(message.args as Uint8Array)) as { request: string; text: string };
          requests.push(args.request);
          if (!loss) return { ...message, args: JSON.stringify({ ...args, text: "" }) };
          if (!dropped) pending = `${link}:${message.call}`;
        }
        if (direction === "server" && message.kind === "result" && pending === `${link}:${message.call}`) {
          pending = undefined;
          dropped = true;
          disconnect();
          return null;
        }
      });
      const host = connect(transport.url, { token: "secret" });
      const toAgent = new TransformStream<Uint8Array, Uint8Array>();
      const toClient = new TransformStream<Uint8Array, Uint8Array>();
      const bridge = serveAcp(ndJsonStream(toClient.writable, toAgent.readable), host);
      const connection = createClient()
        .onRequest(methods.client.session.requestPermission, () => { throw new Error("no permission requests expected"); })
        .onNotification(methods.client.session.update, () => {})
        .connect(ndJsonStream(toAgent.writable, toClient.readable));
      const editor = connection.agent;
      try {
        await editor.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
        const { sessionId } = await editor.request(methods.agent.session.new, { cwd: "/", mcpServers: [] });
        const prompt = editor.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "Once." }] });
        if (loss) {
          expect((await prompt).stopReason).toBe("end_turn");
          expect(dropped).toBe(true);
          expect(requests).toHaveLength(2);
          expect(requests[1]).toBe(requests[0]);
        } else {
          await expect(prompt).rejects.toThrow();
          expect(requests).toHaveLength(1);
        }
        const stored = await service.submissions("local", Number(sessionId) as ConversationId, requests.length);
        expect(stored).toHaveLength(loss ? 1 : 0);
        if (loss) expect(stored[0]?.status).toBe("done");
      } finally {
        const errors: unknown[] = [];
        for (const close of [() => { connection.close(); bridge.close(); return Promise.all([connection.closed, bridge.closed]); }, () => host.close(), () => transport.close(), () => server.close(), () => service.close(context)]) {
          try { await close(); } catch (error) { errors.push(error); }
        }
        if (errors.length > 0) throw new AggregateError(errors, "test resources failed to close");
      }
    });
  }
});
