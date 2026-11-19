import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { CompactionEntry, createRegistry, Harness, UsageDoc, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it, vi } from "vitest";
import { AgentService, IdleCompactionEntry } from "../src/index.js";
import { localWorkspace } from "./local-workspace.js";
import { IdleCompaction, type IdleCompactionOptions } from "../src/idle-compaction.js";

/** A service whose one model keeps its prompt cache for a second. */
async function cached() {
  const faux = fauxProvider({ models: [{ id: "cached", contextWindow: 1_000_000 }] });
  const model = Object.assign(faux.getModel(), { promptCache: { short: 1 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const root = await mkdtemp(join(tmpdir(), "chopin-idle-"));
  const service = new AgentService({
    dataDir: await mkdtemp(join(tmpdir(), "chopin-idle-data-")), workspaces: localWorkspace(root), models: () => models,
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  return { faux, service, key: `${model.provider}/${model.id}` };
}

const say = async (conversation: Conversation, text: string) =>
  expect((await (await conversation.submit({ type: "input", content: text }, context)).wait(context)).status).toBe("done");

const answer = (text: string) => () => fauxAssistantMessage(text);

async function authorized(authorize: NonNullable<IdleCompactionOptions["authorize"]>) {
  const provider = fauxProvider({ models: [{ id: "cached", contextWindow: 1_000_000 }] });
  const model = Object.assign(provider.getModel(), { promptCache: { short: 1 } });
  const models = createModels(); models.setProvider(provider.provider);
  const directory = await mkdtemp(join(tmpdir(), "chopin-idle-authority-"));
  const idle = new IdleCompaction({ models, eligible: async () => true, authorize });
  const registry = createRegistry(); registry.install(idle.extension);
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "storage.sqlite")), { registry, models }, context);
  idle.attach(harness);
  const conversation = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  harness.resume();
  let closing: Promise<void> | undefined;
  return { provider, harness, conversation, idle, close: () => closing ??= (async () => { await idle.close(); await harness.close(context); })() };
}

describe("IdleCompaction", () => {
  it("checks current permission before dispatching an optional summary", async () => {
    const entered = Promise.withResolvers<void>();
    const f = await authorized(async () => { entered.resolve(); return false; });
    f.provider.setResponses([answer("Read it."), answer("Read that too.")]);
    try {
      await say(f.conversation, `Read this: ${"a".repeat(200_000)}`);
      await say(f.conversation, `And this: ${"b".repeat(100_000)}`);
      await entered.promise;
      await setImmediate();
      expect(f.provider.state.callCount).toBe(2);
      expect((await f.conversation.context(context)).head).toBeUndefined();
      expect(f.idle.active).toBe(false);
    } finally { await f.close(); }
  });

  it("drains an outstanding permission check before closing its store", async () => {
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const f = await authorized(async () => { entered.resolve(); await release.promise; return true; });
    f.provider.setResponses([answer("Read it."), answer("Read that too.")]);
    let closed = false;
    try {
      await say(f.conversation, `Read this: ${"a".repeat(200_000)}`);
      await say(f.conversation, `And this: ${"b".repeat(100_000)}`);
      await entered.promise;
      const closing = f.close().then(() => { closed = true; });
      await setImmediate();
      expect(closed).toBe(false);
      expect(f.idle.active).toBe(true);
      release.resolve();
      await closing;
      expect(f.provider.state.callCount).toBe(2);
      expect(f.idle.active).toBe(false);
    } finally { release.resolve(); await f.close(); }
  });

  it("compacts a conversation left idle before its cache expires, reading the summary request from that cache", async () => {
    const { faux, service, key } = await cached();
    let asked = "";
    faux.setResponses([answer("Read it."), answer("Read that too."), (request) => {
      const last = request.messages.at(-1);
      asked = last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "text" ? last.content[0].text : "";
      return fauxAssistantMessage("## Goal\nRead two long texts.");
    }]);
    try {
      const harness = await service.harness("owner");
      const conversation = await service.newConversation("owner", context);
      await say(conversation, `Read this: ${"a".repeat(200_000)}`);
      await say(conversation, `And this: ${"b".repeat(100_000)}`);
      const before = (await harness.snapshot(UsageDoc, conversation.id, context))?.models[key]?.cacheRead ?? 0;

      await vi.waitFor(async () => expect((await conversation.context(context)).entries.at(-1)?.kind).toBe(IdleCompactionEntry.kind),
        { timeout: 5_000, interval: 50 });
      expect(asked).toMatch(/^Summarize this conversation so far/);
      const view = await conversation.context(context);
      expect(view.head?.kind).toBe(CompactionEntry.kind);
      expect(JSON.stringify(view.head?.model)).toContain("Read two long texts.");
      // The summary request repeated the conversation, so the provider read all of it from the cache.
      const after = (await harness.snapshot(UsageDoc, conversation.id, context))?.models[key]?.cacheRead ?? 0;
      expect(after - before).toBeGreaterThan(64_000);
    } finally {
      await service.close(context);
    }
  });

  it("leaves a short conversation as it is", async () => {
    const { faux, service } = await cached();
    faux.setResponses([answer("Hello.")]);
    try {
      const conversation = await service.newConversation("owner", context);
      await say(conversation, "Hi.");
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(faux.state.callCount).toBe(1);
      expect((await conversation.context(context)).head).toBeUndefined();
    } finally {
      await service.close(context);
    }
  });
});
