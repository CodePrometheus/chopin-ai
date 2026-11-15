import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, type TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, defineExtension, defineTask, GenerationTask, Harness, hook, runEndTask, section, ToolTask, type ConversationId, type JsonObject } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, it } from "vitest";
import { CALL_TIMEOUT_MS } from "../src/protocol.js";
import { AgentService } from "../src/service.js";
import { GoalEngine, type GoalOptions } from "../src/goals/engine.js";
import { GoalDoc } from "../src/goals/store.js";
import { ReviewDoc, ReviewProposal } from "../src/goals/reviewer.js";
import { terminal, type EngineCommand, type GoalSnapshot } from "../src/goals/contracts.js";

function command(): EngineCommand { return { version: 1, requestId: randomUUID(), command: { kind: "goal.submit", objective: "Return Hello", completionCriteria: ["The answer is Hello"], grant: { id: "task-grant", version: 1 } } }; }
function call(name: string, args: JsonObject, id = randomUUID()) { return fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" }); }
function source(request: TranscriptContext): number {
  const result = request.messages.findLast((message) => message.role === "toolResult" && message.toolName === "goal_history");
  if (result?.role !== "toolResult" || result.content[0]?.type !== "text") throw new Error("source history was not read");
  const page = JSON.parse(result.content[0].text);
  expect(page.entries[0].model[0].content).toEqual([{ type: "text", text: "Hello" }]);
  return page.entries[0].id;
}
function complete(entryId: number) { return { kind: "complete", summary: "The original answer was checked", evidence: [{ kind: "assistant", criterion: 0, entryId }] }; }
async function fixture(options: Partial<GoalOptions> = {}, path?: string, hosted = false) {
  const directory = path ?? await mkdtemp(join(tmpdir(), "goal-review-"));
  const provider = fauxProvider({ models: [{ id: "worker" }, { id: "reviewer" }] });
  const models = createModels(); models.setProvider(provider.provider);
  const worker = provider.getModel("worker")!; const reviewer = provider.getModel("reviewer")!;
  const errors: unknown[] = [];
  const authority: Parameters<GoalOptions["authorize"]>[0][] = [];
  const policy: GoalOptions = { review: { model: { provider: reviewer.provider, modelId: reviewer.id } },
    authorize: async (request) => { authority.push(structuredClone(request)); return { allowed: true }; },
    settled: async () => {}, retryAfterMs: CALL_TIMEOUT_MS, report: (error) => errors.push(error), ...options,
  };
  const ordinary = defineExtension({ name: "fixture.mutable", sections: [section("mutable", () => "MUTABLE_WORKER_INSTRUCTIONS")] });
  if (hosted) {
    const service = new AgentService({ dataDir: directory, models: () => models, goals: () => policy, extensions: [ordinary],
      agent: { model: { provider: worker.provider, modelId: worker.id }, extensions: [ordinary] }, report: (error) => errors.push(error),
      workspaces: { list: async () => [], open: (owner) => ({ owner, root: directory, state: async () => "running", start: async () => {}, pause: async () => {}, stop: async () => {}, destroy: async () => {}, command: (argv, env = {}) => ({ argv: [...argv], env: { ...env } }) }) },
    });
    const engine = await service.goals("owner");
    return { directory, engine, harness: engine.store.harness, storage: engine.store.storage, registry: undefined, provider, authority, errors, close: () => service.close(context) };
  }
  const storage = await openNodeSqliteStorage(join(directory, "store.sqlite"));
  const engine = new GoalEngine(policy);
  const registry = createRegistry(); for (const extension of [...engine.extensions, ordinary]) registry.install(extension);
  const harness = await Harness.open(storage, { registry, models, settings: () => ({ ...engine.settings(registry), retry: { enabled: false } }), onReport: (error) => errors.push(error) }, context);
  engine.attach(harness, storage);
  await harness.root(context, { agent: { model: { provider: worker.provider, modelId: worker.id } } });
  return { directory, engine, harness, storage, registry, provider, authority, errors, close: async () => { await harness.close(context); await engine.close(); } };
}
async function until(f: Awaited<ReturnType<typeof fixture>>, id: string, predicate: (goal: GoalSnapshot) => boolean): Promise<GoalSnapshot> {
  const ctx = withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), context);
  const watch = await f.harness.watchDoc(GoalDoc, id, ctx);
  if (watch === undefined) throw new Error("goal is missing");
  const check = (goal: GoalSnapshot | null): GoalSnapshot | undefined => {
    if (goal !== null && predicate(goal)) return structuredClone(goal);
    if (goal !== null && (terminal(goal.status) || goal.status === "waiting_dependency")) throw new Error(`unexpected goal state: ${goal.status}; ${f.errors.map(String).join("; ")}`);
    return undefined;
  };
  try {
    const ready = check(watch.value.snapshot); if (ready !== undefined) return ready;
    return await new Promise((resolve, reject) => {
      watch.start(async (change) => { try { if (change.kind === "failed") reject(change.error); else { const goal = check(change.value.snapshot); if (goal !== undefined) resolve(goal); } } catch (error) { reject(error); } });
      void watch.closed.then((end) => reject(new Error(`goal watch ended: ${end.kind}`)));
    });
  } finally { await watch.stop(); }
}

it.each([false, true])("runs a private durable reviewer with only source history and decision tools (hosted: %s)", async (hosted) => {
  const f = await fixture({}, undefined, hosted);
  f.provider.setResponses([
    (request, _options, _state, model) => {
      expect(model.id).toBe("worker"); expect(getCurrentSystemPrompt(request.messages)).toContain("MUTABLE_WORKER_INSTRUCTIONS");
      expect(getCurrentTools(request.messages).some((tool) => tool.name.startsWith("goal_"))).toBe(false);
      return fauxAssistantMessage("Hello");
    },
    (request, _options, _state, model) => {
      expect(model.id).toBe("reviewer"); expect(getCurrentSystemPrompt(request.messages)).not.toContain("MUTABLE_WORKER_INSTRUCTIONS");
      expect(getCurrentTools(request.messages).map((tool) => tool.name)).toEqual(["goal_history", "goal_decide"]);
      return call("goal_history", { limit: 1 });
    },
    (request) => call("goal_decide", complete(source(request))),
  ]);
  try {
    const receipt = await f.engine.execute(command(), undefined, context);
    const goal = await until(f, receipt.goalId, (goal) => goal.status === "completed");
    expect(goal.result?.evidence).toHaveLength(1);
    expect(f.provider.state.callCount).toBe(3);
    const reviews = await f.storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind: ReviewDoc.definition.kind }, 1, undefined, context);
    expect(reviews.items).toHaveLength(1);
    const record = await f.harness.snapshot(ReviewDoc, reviews.items[0]!.key!, context);
    expect(record?.input?.goal.goalId).toBe(goal.goalId);
    expect(record?.decision?.kind).toBe("complete");
    expect(record?.conversation).not.toBe(goal.conversationId);
    expect(await f.engine.store.forConversation(record!.conversation! as ConversationId, context)).toBeUndefined();
    expect(f.authority.filter((request) => request.action === "model").every((request) => request.goalId === goal.goalId && request.tool === undefined)).toBe(true);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

it("rejects an existing result that the reviewer has not inspected", async () => {
  const f = await fixture();
  const request = command();
  f.provider.setResponses([fauxAssistantMessage("Hello"), async () => {
    const goal = await f.engine.snapshot(request.requestId, context);
    const conversation = await f.harness.conversation(goal.conversationId as ConversationId, context);
    const actual = (await conversation!.entries({ order: "descending" }, 1, undefined, context)).items[0]!;
    return call("goal_decide", complete(Number(actual.id)));
  }, (request) => {
    const rejected = request.messages.findLast((message) => message.role === "toolResult");
    expect(rejected).toMatchObject({ toolName: "goal_decide", isError: true });
    expect(JSON.stringify(rejected)).toContain("review evidence has not been inspected");
    return call("goal_history", { limit: 1 });
  }, (request) => call("goal_decide", complete(source(request)))]);
  try {
    const receipt = await f.engine.execute(request, undefined, context);
    await until(f, receipt.goalId, (goal) => goal.status === "completed");
    expect(f.provider.state.callCount).toBe(4);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

it("stops an authorization-blocked reviewer without another model request", async () => {
  let workerFinished = false;
  const f = await fixture({ authorize: async (request) => ({ allowed: request.action !== "model" || !workerFinished }) });
  f.provider.setResponses([() => { workerFinished = true; return fauxAssistantMessage("Hello"); }]);
  try {
    const receipt = await f.engine.execute(command(), undefined, context);
    const waiting = await until(f, receipt.goalId, (goal) => goal.status === "waiting_authorization");
    expect(f.provider.state.callCount).toBe(1);
    await f.engine.execute({ version: 1, requestId: randomUUID(), command: { kind: "goal.stop", goalId: receipt.goalId, expectedVersion: waiting.version } }, undefined, context);
    await until(f, receipt.goalId, (goal) => goal.status === "stopped");
    expect(f.provider.state.callCount).toBe(1);
    expect((await f.harness.inspect(context)).tasks).toEqual([]);
    expect(await f.engine.store.active(context)).toBe(false);
  } finally { await f.close(); }
});

it("keeps the review history boundary fixed when later source entries arrive", async () => {
  const f = await fixture();
  const request = command();
  f.provider.setResponses([fauxAssistantMessage("Hello"), async () => {
    const goal = await f.engine.snapshot(request.requestId, context);
    const conversation = await f.harness.conversation(goal.conversationId as ConversationId, context);
    await conversation!.commit((tx) => tx.appendEntry(conversation!.id, { kind: "fixture.later", data: { text: "arrived after the review began" } }), context);
    return call("goal_history", { limit: 1 });
  }, (request) => call("goal_decide", complete(source(request)))]);
  try {
    const receipt = await f.engine.execute(request, undefined, context);
    await until(f, receipt.goalId, (goal) => goal.status === "completed");
    expect(f.provider.state.callCount).toBe(3);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

it("does not accept a saved proposal when its decision tool ultimately fails", async () => {
  const f = await fixture();
  const reviewer = f.engine.extensions.find((extension) => extension.name === "chopin-goal-review")!;
  f.registry!.install(defineExtension({ ...reviewer, hooks: [hook(ToolTask, { afterTool: (call, result) => call.name === "goal_decide" ? { ...result, isError: true, output: [{ type: "text", text: "receipt fixture failed" }] } : undefined })] }));
  f.provider.setResponses([fauxAssistantMessage("Hello"), call("goal_history", { limit: 1 }), (request) => call("goal_decide", complete(source(request)))]);
  try {
    const receipt = await f.engine.execute(command(), undefined, context);
    const waiting = await until(f, receipt.goalId, (goal) => goal.status === "waiting_dependency");
    expect(waiting.result).toBeUndefined();
    const reviews = await f.storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind: ReviewDoc.definition.kind }, 1, undefined, context);
    const record = await f.harness.snapshot(ReviewDoc, reviews.items[0]!.key!, context);
    expect(record?.decision).toBeNull();
    const proposals = await f.storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind: ReviewProposal.definition.kind }, 1, undefined, context);
    const proposal = await f.harness.snapshot(ReviewProposal, proposals.items[0]!.key!, context);
    expect(proposal).toMatchObject({ decision: { kind: "complete" }, status: "rejected" });
    expect(waiting.waiting?.reason).toBe("review decision has no successful tool receipt");
    expect(await f.engine.store.active(context)).toBe(true);
  } finally { await f.close(); }
});

it("rejects a narrowed completion contract before recording the review decision", async () => {
  const f = await fixture();
  f.provider.setResponses([fauxAssistantMessage("Hello"), call("goal_decide", { kind: "continue", instruction: "Only do the easier part", criteria: ["A different requirement"] }),
    (request) => {
      const rejected = request.messages.findLast((message) => message.role === "toolResult");
      expect(rejected).toMatchObject({ toolName: "goal_decide", isError: true });
      expect(JSON.stringify(rejected)).toContain("replace established criteria");
      return call("goal_history", { limit: 1 });
    }, (request) => call("goal_decide", complete(source(request))),
  ]);
  try {
    const receipt = await f.engine.execute(command(), undefined, context);
    const goal = await until(f, receipt.goalId, (goal) => goal.status === "completed");
    expect(goal.completionCriteria).toEqual(["The answer is Hello"]);
    expect(f.provider.state.callCount).toBe(4);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

it("establishes initially absent criteria with the same committed review decision", async () => {
  const f = await fixture();
  const request = command();
  if (request.command.kind === "goal.submit") request.command.completionCriteria = [];
  f.provider.setResponses([fauxAssistantMessage("Hello"), call("goal_history", { limit: 1 }),
    (request) => call("goal_decide", { ...complete(source(request)), criteria: ["The answer is Hello"] }),
  ]);
  try {
    const receipt = await f.engine.execute(request, undefined, context);
    const goal = await until(f, receipt.goalId, (goal) => goal.status === "completed");
    expect(goal.completionCriteria).toEqual(["The answer is Hello"]);
    expect(goal.result?.evidence).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

it("finishes the original review after a temporary authority observation failure", async () => {
  let workerFinished = false;
  let unavailable = true;
  const f = await fixture({ retryAfterMs: 1, authorize: async (request) => {
    if (request.action === "model" && workerFinished && unavailable) { unavailable = false; throw new Error("authority temporarily unavailable"); }
    return { allowed: true };
  } });
  f.provider.setResponses([() => { workerFinished = true; return fauxAssistantMessage("Hello"); }, call("goal_history", { limit: 1 }), (request) => call("goal_decide", complete(source(request)))]);
  try {
    const receipt = await f.engine.execute(command(), undefined, context);
    // The dependency state is expected here; keep watching the actual durable goal until completion.
    const watch = await f.harness.watchDoc(GoalDoc, receipt.goalId, context);
    expect(watch).toBeDefined();
    try {
      if (watch!.value.snapshot?.status !== "completed") await new Promise<void>((resolve, reject) => {
        watch!.start(async (change) => {
          if (change.kind === "failed") reject(change.error);
          else if (change.value.snapshot?.status === "completed") resolve();
        });
        void watch!.closed.then(() => reject(new Error("goal observation ended before completion")));
      });
    } finally { await watch!.stop(); }
    expect(f.provider.state.callCount).toBe(3);
    expect(f.errors.map(String)).toContain("Error: authority temporarily unavailable");
  } finally { await f.close(); }
});

it.each(["missing-decision", "provider-error"])("recovers the original review without rerunning the worker (%s)", async (failure) => {
  const f = await fixture({ retryAfterMs: 1 });
  let workerCalls = 0;
  f.provider.setResponses([() => { workerCalls++; return fauxAssistantMessage("Hello"); },
    failure === "provider-error" ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture provider unavailable" }) : fauxAssistantMessage("No decision yet"),
    call("goal_history", { limit: 1 }), (request) => call("goal_decide", complete(source(request))),
  ]);
  try {
    const receipt = await f.engine.execute(command(), undefined, context);
    const watch = await f.harness.watchDoc(GoalDoc, receipt.goalId, context);
    expect(watch).toBeDefined();
    try {
      if (watch!.value.snapshot?.status !== "completed") await new Promise<void>((resolve, reject) => {
        watch!.start(async (change) => { if (change.kind === "failed") reject(change.error); else if (change.value.snapshot?.status === "completed") resolve(); });
        void watch!.closed.then(() => reject(new Error("review recovery observation ended")));
      });
    } finally { await watch!.stop(); }
    expect(workerCalls).toBe(1);
    expect(f.provider.state.callCount).toBe(4);
    const reviews = await f.storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind: ReviewDoc.definition.kind }, 1, undefined, context);
    expect(reviews.items).toHaveLength(1);
    const reviewId = reviews.items[0]!.key!;
    const record = await f.harness.snapshot(ReviewDoc, reviewId, context);
    expect(record?.decision?.kind).toBe("complete");
    const submissions = await f.storage.scanSubmissions({ conversationId: record!.conversation! as ConversationId }, 2, undefined, context);
    expect(submissions.items.map((item) => item.requestId)).toEqual([`${reviewId}:0`, `${reviewId}:1`]);
  } finally { await f.close(); }
});

it("keeps the actual dependency visible when owner input arrives during review recovery", async () => {
  const f = await fixture();
  f.provider.setResponses([fauxAssistantMessage("Hello"), fauxAssistantMessage("No decision yet")]);
  try {
    const receipt = await f.engine.execute(command(), undefined, context);
    const waiting = await until(f, receipt.goalId, (goal) => goal.status === "waiting_dependency");
    await f.engine.execute({ version: 1, requestId: randomUUID(), command: { kind: "goal.input", goalId: receipt.goalId, expectedVersion: waiting.version, text: "Keep the original completion requirements" } }, undefined, context);
    const updated = await f.engine.snapshot(receipt.goalId, context);
    expect(updated.status).toBe("waiting_dependency");
    expect(updated.waiting).toEqual(waiting.waiting);
    expect((await f.harness.snapshot(GoalDoc, receipt.goalId, context))?.pending).toHaveLength(1);
    await f.engine.execute({ version: 1, requestId: randomUUID(), command: { kind: "goal.stop", goalId: receipt.goalId, expectedVersion: updated.version } }, undefined, context);
    await until(f, receipt.goalId, (goal) => goal.status === "stopped");
    expect(f.provider.state.callCount).toBe(2);
  } finally { await f.close(); }
});

it("refuses completion when the review's required post-run work failed", async () => {
  const f = await fixture();
  const failed = defineTask<null, { phase: "check" }, null>({ name: "fixture.review-check", version: 1, initial: () => ({ phase: "check" }), phases: {
    check: async (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: "required review check failed" } } }), ctx),
  }, abort: async (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx) });
  const reviewer = f.engine.extensions.find((extension) => extension.name === "chopin-goal-review")!;
  f.registry!.install(defineExtension({ ...reviewer, tasks: [...reviewer.tasks!, failed], hooks: [hook(GenerationTask, { afterRun: () => ({ tasks: [runEndTask(failed, null)] }) })] }));
  f.provider.setResponses([fauxAssistantMessage("Hello"), call("goal_history", { limit: 1 }), (request) => call("goal_decide", complete(source(request)))]);
  try {
    const receipt = await f.engine.execute(command(), undefined, context);
    const waiting = await until(f, receipt.goalId, (goal) => goal.status === "waiting_dependency");
    expect(waiting.result).toBeUndefined();
    expect(f.provider.state.callCount).toBe(3);
    expect(f.errors.map(String)).toContain("Error: original review did not complete successfully");
  } finally { await f.close(); }
});

it("requires a successful history receipt before treating source evidence as inspected", async () => {
  const f = await fixture();
  const request = command();
  const reviewer = f.engine.extensions.find((extension) => extension.name === "chopin-goal-review")!;
  let failed = false;
  f.registry!.install(defineExtension({ ...reviewer, hooks: [hook(ToolTask, { afterTool: (call, result) => {
    if (call.name === "goal_history" && !failed) { failed = true; return { ...result, isError: true, output: [{ type: "text", text: "history receipt failed" }] }; }
    return undefined;
  } })] }));
  f.provider.setResponses([fauxAssistantMessage("Hello"), call("goal_history", { limit: 1 }), async (requestContext) => {
    expect(requestContext.messages.findLast((message) => message.role === "toolResult")).toMatchObject({ toolName: "goal_history", isError: true });
    const goal = await f.engine.snapshot(request.requestId, context);
    const conversation = await f.harness.conversation(goal.conversationId as ConversationId, context);
    const entry = (await conversation!.entries({ order: "descending" }, 1, undefined, context)).items[0]!;
    return call("goal_decide", complete(Number(entry.id)));
  }, (requestContext) => {
    const rejected = requestContext.messages.findLast((message) => message.role === "toolResult");
    expect(rejected).toMatchObject({ toolName: "goal_decide", isError: true });
    expect(JSON.stringify(rejected)).toContain("review evidence has not been inspected");
    return call("goal_history", { limit: 1 });
  }, (requestContext) => call("goal_decide", complete(source(requestContext)))]);
  try {
    const receipt = await f.engine.execute(request, undefined, context);
    await until(f, receipt.goalId, (goal) => goal.status === "completed");
    expect(f.provider.state.callCount).toBe(5);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

it("lets the reviewer correct rejected evidence before committing its decision", async () => {
  const f = await fixture();
  const responses: FauxResponseStep[] = [fauxAssistantMessage("Hello"), call("goal_history", { limit: 1 }),
    () => call("goal_decide", complete(Number.MAX_SAFE_INTEGER)),
    (request) => {
      const rejected = request.messages.findLast((message) => message.role === "toolResult");
      expect(rejected).toMatchObject({ toolName: "goal_decide", isError: true });
      return call("goal_decide", complete(source(request)));
    },
  ];
  f.provider.setResponses(responses);
  try {
    const receipt = await f.engine.execute(command(), undefined, context);
    const goal = await until(f, receipt.goalId, (goal) => goal.status === "completed");
    expect(goal.result?.evidence[0]?.entryId).not.toBe(Number.MAX_SAFE_INTEGER);
    expect(f.provider.state.callCount).toBe(4);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
