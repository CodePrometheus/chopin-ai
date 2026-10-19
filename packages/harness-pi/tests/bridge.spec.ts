import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type SessionNotification } from "@agentclientprotocol/sdk";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Workspace, WorkspaceProvider } from "@chopin-ai/workspace";
import { ChordError, type Host } from "@earendil-works/chord";
import { describe, expect, it } from "vitest";
import { AgentService, launchToken, listen, serveAcp } from "../src/index.js";
import { connect, Conversations } from "../src/protocol.js";

const nowhere: WorkspaceProvider = {
  open: (owner): Workspace => ({
    owner, root: "/", state: async () => "running",
    start: async () => {}, pause: async () => {}, stop: async () => {}, destroy: async () => {}, command: (argv, env = {}) => ({ argv: [...argv], env: { ...env } }),
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
    serveAcp(ndJsonStream(toClient.writable, toAgent.readable), host);
    const updates: SessionNotification[] = [];
    const client = new ClientSideConnection(() => ({
      requestPermission: async () => { throw new Error("no permission requests expected"); },
      sessionUpdate: async (notification) => void updates.push(notification),
    }), ndJsonStream(toAgent.writable, toClient.readable));

    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await client.newSession({ cwd: "/", mcpServers: [] });
      const response = await client.prompt({ sessionId, prompt: [{ type: "text", text: "What is the answer?" }] });

      expect(response.stopReason).toBe("end_turn");
      expect(updates.every((n) => n.sessionId === sessionId)).toBe(true);
      expect(updates.map((n) => n.update)).toEqual([
        expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: "call-1", title: "lookup", status: "pending" }),
        expect.objectContaining({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" }),
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The answer is 42." } },
      ]);
    } finally {
      await host.close();
      await server.close();
      await service.close(context);
    }
  });

  it("ends a prompt whose service stays away instead of waiting for good", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    let answer = (): void => {};
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
    serveAcp(ndJsonStream(toClient.writable, toAgent.readable), host, { lostAfterMs: 200 });
    const client = new ClientSideConnection(() => ({
      requestPermission: async () => { throw new Error("no permission requests expected"); },
      sessionUpdate: async () => {},
    }), ndJsonStream(toAgent.writable, toClient.readable));
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await client.newSession({ cwd: "/", mcpServers: [] });
      const prompt = client.prompt({ sessionId, prompt: [{ type: "text", text: "Think forever." }] });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await server.close();
      await expect(prompt).rejects.toMatchObject({ data: { reason: "lost", detail: "the service stopped answering" } });
      await expect(client.newSession({ cwd: "/", mcpServers: [] })).rejects.toThrow();
    } finally {
      answer();
      await host.close();
      await service.close(context);
    }
  });

  it("sends a prompt again under the same request when its link fails mid-send", async () => {
    const requests: string[] = [];
    const listeners: ((value: unknown) => void)[] = [];
    const submissions = {
      value: {} as Record<string, unknown>,
      subscribe(listener: (value: unknown) => void) {
        listeners.push(listener);
        listener(this.value);
        return () => {};
      },
    };
    const conversation = {
      status: "live",
      view: { value: { entries: [], docs: {} }, subscribe: (listener: (value: unknown) => void) => (listener({ entries: [], docs: {} }), () => {}) },
      submissions,
      onStatus: () => () => {},
      release: () => {},
      submit: async ({ request }: { request: string }) => {
        requests.push(request);
        if (requests.length === 1) {
          // The link drops mid-call: the conversation reconnects, then is back.
          conversation.status = "loading";
          setTimeout(() => void (conversation.status = "live"), 50);
          throw new ChordError("unavailable", "link to chopin closed");
        }
        submissions.value = { 7: { status: "done" } };
        queueMicrotask(() => listeners.forEach((listener) => listener(submissions.value)));
        return 7;
      },
    };
    // A service whose first submit is lost on the way: the bridge cannot tell whether it arrived.
    const client = {
      get: async (type: unknown) => (type === Conversations ? { create: async () => 1, release: () => {} } : conversation),
      root: async (work: (ctx: unknown) => unknown) => work({}),
    } as unknown as Host;
    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    serveAcp(ndJsonStream(toClient.writable, toAgent.readable), client);
    const editor = new ClientSideConnection(() => ({
      requestPermission: async () => { throw new Error("no permission requests expected"); },
      sessionUpdate: async () => {},
    }), ndJsonStream(toAgent.writable, toClient.readable));

    await editor.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await editor.newSession({ cwd: "/", mcpServers: [] });
    const response = await editor.prompt({ sessionId, prompt: [{ type: "text", text: "Once." }] });
    expect(response.stopReason).toBe("end_turn");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
  });

  it("does not send again what failed on a live conversation", async () => {
    let tries = 0;
    const conversation = {
      status: "live",
      view: { value: { entries: [], docs: {} }, subscribe: (listener: (value: unknown) => void) => (listener({ entries: [], docs: {} }), () => {}) },
      submissions: { value: {}, subscribe: (listener: (value: unknown) => void) => (listener({}), () => {}) },
      onStatus: () => () => {},
      release: () => {},
      submit: async () => {
        tries++;
        throw new ChordError("unavailable", "the store failed");
      },
    };
    const client = {
      get: async (type: unknown) => (type === Conversations ? { create: async () => 1, release: () => {} } : conversation),
      root: async (work: (ctx: unknown) => unknown) => work({}),
    } as unknown as Host;
    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    serveAcp(ndJsonStream(toClient.writable, toAgent.readable), client);
    const editor = new ClientSideConnection(() => ({
      requestPermission: async () => { throw new Error("no permission requests expected"); },
      sessionUpdate: async () => {},
    }), ndJsonStream(toAgent.writable, toClient.readable));

    await editor.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await editor.newSession({ cwd: "/", mcpServers: [] });
    await expect(editor.prompt({ sessionId, prompt: [{ type: "text", text: "Once." }] })).rejects.toThrow();
    expect(tries).toBe(1);
  });
});
