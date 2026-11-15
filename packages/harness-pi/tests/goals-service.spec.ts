import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { NativeWatchable, Watchable } from "@earendil-works/chord/watch";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { AgentService, listen } from "../src/index.js";
import { CALL_TIMEOUT_MS, connect, Conversation, Conversations, Goal, Goals, subscribe, type EngineCommand } from "../src/protocol.js";

function command(): EngineCommand {
  return { version: 1, requestId: randomUUID(), command: { kind: "goal.submit", objective: "A delegated goal", completionCriteria: ["A verified result"], grant: { id: "grant", version: 1 } } };
}
async function fixture(legacy = false) {
  const directory = await mkdtemp(join(tmpdir(), "goal-service-"));
  const provider = fauxProvider(); const models = createModels(); models.setProvider(provider.provider); const model = provider.getModel();
  const errors: unknown[] = [];
  const service = new AgentService({ dataDir: join(directory, "data"), models: () => models,
    agent: { model: { provider: model.provider, modelId: model.id } },
    workspaces: { list: async () => [], open: (owner) => ({ owner, root: directory, state: async () => "running",
      start: async () => {}, pause: async () => {}, stop: async () => {}, destroy: async () => {}, command: (argv, env = {}) => ({ argv: [...argv], env: { ...env } }),
    }) },
    goals: () => ({ allowDirectConversations: legacy, authorize: async (request) => ({ allowed: request.action !== "model" }),
      review: async () => { throw new Error("the model must remain blocked"); }, settled: async () => {}, retryAfterMs: CALL_TIMEOUT_MS, report: (error) => errors.push(error),
    }),
  });
  const server = await listen(service, { authenticate: (credential) => credential === "first" || credential === "second" ? { kind: "owner", owner: credential } : undefined });
  const first = connect(`ws://127.0.0.1:${server.port}/?token=first`);
  const second = connect(`ws://127.0.0.1:${server.port}/?token=second`);
  return { service, first, second, provider, errors, close: async () => { await first.close(); await second.close(); await server.close(); await service.close(context); } };
}
async function until<T>(source: Watchable<T> | NativeWatchable<T>, predicate: (value: T) => boolean): Promise<void> {
  if (predicate(source.value)) return;
  await new Promise<void>((resolve, reject) => {
    const stop = subscribe(source, (value) => { if (predicate(value)) { stop(); resolve(); } }, (error) => { stop(); reject(error); });
  });
}

it.each([false, true])("bars direct execution in a goal conversation (legacy: %s)", async (legacy) => {
  const f = await fixture(legacy);
  try {
    const goals = await f.first.get(Goals, {});
    const listing = await f.first.get(Conversations, {});
    if (legacy) expect(await f.first.root((ctx) => listing.create(ctx))).toBeGreaterThan(0);
    else await expect(f.first.root((ctx) => listing.create(ctx))).rejects.toThrow("goal_command_required");
    const receipt = await f.first.root((ctx) => goals.execute(command(), ctx));
    const goal = await f.first.get(Goal, { goal: receipt.goalId });
    await until(goal.snapshot, (snapshot) => snapshot.status === "waiting_authorization");
    const original = structuredClone(goal.snapshot.value);
    expect(listing.ids.value).toContain(original.conversationId);
    const conversation = await f.first.get(Conversation, { conversation: original.conversationId });
    const bypasses = [
      () => f.first.root((ctx) => conversation.submit({ text: "Bypass the goal" }, ctx)),
      () => f.first.root((ctx) => conversation.resubmit({}, ctx)),
      () => f.first.root((ctx) => conversation.reset({}, ctx)),
      () => f.first.root((ctx) => conversation.requeue({ queue: [] }, ctx)),
      () => f.first.root((ctx) => conversation.withdraw({}, ctx)),
      () => f.first.root((ctx) => conversation.abort({}, ctx)),
      () => f.first.root((ctx) => conversation.shell({ command: "printf bypass" }, ctx)),
      () => f.first.root((ctx) => conversation.stopCommand({}, ctx)),
      () => f.first.root((ctx) => conversation.compact({}, ctx)),
      () => f.first.root((ctx) => conversation.setMode({ mode: "full" }, ctx)),
      () => f.first.root((ctx) => listing.fork({ conversation: original.conversationId, at: 0 }, ctx)),
    ];
    for (const bypass of bypasses) await expect(bypass()).rejects.toThrow("goal_command_required");
    expect(goal.snapshot.value).toEqual(original);
    expect(f.provider.state.callCount).toBe(0);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

it("keeps goal identities, receipts and source cursors inside their authenticated owner", async () => {
  const f = await fixture();
  try {
    const goals = await f.first.get(Goals, {});
    const others = await f.second.get(Goals, {});
    const request = command();
    const receipt = await f.first.root((ctx) => goals.execute(request, ctx));
    await f.first.root((ctx) => goals.execute(command(), ctx));
    await expect(f.second.get(Goal, { goal: receipt.goalId })).rejects.toThrow("unknown_goal");
    expect(await f.second.root((ctx) => others.request({ requestId: request.requestId }, ctx))).toBeNull();
    const page = await f.first.root((ctx) => goals.page({ limit: 1 }, ctx));
    expect(page.cursor).toBeDefined();
    await expect(f.second.root((ctx) => others.page({ limit: 1, cursor: page.cursor }, ctx))).rejects.toThrow("invalid_cursor");
    expect((await f.second.root((ctx) => others.page({ limit: 1 }, ctx))).goals).toEqual([]);
    expect(f.provider.state.callCount).toBe(0);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
