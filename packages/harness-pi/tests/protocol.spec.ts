import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Workspace, WorkspaceProvider } from "@chopin-ai/workspace";
import { build } from "esbuild";
import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { credentialOf } from "../src/auth.js";
import { AgentService, integratorTokens, launchToken, listen } from "../src/index.js";
import {
  CallTimeout, connect, Conversation, Conversations, Credentials, endText, errorChain, errorText, heldList, IMAGES_MAX, lastFailure, Loop, openConversations,
  type LoginState, type LoopControl, type LoopStanding,
} from "../src/protocol.js";

const nowhere: WorkspaceProvider = {
  open: (owner): Workspace => ({
    owner, root: "/", state: async () => "running",
    start: async () => {}, pause: async () => {}, stop: async () => {}, destroy: async () => {}, command: (argv, env = {}) => ({ argv: [...argv], env: { ...env } }),
  }),
  list: async () => [],
};

const request = (headers: Record<string, string>, url = "/") => ({ headers, url }) as unknown as IncomingMessage;

/** Resolves once `ref` has `status`, now or later. */
function reaches(ref: { status: string; onStatus(listener: (status: string) => void): () => void }, status: string): Promise<void> {
  return new Promise((resolve) => {
    if (ref.status === status) return resolve();
    const stop = ref.onStatus((now) => {
      if (now !== status) return;
      stop();
      resolve();
    });
  });
}

function until<T, U extends T>(subscribe: (listener: (value: T) => void) => () => void, test: (value: T) => value is U): Promise<U>;
function until<T>(subscribe: (listener: (value: T) => void) => () => void, test: (value: T) => boolean): Promise<T>;
function until<T>(subscribe: (listener: (value: T) => void) => () => void, test: (value: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    const stop = subscribe((value) => {
      if (test(value)) {
        queueMicrotask(() => stop());
        resolve(value);
      }
    });
  });
}

describe("client protocol", () => {
  it("lets an authenticated client converse with its agent over a WebSocket", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("Hello from the agent.")]);
    const model = faux.getModel();
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-protocol-")), workspaces: nowhere, models: () => models,
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const client = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    try {
      const conversations = await client.get(Conversations, {});
      // The harness's own root conversation is no conversation the user started, nor one a client may open.
      expect(conversations.ids.value).not.toContain(ROOT_CONVERSATION_ID);
      await expect(client.get(Conversation, { conversation: ROOT_CONVERSATION_ID })).rejects.toThrow("unknown_conversation");
      await expect(client.root((ctx) => conversations.fork({ conversation: ROOT_CONVERSATION_ID, at: 0 }, ctx))).rejects.toThrow("unknown_conversation");
      const id = await client.root((ctx) => conversations.create(ctx));
      expect(conversations.ids.value).toContain(id);

      const conversation = await client.get(Conversation, { conversation: id });
      await client.root((ctx) => conversation.submit({ text: "Hi." }, ctx));
      await until(conversation.view.subscribe.bind(conversation.view), (view) => JSON.stringify(view).includes("Hello from the agent."));

      await client.root((ctx) => conversation.setMode({ mode: "read" }, ctx));
      await until(conversation.mode.subscribe.bind(conversation.mode), (mode) => mode === "read");

      // A fork made through one list reaches every list the owner holds.
      const other = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
      try {
        const theirs = await other.get(Conversations, {});
        const entry = (conversation.view.value as { entries: { id: number }[] }).entries.at(-1)?.id ?? 0;
        const fork = await client.root((ctx) => conversations.fork({ conversation: id, at: entry }, ctx));
        await until(theirs.ids.subscribe.bind(theirs.ids), (ids) => ids.includes(fork));
      } finally {
        await other.close();
      }

      // Another client, or this one after a reconnect, learns how earlier messages ended from the store.
      const later = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
      try {
        const again = await later.get(Conversation, { conversation: id });
        expect(Object.values(again.submissions.value)).toEqual([{ status: "done" }]);
      } finally {
        await later.close();
      }

      // A client holds one list however many ask at once, and lets go of one that arrives after it let go.
      const list = heldList(client);
      const [first, second] = await Promise.all([list.get(), list.get()]);
      expect(first).toBe(second);
      list.release();
      expect(first.status).toBe("released");
      const late = heldList(client);
      const arriving = late.get();
      late.release();
      await expect(arriving).rejects.toThrow("released");
      // An asker that gives up stops waiting; the open goes on for the next.
      const patient = heldList(client);
      const quitting = new AbortController();
      const abandoned = patient.get(quitting.signal);
      quitting.abort(new Error("gave up"));
      await expect(abandoned).rejects.toThrow("gave up");
      expect((await patient.get()).status).toBe("live");
      patient.release();
    } finally {
      await client.close();
      await server.close();
      await service.close(context);
    }
  });

  it("dials again when the link drops, so references come back once the service returns at its address", async () => {
    const service = new AgentService({ dataDir: await mkdtemp(join(tmpdir(), "chopin-protocol-")), workspaces: nowhere, models: () => createModels() });
    const first = await listen(service, { authenticate: launchToken("secret") });
    const client = connect(`ws://127.0.0.1:${first.port}/?token=secret`);
    try {
      const conversations = await client.get(Conversations, {});
      const statuses: string[] = [];
      conversations.onStatus((status) => statuses.push(status));
      await first.close();
      await reaches(conversations, "loading");
      const second = await listen(service, { authenticate: launchToken("secret"), port: first.port });
      try {
        await reaches(conversations, "live");
        expect(await client.root((ctx) => conversations.create(ctx))).toBeTypeOf("number");
        expect(statuses).toEqual(["loading", "live"]);
      } finally {
        await second.close();
      }
    } finally {
      await client.close();
      await service.close(context);
    }
  });

  it("follows a service that comes back at another address, when it can find it again", async () => {
    const service = new AgentService({ dataDir: await mkdtemp(join(tmpdir(), "chopin-protocol-")), workspaces: nowhere, models: () => createModels() });
    const first = await listen(service, { authenticate: launchToken("secret") });
    let current = { url: `ws://127.0.0.1:${first.port}/`, token: "secret" };
    const client = connect(current.url, { token: current.token, find: async () => current });
    try {
      const conversations = await client.get(Conversations, {});
      await first.close();
      await reaches(conversations, "loading");
      const second = await listen(service, { authenticate: launchToken("again") });
      current = { url: `ws://127.0.0.1:${second.port}/`, token: "again" };
      try {
        await reaches(conversations, "live");
      } finally {
        await second.close();
      }
    } finally {
      await client.close();
      await service.close(context);
    }
  });

  it("opens a conversation whose store cannot be read yet, and fills in its submissions once it can", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("Answered.")]);
    const model = faux.getModel();
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-protocol-")), workspaces: nowhere, models: () => models,
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const first = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    const later = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    try {
      const conversations = await first.get(Conversations, {});
      const id = await first.root((ctx) => conversations.create(ctx));
      const conversation = await first.get(Conversation, { conversation: id });
      const sent = await first.root((ctx) => conversation.submit({ text: "Hi." }, ctx));
      await until(conversation.submissions.subscribe.bind(conversation.submissions), (all) => all[String(sent)]?.status === "done");
      await first.close();

      const read = service.submissions.bind(service);
      let failing = true;
      service.submissions = async (...args) => {
        if (failing) {
          failing = false;
          throw new Error("the store is busy");
        }
        return read(...args);
      };
      const again = await later.get(Conversation, { conversation: id });
      expect(again.status).toBe("live");
      await until(again.submissions.subscribe.bind(again.submissions), (all) => all[String(sent)]?.status === "done");
    } finally {
      await later.close();
      await server.close();
      await service.close(context);
    }
  });

  it("admits a message once however often it is sent under the same request", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("Once.")]);
    const model = faux.getModel();
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-protocol-")), workspaces: nowhere, models: () => models,
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const client = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    try {
      const conversations = await client.get(Conversations, {});
      const conversation = await client.get(Conversation, { conversation: await client.root((ctx) => conversations.create(ctx)) });
      const first = await client.root((ctx) => conversation.submit({ text: "Hi.", request: "r1" }, ctx));
      const again = await client.root((ctx) => conversation.submit({ text: "Hi.", request: "r1" }, ctx));
      expect(again).toBe(first);
    } finally {
      await client.close();
      await server.close();
      await service.close(context);
    }
  });

  it("finishes a run a restart cut off, and the client that dials back learns how it ended", async () => {
    const faux = fauxProvider({ tokensPerSecond: 5 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("A long answer that streams slowly enough to be cut off part of the way through.")]);
    const model = faux.getModel();
    const options = {
      dataDir: await mkdtemp(join(tmpdir(), "chopin-protocol-")), workspaces: nowhere, models: () => models,
      agent: { model: { provider: model.provider, modelId: model.id } },
    };
    const service = new AgentService(options);
    const server = await listen(service, { authenticate: launchToken("secret") });
    const client = connect(`ws://127.0.0.1:${server.port}/`, { token: "secret" });
    let restarted: { service: AgentService; server: Awaited<ReturnType<typeof listen>> } | undefined;
    try {
      const conversations = await client.get(Conversations, {});
      const conversation = await client.get(Conversation, { conversation: await client.root((ctx) => conversations.create(ctx)) });
      const id = await client.root((ctx) => conversation.submit({ text: "Talk." }, ctx));
      await until(conversation.view.subscribe.bind(conversation.view), (view) => (view as { docs: Record<string, { run?: unknown }> }).docs["pi.live"]?.run !== undefined);
      await server.close();
      await service.close(context);

      faux.setResponses([fauxAssistantMessage("Picked up again.")]);
      const again = new AgentService(options);
      restarted = { service: again, server: await listen(again, { authenticate: launchToken("secret"), port: server.port }) };
      // Nothing asks the new service for this owner until the client is back; its first open resumes the run.
      const ended = await until(conversation.submissions.subscribe.bind(conversation.submissions), (all) => all[String(id)]?.status === "done");
      expect(ended[String(id)]).toEqual({ status: "done" });
    } finally {
      await client.close();
      await restarted?.server.close();
      await restarted?.service.close(context);
    }
  }, 20_000);

  it("names the latest submission's failure, and nothing for one answered, running or stopped", () => {
    expect(lastFailure({ 1: { status: "unanswered", reason: "model_error", detail: "rate limited" }, 2: { status: "done" } })).toBeUndefined();
    expect(lastFailure({ 1: { status: "done" }, 2: { status: "unanswered", reason: "model_error", detail: "rate limited" } }))
      .toBe("model_error: rate limited");
    expect(lastFailure({ 3: { status: "unanswered", reason: "aborted" } })).toBeUndefined();
    expect(lastFailure({ 3: { status: "pending" } })).toBeUndefined();
  });

  it("moves a conversation to another model the owner can reach, and refuses one it cannot", async () => {
    const faux = fauxProvider({ models: [{ id: "alpha" }, { id: "beta" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-protocol-")), workspaces: nowhere, models: () => models,
      agent: async () => ({ model: { provider: faux.provider.id, modelId: "alpha" } }),
    });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const client = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    try {
      const conversations = await client.get(Conversations, {});
      const choices = await client.root((ctx) => conversations.models(ctx));
      expect(choices.models.map(({ modelId }) => modelId)).toEqual(["alpha", "beta"]);
      expect(choices.current).toEqual({ provider: faux.provider.id, modelId: "alpha" });
      const conversation = await client.get(Conversation, { conversation: await client.root((ctx) => conversations.create(ctx)) });
      const modelOf = (view: unknown) => (view as { docs: Record<string, { model?: { modelId?: string } } | undefined> }).docs["pi.agent"]?.model?.modelId;
      expect(modelOf(conversation.view.value)).toBe("alpha");
      await client.root((ctx) => conversation.setModel({ provider: faux.provider.id, modelId: "beta" }, ctx));
      await until(conversation.view.subscribe.bind(conversation.view), (view) => modelOf(view) === "beta");
      await expect(client.root((ctx) => conversation.setModel({ provider: faux.provider.id, modelId: "gamma" }, ctx))).rejects.toThrow("unusable_model");
    } finally {
      await client.close();
      await server.close();
      await service.close(context);
    }
  });

  it("lists how each conversation stands: failed, pinned, archived, and seen since its last change or not", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("Done."), fauxAssistantMessage("", { stopReason: "error", errorMessage: "the model went away" })]);
    const model = faux.getModel();
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-protocol-")), workspaces: nowhere, models: () => models,
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const client = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    try {
      const conversations = await client.get(Conversations, {});
      const open = async () => {
        const id = await client.root((ctx) => conversations.create(ctx));
        return { id, ref: await client.get(Conversation, { conversation: id }) };
      };
      const answered = await open();
      const broken = await open();
      const settled = ({ ref }: typeof answered) =>
        until(ref.view.subscribe.bind(ref.view), (view) => JSON.stringify(view).includes("\"stopReason\"") && !JSON.stringify(view).includes("\"run\""));
      await client.root((ctx) => answered.ref.submit({ text: "Do it.", request: "a" }, ctx));
      await settled(answered);
      await client.root((ctx) => broken.ref.submit({ text: "Try.", request: "b" }, ctx));
      await settled(broken);
      const line = async (id: number) => (await client.root((ctx) => conversations.summaries(ctx))).find((summary) => summary.id === id);
      expect(await line(answered.id)).toMatchObject({ running: false, failed: false, pinned: false, archived: false, seen: 0 });
      expect(await line(broken.id)).toMatchObject({ failed: true });

      await client.root((ctx) => answered.ref.setPinned({ pinned: true }, ctx));
      await client.root((ctx) => broken.ref.setArchived({ archived: true }, ctx));
      await client.root((ctx) => answered.ref.markSeen({}, ctx));
      const pinned = await line(answered.id);
      expect(pinned).toMatchObject({ pinned: true, archived: false });
      expect(pinned?.seen).toBeGreaterThanOrEqual(pinned?.modified ?? Infinity);
      expect(await line(broken.id)).toMatchObject({ pinned: false, archived: true, seen: 0 });
      await client.root((ctx) => answered.ref.setPinned({ pinned: false }, ctx));
      expect(await line(answered.id)).toMatchObject({ pinned: false });
    } finally {
      await client.close();
      await server.close();
      await service.close(context);
    }
  });

  it("tells the model what the client shows its user, as it stands at each request", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    // The client's context as the latest system entry of each request has it: changes are appended, never rewritten.
    const seen: unknown[] = [];
    const answer = (context: { messages: { role: string; sections?: Record<string, unknown> }[] }) => {
      seen.push(context.messages.filter((message) => message.role === "system" && message.sections !== undefined && "client_context" in message.sections)
        .at(-1)?.sections?.client_context);
      return fauxAssistantMessage("Noted.");
    };
    faux.setResponses([answer, answer]);
    const model = faux.getModel();
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-protocol-")), workspaces: nowhere, models: () => models,
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const client = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    const answered = (count: number) => until(conversation.view.subscribe.bind(conversation.view), (view) => JSON.stringify(view).split("Noted.").length > count);
    let conversation: Awaited<ReturnType<typeof client.get<typeof Conversation>>>;
    try {
      const conversations = await client.get(Conversations, {});
      conversation = await client.get(Conversation, { conversation: await client.root((ctx) => conversations.create(ctx)) });
      await client.root((ctx) => conversation.setContext({ text: "The user is looking at the runs page." }, ctx));
      await client.root((ctx) => conversation.submit({ text: "Hi." }, ctx));
      await answered(1);
      expect(seen[0]).toContain("The user is looking at the runs page.");
      await client.root((ctx) => conversation.setContext({ text: "" }, ctx));
      await client.root((ctx) => conversation.submit({ text: "And now?" }, ctx));
      await answered(2);
      expect(seen[1]).toBeNull();
    } finally {
      await client.close();
      await server.close();
      await service.close(context);
    }
  });

  it("asks the latest message again, as it was or replaced, and starts the model afresh on a reset", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    // What each request showed the model of the conversation: its users' and its own words, in order.
    const seen: string[][] = [];
    const answer = (n: number) => (context: { messages: { role: string; content: unknown }[] }) => {
      seen.push(context.messages.filter(({ role }) => role === "user" || role === "assistant")
        .map(({ content }) => (typeof content === "string" ? content : (content as { text?: string }[]).map((block) => block.text ?? "").join(""))));
      return fauxAssistantMessage(`Answer ${n}.`);
    };
    faux.setResponses([answer(1), answer(2), answer(3), answer(4)]);
    const model = faux.getModel();
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-protocol-")), workspaces: nowhere, models: () => models,
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const client = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    try {
      const conversations = await client.get(Conversations, {});
      const conversation = await client.get(Conversation, { conversation: await client.root((ctx) => conversations.create(ctx)) });
      const answered = (n: number) => until(conversation.view.subscribe.bind(conversation.view), (view) => JSON.stringify(view).includes(`Answer ${n}.`));
      await expect(client.root((ctx) => conversation.retry({}, ctx))).rejects.toThrow("nothing_to_retry");
      await client.root((ctx) => conversation.submit({ text: "Question." }, ctx));
      await answered(1);

      await client.root((ctx) => conversation.retry({}, ctx));
      await answered(2);
      expect(seen[1]).toEqual(["Question."]);
      await client.root((ctx) => conversation.retry({ text: "Better question." }, ctx));
      await answered(3);
      expect(seen[2]).toEqual(["Better question."]);
      await expect(client.root((ctx) => conversation.retry({ text: "" }, ctx))).rejects.toThrow("empty_message");

      await client.root((ctx) => conversation.reset({}, ctx));
      await client.root((ctx) => conversation.submit({ text: "Fresh." }, ctx));
      await answered(4);
      expect(seen[3]).toEqual(["Fresh."]);
    } finally {
      await client.close();
      await server.close();
      await service.close(context);
    }
  });

  it("carries the images a message shows, and refuses one that says and shows nothing", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("A single pixel.")]);
    const model = faux.getModel();
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-protocol-")), workspaces: nowhere, models: () => models,
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const client = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
    try {
      const conversations = await client.get(Conversations, {});
      const conversation = await client.get(Conversation, { conversation: await client.root((ctx) => conversations.create(ctx)) });
      await client.root((ctx) => conversation.submit({ text: "What is this?", images: [{ data: pixel, mimeType: "image/png" }] }, ctx));
      const view = await until(conversation.view.subscribe.bind(conversation.view), (value) => JSON.stringify(value).includes("A single pixel."));
      expect(JSON.stringify(view)).toContain(pixel);
      // An image alone is a message too; nothing at all is not.
      await client.root((ctx) => conversation.submit({ text: "", images: [{ data: pixel, mimeType: "image/png" }] }, ctx));
      await expect(client.root((ctx) => conversation.submit({ text: "" }, ctx))).rejects.toThrow("empty_message");
      await expect(client.root((ctx) => conversation.submit({ text: "x", images: [{ data: pixel, mimeType: "image/tiff" as "image/png" }] }, ctx))).rejects.toThrow();
      const many = Array.from({ length: IMAGES_MAX + 1 }, () => ({ data: pixel, mimeType: "image/png" as const }));
      await expect(client.root((ctx) => conversation.submit({ text: "x", images: many }, ctx))).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
      await service.close(context);
    }
  });

  it("keeps a key a client sets where the owner's models read credentials, and shows only which providers have one", async () => {
    const credentials = new InMemoryCredentialStore();
    // Nothing from this machine's environment counts, so only the key set here can reach the provider.
    const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
    models.setProvider(anthropicProvider());
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-protocol-")), workspaces: nowhere, models: () => models, credentials: () => credentials,
    });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const client = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    try {
      const keys = await client.get(Credentials, {});
      const conversations = await client.get(Conversations, {});
      const choices = () => client.root((ctx) => conversations.models(ctx));
      expect(keys.providers.value).toEqual([]);
      expect((await choices()).models).toEqual([]);
      await client.root((ctx) => keys.setKey({ provider: "anthropic", key: "sk-test-key" }, ctx));
      await until(keys.providers.subscribe.bind(keys.providers), (providers) => providers.length === 1);
      expect(keys.providers.value).toEqual([{ provider: "anthropic", type: "api_key" }]);
      expect((await models.getAuth("anthropic"))?.auth).toMatchObject({ apiKey: "sk-test-key" });
      // The provider's models are the owner's to pick from once its key is set.
      const usable = (await choices()).models;
      expect(usable.length).toBeGreaterThan(0);
      expect(usable.every((model) => model.provider === "anthropic" && model.thinkingLevels.length > 0)).toBe(true);
      await expect(client.root((ctx) => keys.setKey({ provider: "nowhere", key: "k" }, ctx))).rejects.toThrow("credential_refused");

      await client.root((ctx) => keys.remove({ provider: "anthropic" }, ctx));
      await until(keys.providers.subscribe.bind(keys.providers), (providers) => providers.length === 0);
      expect(await models.getAuth("anthropic")).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
      await service.close(context);
    }
  });

  it("signs the owner in by a provider's own login or a key, and keeps nothing from a login that did not finish", async () => {
    const credentials = new InMemoryCredentialStore();
    const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
    const acme = fauxProvider({ provider: "acme" });
    models.setProvider({
      ...acme.provider,
      name: "Acme",
      baseUrl: "https://api.acme.test/v1",
      auth: {
        oauth: {
          name: "Acme subscription",
          isSubscription: true,
          login: async (interaction) => {
            interaction.notify({ type: "auth_url", url: "https://acme.test/authorize", instructions: "Copy the code it shows." });
            const code = await interaction.prompt({ type: "manual_code", message: "Paste the code." });
            return { type: "oauth", access: `access-${code}`, refresh: "refresh", expires: Date.now() + 3_600_000 };
          },
          refresh: async (credential) => credential,
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
        apiKey: {
          name: "Acme API key",
          login: async (interaction) => ({ type: "api_key", key: await interaction.prompt({ type: "secret", message: "Enter the key." }) }),
          resolve: async ({ credential }) => (credential?.key === undefined ? undefined : { auth: { apiKey: credential.key } }),
        },
      },
    });
    let refuse = false;
    const beta = fauxProvider({ provider: "beta" });
    models.setProvider({
      ...beta.provider,
      name: "Beta",
      auth: {
        oauth: {
          name: "Beta",
          login: async (interaction) => {
            if (refuse) throw new Error("the provider said no");
            interaction.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://beta.test/device", expiresInSeconds: 900 });
            return new Promise((_resolve, reject) => interaction.signal.addEventListener("abort", () => reject(new Error("Login cancelled"))));
          },
          refresh: async (credential) => credential,
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
    });
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-protocol-")), workspaces: nowhere, models: () => models, credentials: () => credentials,
    });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const client = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    try {
      const keys = await client.get(Credentials, {});
      const login = (test: (state: LoginState) => boolean) =>
        until(keys.login.subscribe.bind(keys.login), (state): state is LoginState => state !== null && test(state));
      const catalog = await client.root((ctx) => keys.catalog(ctx));
      expect(catalog.map(({ id, ways }) => [id, ways.map(({ type, subscription }) => `${type}:${subscription}`)])).toEqual([
        ["acme", ["oauth:true", "api_key:false"]],
        ["beta", ["oauth:false"]],
      ]);
      expect(catalog[0]?.hosts).toContain("api.acme.test");

      const copied = await client.root((ctx) => keys.startLogin({ provider: "acme", type: "oauth" }, ctx));
      const asked = await login((state) => state.id === copied && state.prompt !== undefined);
      expect(asked.events).toEqual([{ type: "auth_url", url: "https://acme.test/authorize", instructions: "Copy the code it shows." }]);
      expect(asked.prompt).toMatchObject({ type: "manual_code", message: "Paste the code." });
      await client.root((ctx) => keys.answer({ prompt: asked.prompt?.id ?? 0, value: "c0de" }, ctx));
      expect(await login((state) => state.id === copied && state.status !== "running")).toMatchObject({ status: "done" });
      expect((await models.getAuth("acme"))?.auth).toMatchObject({ apiKey: "access-c0de" });
      expect(keys.providers.value).toEqual([{ provider: "acme", type: "oauth" }]);

      const keyed = await client.root((ctx) => keys.startLogin({ provider: "acme", type: "api_key" }, ctx));
      const secret = await login((state) => state.id === keyed && state.prompt !== undefined);
      expect(secret.prompt?.type).toBe("secret");
      await client.root((ctx) => keys.answer({ prompt: secret.prompt?.id ?? 0, value: "sk-acme" }, ctx));
      await login((state) => state.id === keyed && state.status === "done");
      expect((await models.getAuth("acme"))?.auth).toMatchObject({ apiKey: "sk-acme" });

      const waiting = await client.root((ctx) => keys.startLogin({ provider: "beta", type: "oauth" }, ctx));
      const coded = await login((state) => state.id === waiting && state.events.length > 0);
      expect(coded.events[0]).toEqual({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://beta.test/device", expiresInSeconds: 900 });
      await client.root((ctx) => keys.cancelLogin({ login: waiting }, ctx));
      await login((state) => state.id === waiting && state.status === "cancelled");
      refuse = true;
      const refused = await client.root((ctx) => keys.startLogin({ provider: "beta", type: "oauth" }, ctx));
      expect(await login((state) => state.id === refused && state.status !== "running")).toMatchObject({ status: "failed", error: "the provider said no" });
      expect(await credentials.read("beta")).toBeUndefined();
      await expect(client.root((ctx) => keys.startLogin({ provider: "nowhere", type: "oauth" }, ctx))).rejects.toThrow("credential_refused");
    } finally {
      await client.close();
      await server.close();
      await service.close(context);
    }
  });

  it("answers the owner from the service's RSI loop, refusing an action the loop refuses, and says when there is none", async () => {
    const standing: LoopStanding = { version: 3, inUse: 2, archived: 1, kinds: 4, recurring: 1, shelved: 0, corrections: 1, held: 0, spentUsd: 0.5, weeklyBudgetUsd: 5 };
    const decided: string[] = [];
    const loop: LoopControl = {
      standing: async () => standing,
      changes: async () => [],
      undo: async (id) => (id === "known" ? undefined : `no change in use starts with ${id}`),
      corrections: async () => [],
      answer: async (key, learn) => void decided.push(`${key}:${learn}`),
      held: async () => [],
      decide: async () => undefined,
      settings: async () => ({ weeklyBudgetUsd: 5, regularModel: null, strongModel: null, holdForReview: false }),
      setSettings: async (change) => ({ weeklyBudgetUsd: 5, regularModel: null, strongModel: null, holdForReview: false, ...change }),
    };
    const service = new AgentService({ dataDir: await mkdtemp(join(tmpdir(), "chopin-protocol-")), workspaces: nowhere, models: () => createModels() });
    const withLoop = await listen(service, { authenticate: launchToken("secret"), loop });
    const without = await listen(service, { authenticate: launchToken("secret") });
    const client = connect(`ws://127.0.0.1:${withLoop.port}/?token=secret`);
    const other = connect(`ws://127.0.0.1:${without.port}/?token=secret`);
    try {
      const theLoop = await client.get(Loop, {});
      expect(await client.root((ctx) => theLoop.standing(ctx))).toEqual(standing);
      await client.root((ctx) => theLoop.undo({ id: "known" }, ctx));
      await expect(client.root((ctx) => theLoop.undo({ id: "other" }, ctx))).rejects.toThrow("loop_refused");
      await client.root((ctx) => theLoop.answer({ key: "terse", learn: true }, ctx));
      expect(decided).toEqual(["terse:true"]);
      expect((await client.root((ctx) => theLoop.setSettings({ holdForReview: true }, ctx))).holdForReview).toBe(true);
      const none = await other.get(Loop, {});
      await expect(other.root((ctx) => none.standing(ctx))).rejects.toThrow("no_loop");
    } finally {
      await client.close();
      await other.close();
      await withLoop.close();
      await without.close();
      await service.close(context);
    }
  });

  it("refuses credentials from clients where the service takes its own from where it runs", async () => {
    const service = new AgentService({ dataDir: await mkdtemp(join(tmpdir(), "chopin-protocol-")), workspaces: nowhere, models: () => createModels() });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const client = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    try {
      const keys = await client.get(Credentials, {});
      expect(keys.providers.value).toEqual([]);
      await expect(client.root((ctx) => keys.setKey({ provider: "anthropic", key: "k" }, ctx))).rejects.toThrow("not from its clients");
    } finally {
      await client.close();
      await server.close();
      await service.close(context);
    }
  });

  it("waits within its bound for a link while none is up, rather than failing at once", async () => {
    const vacant = createServer().listen(0, "127.0.0.1");
    await once(vacant, "listening");
    const { port } = vacant.address() as AddressInfo;
    vacant.close();
    const client = connect(`ws://127.0.0.1:${port}/?token=secret`);
    try {
      // The first dial has failed by now, so there is no link when the call is made.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expect(openConversations(client, { timeoutMs: 400 })).rejects.toBeInstanceOf(CallTimeout);
    } finally {
      await client.close();
    }
  });

  it("words an error, its causes and a reference's end the same way for every client", () => {
    expect(errorText(new Error())).toBe("Error");
    expect(errorChain(new Error("could not reclaim", { cause: new Error("engine gone") }))).toBe("could not reclaim: engine gone");
    expect(errorChain(new Error("open: disk full", { cause: new Error("disk full") }))).toBe("open: disk full");
    expect(errorChain(new Error("open: disk full", { cause: new Error("disk full", { cause: new Error("EIO") }) }))).toBe("open: disk full: EIO");
    expect(errorChain(new Error("x", { cause: null }))).toBe("x");
    expect(errorChain(new AggregateError([new Error("a"), new Error("b")], "both failed"))).toBe("both failed: a; b");
    const once = new Error("x");
    expect(errorChain(new AggregateError([once, once], "both"))).toBe("both: x");
    const beneath = new Error("b");
    expect(errorChain(new AggregateError([new Error("a", { cause: beneath }), beneath], "both"))).toBe("both: a: b");
    const looped = new Error("first");
    looped.cause = new Error("second", { cause: looped });
    expect(errorChain(looped)).toBe("first: second");
    expect(endText({ status: "gone" })).toBe("gone");
    expect(endText({ status: "gone", error: new Error("no conversation 7") })).toBe("no conversation 7");
  });

  it("bundles for browsers, reaching no Node built-in", async () => {
    // Bundling for browsers refuses to resolve a Node built-in, so one anywhere in the module's imports fails here.
    const failures = await build({ entryPoints: [fileURLToPath(new URL("../src/protocol.ts", import.meta.url))], bundle: true, platform: "browser", format: "esm", write: false, logLevel: "silent" })
      .then(() => [], (error: { errors: { text: string }[] }) => error.errors.map((each) => each.text));
    expect(failures).toEqual([]);
  });

  it("accepts only the launch token in single-user mode", () => {
    const authenticate = launchToken("secret");
    expect(authenticate("secret")).toEqual({ kind: "owner", owner: "local" });
    expect(authenticate("wrong")).toBeUndefined();
    expect(authenticate("")).toBeUndefined();
  });

  it("takes the credential from a bearer header or the address, never a cookie, and none from a malformed address", () => {
    expect(credentialOf(request({ authorization: "Bearer a" }, "/?token=b"))).toBe("a");
    expect(credentialOf(request({}, "/?token=b"))).toBe("b");
    expect(credentialOf(request({ host: "127.0.0.1:4000", cookie: "chopin-4000=c" }))).toBeUndefined();
    expect(credentialOf(request({}, "//["))).toBeUndefined();
  });

  it("names the owner from a token the integrator signed, and refuses anything else", async () => {
    const { publicKey, privateKey } = await generateKeyPair("EdDSA");
    const other = await generateKeyPair("EdDSA");
    const sign = (key: typeof privateKey, expires: string) =>
      new SignJWT({}).setProtectedHeader({ alg: "EdDSA" }).setSubject("bob").setIssuer("integrator").setExpirationTime(expires).sign(key);
    const authenticate = integratorTokens({ key: publicKey, issuer: "integrator" });

    expect(await authenticate(await sign(privateKey, "5m"))).toEqual({ kind: "owner", owner: "bob" });
    expect(await authenticate(await sign(privateKey, "-1m"))).toBeUndefined();
    expect(await authenticate(await sign(other.privateKey, "5m"))).toBeUndefined();
    expect(await authenticate("not a token")).toBeUndefined();
    const nobody = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA" }).setSubject("").setIssuer("integrator").setExpirationTime("5m").sign(privateKey);
    expect(await authenticate(nobody)).toBeUndefined();
  });
});
