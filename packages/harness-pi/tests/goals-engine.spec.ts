import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, defineExtension, defineTask, defineTool, GenerationTask, Harness, hook, runEndTask, ToolResultEntry, type Extension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { GoalEngine, type GoalOptions, type GoalReview } from "../src/goals/engine.js";
import { GoalDoc } from "../src/goals/store.js";
import { terminal, type EngineCommand, type GoalSnapshot } from "../src/goals/contracts.js";
import { CALL_TIMEOUT_MS } from "../src/protocol.js";

function command(): EngineCommand { return { version: 1, requestId: randomUUID(), command: { kind: "goal.submit", objective: "Return the exact answer Hello", completionCriteria: ["The delivered answer is Hello"], grant: { id: "original", version: 1 } } }; }
async function review(input: Parameters<GoalReview>[0]): Promise<Awaited<ReturnType<GoalReview>>> {
  const page = await input.entries(1);
  const entry = page.items[0];
  expect(entry?.kind).toBe(AssistantEntry.kind);
  const message = entry?.model?.find((message) => message.role === "assistant");
  expect(message?.content).toEqual([{ type: "text", text: "Hello" }]);
  return { kind: "complete", summary: "Hello was delivered", evidence: [{ kind: "assistant", criterion: 0, entryId: Number(entry!.id) }] };
}
async function fixture(options: Partial<GoalOptions> = {}, extensions: Extension[] = [], path?: string) {
  const directory = path ?? await mkdtemp(join(tmpdir(), "goal-engine-"));
  const storage = await openNodeSqliteStorage(join(directory, "store.sqlite"));
  const provider = fauxProvider(); const models = createModels(); models.setProvider(provider.provider); const model = provider.getModel();
  const errors: unknown[] = [];
  const engine = new GoalEngine({ authorize: async () => ({ allowed: true }), review, settled: async () => {}, retryAfterMs: CALL_TIMEOUT_MS, report: (error) => errors.push(error), ...options });
  const registry = createRegistry(); for (const extension of [...engine.extensions, ...extensions]) registry.install(extension);
  const harness = await Harness.open(storage, { registry, models, settings: () => engine.settings(registry), onReport: (report) => errors.push(report) }, context);
  engine.attach(harness, storage);
  await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  return { directory, engine, harness, provider, errors, close: async () => { await harness.close(context); await engine.close(); } };
}
async function until(f: Awaited<ReturnType<typeof fixture>>, id: string, predicate: (goal: GoalSnapshot) => boolean): Promise<GoalSnapshot> {
  const ctx = withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), context);
  const watch = await f.harness.watchDoc(GoalDoc, id, ctx);
  if (watch === undefined) throw new Error("goal observation is missing");
  try {
    if (watch.value.snapshot !== null && predicate(watch.value.snapshot)) return structuredClone(watch.value.snapshot);
    if (watch.value.snapshot !== null && terminal(watch.value.snapshot.status)) throw new Error(`goal ended unexpectedly: ${watch.value.snapshot.status}`);
    return await new Promise((resolve, reject) => {
      watch.start(async (change) => { if (change.kind === "failed") reject(change.error); else if (change.value.snapshot !== null) { if (predicate(change.value.snapshot)) resolve(structuredClone(change.value.snapshot)); else if (terminal(change.value.snapshot.status)) reject(new Error(`goal ended unexpectedly: ${change.value.snapshot.status}`)); } });
      void watch.closed.then((end) => reject(new Error(`goal watch ended: ${end.kind}; reports: ${f.errors.map(String).join("; ")}`)));
    });
  } finally { await watch.stop(); }
}

it("advances an admitted goal and verifies its actual committed answer", async () => {
  const f = await fixture(); f.provider.setResponses([fauxAssistantMessage("Hello")]);
  try {
    const request = command(); const receipt = await f.engine.execute(request, undefined, context);
    const goal = await until(f, receipt.goalId, (goal) => goal.status === "completed");
    expect(goal.objective).toBe("Return the exact answer Hello");
    expect(goal.result?.evidence).toHaveLength(1);
    expect(await f.engine.execute(request, undefined, context)).toEqual(receipt);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

it("does not finish while after-run child work remains active", async () => {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const child = defineTask<null, { phase: "wait" }, null>({ name: "fixture.after-run", version: 1, initial: () => ({ phase: "wait" }), phases: {
    wait: async (_task, runtime, ctx) => { entered.resolve(); await awaitWithContext(release.promise, ctx); await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx); },
  }, abort: async (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx) });
  const extension = defineExtension({ name: "fixture.after-run", tasks: [child], hooks: [hook(GenerationTask, { afterRun: () => ({ tasks: [runEndTask(child, null)] }) })] });
  const f = await fixture({}, [extension]); f.provider.setResponses([fauxAssistantMessage("Hello")]);
  try {
    const receipt = await f.engine.execute(command(), undefined, context);
    await awaitWithContext(entered.promise, withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), context));
    expect((await f.engine.snapshot(receipt.goalId, context)).status).not.toBe("completed");
    release.resolve();
    await until(f, receipt.goalId, (goal) => goal.status === "completed");
    expect(f.errors).toEqual([]);
  } finally { release.resolve(); await f.close(); }
});

it("keeps a pending question and original request identity across a real store reopen", async () => {
  let answer = false;
  const policy: Partial<GoalOptions> = { review: async (input) => answer ? review(input) : { kind: "wait", reason: "Confirm the intended answer" } };
  const f = await fixture(policy); f.provider.setResponses([fauxAssistantMessage("Hello")]);
  const request = command();
  const receipt = await f.engine.execute(request, undefined, context);
  const waiting = await until(f, receipt.goalId, (goal) => goal.status === "waiting_user");
  await f.close();
  const reopened = await fixture(policy, [], f.directory); reopened.provider.setResponses([fauxAssistantMessage("Hello")]);
  try {
    expect((await reopened.engine.snapshot(receipt.goalId, context)).waiting).toEqual(waiting.waiting);
    expect(await reopened.engine.request(request.requestId, context)).toEqual(receipt);
    answer = true;
    await reopened.engine.execute({ version: 1, requestId: randomUUID(), command: { kind: "goal.input", goalId: receipt.goalId, expectedVersion: waiting.version, text: "Confirmed", questionId: waiting.waiting!.questionId } }, undefined, context);
    await until(reopened, receipt.goalId, (goal) => goal.status === "completed");
    expect(reopened.errors).toEqual([]);
  } finally { await reopened.close(); }
});

it("waits for actual external quiescence before confirming stop", async () => {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const f = await fixture({ settled: async (goal, ctx) => { if (goal.status !== "accepted") { entered.resolve(); await awaitWithContext(release.promise, ctx); } } });
  f.provider.setResponses([fauxAssistantMessage("Hello")]);
  try {
    const receipt = await f.engine.execute(command(), undefined, context);
    await awaitWithContext(entered.promise, withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), context));
    const running = await f.engine.snapshot(receipt.goalId, context);
    await f.engine.execute({ version: 1, requestId: randomUUID(), command: { kind: "goal.stop", goalId: receipt.goalId, expectedVersion: running.version } }, undefined, context);
    expect((await f.engine.snapshot(receipt.goalId, context)).status).toBe("stopping");
    release.resolve();
    const stopped = await until(f, receipt.goalId, (goal) => goal.status === "stopped");
    expect(stopped.result).toBeUndefined();
  } finally { release.resolve(); await f.close(); }
});

it("keeps required authorization guards when a goal selects no optional extensions", async () => {
  const f = await fixture({ authorize: async (request) => ({ allowed: request.action !== "model" }) });
  f.provider.setResponses([fauxAssistantMessage("Hello")]);
  try {
    const receipt = await f.engine.execute(command(), { extensions: [] }, context);
    const goal = await until(f, receipt.goalId, (goal) => goal.status === "waiting_authorization" || goal.status === "waiting_dependency");
    expect(goal.status).toBe("waiting_authorization");
    expect(f.provider.state.callCount).toBe(0);
  } finally { await f.close(); }
});

it("rechecks replacement authority without losing a concurrent wake", async () => {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const f = await fixture({ authorize: async (request, ctx) => {
    if (request.action === "model" && request.grant?.id === "original") { entered.resolve(); await awaitWithContext(release.promise, ctx); return { allowed: false }; }
    return { allowed: true };
  } });
  f.provider.setResponses([fauxAssistantMessage("Hello"), fauxAssistantMessage("Hello")]);
  try {
    const receipt = await f.engine.execute(command(), undefined, context);
    await awaitWithContext(entered.promise, withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), context));
    const before = await f.engine.snapshot(receipt.goalId, context);
    await f.engine.execute({ version: 1, requestId: randomUUID(), command: { kind: "goal.input", goalId: receipt.goalId, expectedVersion: before.version, text: "Continue under replacement authority", grant: { id: "replacement", version: 2 } } }, undefined, context);
    release.resolve();
    const done = await until(f, receipt.goalId, (goal) => goal.status === "completed");
    expect(done.grant).toEqual({ id: "replacement", version: 2 });
    expect(f.errors).toEqual([]);
  } finally { release.resolve(); await f.close(); }
});

it("preserves unknown authority as a dependency wait without sending a model request", async () => {
  const f = await fixture({ authorize: async (request) => { if (request.action === "model") throw new Error("authority fixture unavailable"); return { allowed: true }; } });
  f.provider.setResponses([fauxAssistantMessage("Hello")]);
  try {
    const receipt = await f.engine.execute(command(), undefined, context);
    await until(f, receipt.goalId, (goal) => goal.status === "waiting_dependency");
    expect(f.provider.state.callCount).toBe(0);
    expect(f.errors.map(String)).toContain("Error: authority fixture unavailable");
  } finally { await f.close(); }
});

it("refuses completion when required after-run work failed", async () => {
  const failed = defineTask<null, { phase: "check" }, null>({ name: "fixture.failed-check", version: 1, initial: () => ({ phase: "check" }), phases: {
    check: async (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: "verification failed" } } }), ctx),
  }, abort: async (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx) });
  const extension = defineExtension({ name: "fixture.failed-check", tasks: [failed], hooks: [hook(GenerationTask, { afterRun: () => ({ tasks: [runEndTask(failed, null)] }) })] });
  const f = await fixture({}, [extension]); f.provider.setResponses([fauxAssistantMessage("Hello")]);
  try {
    const receipt = await f.engine.execute(command(), undefined, context);
    const waiting = await until(f, receipt.goalId, (goal) => goal.status === "waiting_dependency");
    expect(waiting.result).toBeUndefined();
    expect(waiting.waiting?.reason).toBe("required post-run work is not verified");
  } finally { await f.close(); }
});

it("rejects evidence copied from another goal in the same store", async () => {
  let foreign: number | undefined;
  const f = await fixture({ review: async (input) => foreign === undefined ? review(input) : { kind: "complete", summary: "Foreign answer", evidence: [{ kind: "assistant", criterion: 0, entryId: foreign }] } });
  f.provider.setResponses([fauxAssistantMessage("Hello"), fauxAssistantMessage("Hello")]);
  try {
    const first = await f.engine.execute(command(), undefined, context);
    const done = await until(f, first.goalId, (goal) => goal.status === "completed");
    foreign = done.result!.evidence[0]!.entryId;
    const second = await f.engine.execute(command(), undefined, context);
    const refused = await until(f, second.goalId, (goal) => goal.status === "waiting_dependency");
    expect(refused.result).toBeUndefined();
    expect(f.errors.map(String)).toContain("Error: evidence is not from this goal");
  } finally { await f.close(); }
});

it("reconciles an unavailable review under the original identity without another model run", async () => {
  const reviews: string[] = [];
  const f = await fixture({ retryAfterMs: 1, review: async (input) => {
    reviews.push(input.reviewId);
    if (reviews.length === 1) throw new Error("review outcome unavailable");
    return review(input);
  } });
  f.provider.setResponses([fauxAssistantMessage("Hello"), fauxAssistantMessage("Hello")]);
  try {
    const receipt = await f.engine.execute(command(), undefined, context);
    await until(f, receipt.goalId, (goal) => goal.status === "completed");
    expect(reviews).toHaveLength(2);
    expect(new Set(reviews).size).toBe(1);
    expect(f.provider.state.callCount).toBe(1);
  } finally { await f.close(); }
});

it("does not declare an authorization-waiting goal idle", async () => {
  const f = await fixture({ authorize: async (request) => ({ allowed: request.action !== "model" }) });
  f.provider.setResponses([fauxAssistantMessage("Hello")]);
  try {
    const receipt = await f.engine.execute(command(), undefined, context);
    await until(f, receipt.goalId, (goal) => goal.status === "waiting_authorization");
    expect(await f.engine.store.active(context)).toBe(true);
    expect((await f.engine.wake(context)).active).toBe(true);
  } finally { await f.close(); }
});

it("retains and resumes original stop reconciliation after an observation failure", async () => {
  let available = false;
  const f = await fixture({ retryAfterMs: 1, authorize: async (request) => ({ allowed: request.action !== "model" }), settled: async (goal) => { if (goal.status === "stopping" && !available) throw new Error("original effect observation unavailable"); } });
  try {
    const receipt = await f.engine.execute(command(), undefined, context);
    const waiting = await until(f, receipt.goalId, (goal) => goal.status === "waiting_authorization");
    await f.engine.execute({ version: 1, requestId: randomUUID(), command: { kind: "goal.stop", goalId: receipt.goalId, expectedVersion: waiting.version } }, undefined, context);
    await until(f, receipt.goalId, (goal) => goal.status === "stopping" && goal.waiting !== undefined);
    expect((await f.engine.wake(context)).active).toBe(true);
    available = true;
    await until(f, receipt.goalId, (goal) => goal.status === "stopped");
    expect(await f.engine.store.active(context)).toBe(false);
  } finally { await f.close(); }
});

it.each([false, true])("verifies the exact committed tool result (forged: %s)", async (forged) => {
  let premature: number | undefined;
  const extension = defineExtension({ name: "fixture.tool", tools: [defineTool({
    name: "lookup", description: "Return the checked answer", parameters: Type.Object({}),
    execute: async (_input, api, ctx) => {
      const entry = await api.commit((tx) => tx.appendEntry(api.conversationId, {
        kind: ToolResultEntry.kind,
        model: [{ role: "toolResult", toolCallId: "lookup-1", toolName: "lookup", content: [{ type: "text", text: "An uncommitted assertion" }], isError: false, timestamp: api.now() }],
      }), ctx);
      premature = Number(entry.id);
      return { output: [{ type: "text", text: "Hello" }] };
    },
  })] });
  const f = await fixture({ review: async (input) => {
    let page = await input.entries(1);
    while (page.items[0]?.kind !== ToolResultEntry.kind && page.next !== undefined) page = await input.entries(1, page.next);
    const source = page.items[0];
    expect(source?.model?.[0]).toMatchObject({ role: "toolResult", content: [{ type: "text", text: "Hello" }] });
    expect(source?.byTaskId).toBeDefined();
    const fake = await f.engine.store.storage.entry(premature! as import("@earendil-works/pi-durable").EntryId, context);
    expect(fake?.entry.byTaskId).toBe(source?.byTaskId);
    return { kind: "complete", summary: "Tool verified", evidence: [{ kind: "tool", criterion: 0, entryId: forged ? premature! : Number(source!.id) }] };
  } }, [extension]);
  f.provider.setResponses([fauxAssistantMessage(fauxToolCall("lookup", {}, { id: "lookup-1" }), { stopReason: "toolUse" }), fauxAssistantMessage("Hello")]);
  try {
    const receipt = await f.engine.execute(command(), undefined, context);
    const goal = await until(f, receipt.goalId, (goal) => goal.status === (forged ? "waiting_dependency" : "completed"));
    if (forged) {
      expect(goal.result).toBeUndefined();
      expect(f.errors.map(String)).toContain("Error: tool evidence is not the committed task result");
    } else expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
