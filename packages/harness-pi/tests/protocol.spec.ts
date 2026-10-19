import type { IncomingMessage } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Workspace, WorkspaceProvider } from "@chopin-ai/workspace";
import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { credentialOf } from "../src/auth.js";
import { AgentService, integratorTokens, launchToken, listen } from "../src/index.js";
import { connect, Conversation, Conversations, endText, errorChain, errorText, heldList, lastFailure } from "../src/protocol.js";

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

  it("accepts only the launch token in single-user mode", () => {
    const authenticate = launchToken("secret");
    expect(authenticate("secret")).toEqual({ kind: "owner", owner: "local" });
    expect(authenticate("wrong")).toBeUndefined();
    expect(authenticate("")).toBeUndefined();
  });

  it("takes the credential from a bearer header, the address or the cookie, and none from a malformed one", () => {
    expect(credentialOf(request({ authorization: "Bearer a" }, "/?token=b"))).toBe("a");
    expect(credentialOf(request({}, "/?token=b"))).toBe("b");
    expect(credentialOf(request({ host: "127.0.0.1:4000", cookie: "other=1; chopin-4000=c" }))).toBe("c");
    expect(credentialOf(request({ host: "127.0.0.1:4000", cookie: "chopin-4001=c" }))).toBeUndefined();
    expect(credentialOf(request({ host: "127.0.0.1:4000", cookie: "chopin-4000=%" }))).toBeUndefined();
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
