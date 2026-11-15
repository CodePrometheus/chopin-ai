import { isDeepStrictEqual } from "node:util";
import { withAbortSignal, BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { AssistantEntry, CompactionTask, defineExtension, defineTask, GenerationTask, hook, LiveDoc, runEndTask, section, ToolResultEntry, ToolTask, type AgentChange, type ConversationId, type Cursor, type EntryId, type EntryRecord, type Extension, type Harness, type HarnessSettings, type HookApi, type RegistryReader, type Storage, type TaskId, type TaskRuntime } from "@earendil-works/pi-durable";
import { refusal } from "../service-error.js";
import { GOAL_CONTROL_KIND, terminal, validateCommand, type EngineCommand, type EngineReceipt, type GoalArtifact, type GoalGrant, type GoalPage, type GoalResult, type GoalSnapshot } from "./contracts.js";
import { ActiveGoals, bump, GoalBinding, GoalDoc, GoalStore, requireSnapshot, setBlock, type GoalBlock, type GoalCheckpoint, type GoalOutcome, type GoalRecord, type GoalTask } from "./store.js";
import { Decision, type GoalDecision } from "./decisions.js";
import { GoalReviewer, ReviewBinding, type GoalReviewOptions } from "./reviewer.js";
import { RunAudit } from "./audit.js";
export type { GoalDecision } from "./decisions.js";

/** A host policy check, bound to the current runtime outside the execution store. */
export type GoalAuthorization = { action: "owner" | "submit" | "model" | "tool"; grant?: GoalGrant; goalId?: string; tool?: string };
export type GoalReview = (input: { reviewId: string; goal: GoalSnapshot; submission: number; entries(limit: number, cursor?: Cursor): Promise<{ items: readonly EntryRecord[]; next?: Cursor }> }, context: Context) => Promise<GoalDecision>;

/** Trusted execution adapters; user extensions do not receive these interfaces. */
export interface GoalOptions {
  /** Explicitly retain legacy owner-driven conversations alongside goals; disabled when omitted. */
  allowDirectConversations?: boolean;
  authorize(request: GoalAuthorization, context: Context): Promise<{ allowed: boolean; reason?: string }>;
  /** Read-only verification or reconciliation under a stable review identity; never perform task effects here. */
  review: GoalReview | GoalReviewOptions;
  /** Resolve only when original external operations and their output are reconciled; unknown state must reject or wait. */
  settled(goal: GoalSnapshot, context: Context): Promise<void>;
  /** Verify actual artifact bytes under this goal's resource authority, including the proposed digest. */
  artifact?(goal: GoalSnapshot, artifact: GoalArtifact, context: Context): Promise<void>;
  /** Published dependency-recovery policy, in milliseconds; no retry count is synthesized. */
  retryAfterMs: number;
  report(error: unknown): void;
}
type Runtime = TaskRuntime<{ goalId: string }, GoalCheckpoint, GoalOutcome, object>;

/** Durable goal coordination using the same execution store as conversations and tasks. */
export class GoalEngine {
  readonly extension: Extension;
  /** Register every extension; private reviewer tools are excluded by `settings()`. */
  readonly extensions: readonly Extension[];
  readonly task: GoalTask;
  readonly #options: GoalOptions;
  readonly #reviewer: GoalReviewer | undefined;
  readonly #abortions = new Set<Promise<unknown>>();
  #store: GoalStore | undefined;

  constructor(options: GoalOptions) {
    if (!Number.isSafeInteger(options.retryAfterMs) || options.retryAfterMs < 1) throw new Error("goal recovery policy is required");
    this.#options = options;
    this.#reviewer = typeof options.review === "function" ? undefined : new GoalReviewer(options.review, options.retryAfterMs, () => this.store, () => this.extension, (goal, decision, context) => this.#validate(goal, decision, context));
    const audit = defineTask<{ goalId: string; generation: number }, { phase: "check" }, null>({
      name: "chopin.goal-run-audit", version: 1, initial: () => ({ phase: "check" }), phases: {
        check: async (task, runtime, context) => {
          const live = await runtime.snapshot(LiveDoc, runtime.conversationId, context);
          if (Number(live?.run?.taskId) !== task.input.generation || live?.run?.afterRun?.tasks === undefined) throw new Error("original run audit scope is missing");
          const peers = live.run.afterRun.tasks.filter((id) => id !== runtime.taskId);
          const outcomes = await Promise.all(peers.map((id) => runtime.waitForTask(id, context)));
          await runtime.commit(async (tx) => {
            const record = await tx.doc(RunAudit, `${task.input.goalId}:${task.input.generation}`, null);
            record.checked = true; record.passed = outcomes.every((peer) => peer.state.outcome.status === "completed"); record.tasks = peers.map(Number);
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
        },
      }, abort: async (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
    });
    this.task = defineTask<{ goalId: string }, GoalCheckpoint, GoalOutcome>({ name: "chopin.goal-driver", version: 1, initial: () => ({ phase: "dispatch" }), phases: {
      dispatch: async (task, runtime, context) => this.#dispatch(task.input.goalId, runtime, context),
      run: async (task, runtime, context) => this.#run(task.input.goalId, task.state.checkpoint.submission, runtime, context),
      wait: async (task, runtime, context) => this.#wait(task.input.goalId, task.state.checkpoint.resume, runtime, context),
    }, abort: async (task, runtime, context) => this.#stop(task.input.goalId, runtime, context) });
    this.extension = defineExtension({ name: "chopin-goals", tasks: [this.task, audit], sections: [section("goal", async ({ conversationId }, context) => {
      if (await this.isReview(conversationId, context)) return undefined;
      const goalId = await this.#goal(conversationId, context);
      if (goalId === undefined) return undefined;
      const goal = await this.store.snapshot(goalId, context);
      return `Pursue the original objective and every completion criterion. Report remaining work and questions honestly. A reply ending does not itself finish the goal.\n${JSON.stringify({ objective: goal.objective, completionCriteria: goal.completionCriteria })}`;
    })], hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => { await this.#guard(api, "model", context); },
        beforeProviderRequest: async (_request, api, context) => { await this.#guard(api, "model", context); },
        afterRun: async (_run, api, context) => {
          const goalId = await this.#goal(api.conversationId, context);
          return goalId === undefined ? undefined : { tasks: [runEndTask(audit, { goalId, generation: Number(api.taskId) })] };
        },
      }),
      hook(ToolTask, { beforeTool: async (call, api, context) => {
        const review = await this.isReview(api.conversationId, context);
        await this.#guard(api, review ? "model" : "tool", context, review ? undefined : call.name);
      } }),
      hook(CompactionTask, { beforeCompact: async (_compaction, api, context) => { await this.#guard(api, "model", context); } }),
    ] });
    this.extensions = [this.extension, ...(this.#reviewer === undefined ? [] : [this.#reviewer.extension])];
  }
  /** Evaluate dynamically so newly registered ordinary extensions retain their normal availability. */
  settings(registry: RegistryReader): HarnessSettings | undefined {
    return this.#reviewer === undefined ? undefined : { extensions: registry.snapshot().installed().filter((extension) => extension.name !== this.#reviewer!.extension.name) };
  }
  /** Hosts must withhold the work environment from these private conversations. */
  async isReview(conversation: ConversationId, context: Context): Promise<boolean> {
    return (await this.store.harness.snapshot(ReviewBinding, conversation, context))?.reviewId != null;
  }
  attach(harness: Harness, storage: Storage): void {
    if (this.#store !== undefined) throw new Error("goal engine is already attached");
    this.#store = new GoalStore(harness, storage, this.task, [this.extension.name]);
  }
  get store(): GoalStore {
    if (this.#store === undefined) throw new Error("goal engine is not attached");
    return this.#store;
  }
  get allowDirectConversations(): boolean { return this.#options.allowDirectConversations === true; }
  async execute(envelope: EngineCommand, agent: AgentChange | undefined, context: Context): Promise<EngineReceipt> {
    validateCommand(envelope);
    await this.#authorize({ action: "owner" }, context);
    const replay = await this.store.replay(envelope, context);
    if (replay !== undefined) return replay;
    const command = envelope.command;
    if (command.kind === "goal.submit" || command.kind === "goal.input" && command.grant !== undefined) {
      await this.#authorize({ action: "submit", grant: command.grant }, context);
    }
    const receipt = await this.store.execute(envelope, agent, context);
    if (command.kind === "goal.stop") this.#abort(await this.store.driverId(receipt.goalId, BACKGROUND_CONTEXT));
    this.store.harness.resume();
    return receipt;
  }
  async request(id: string, context: Context): Promise<EngineReceipt | undefined> { await this.#authorize({ action: "owner" }, context); return this.store.request(id, context); }
  async snapshot(id: string, context: Context): Promise<GoalSnapshot> { await this.#authorize({ action: "owner" }, context); return this.store.snapshot(id, context); }
  async page(limit: number, cursor: Cursor | undefined, context: Context): Promise<GoalPage> { await this.#authorize({ action: "owner" }, context); return this.store.page(limit, cursor, context); }
  async forConversation(id: ConversationId, context: Context): Promise<GoalSnapshot | undefined> { await this.#authorize({ action: "owner" }, context); return this.store.forConversation(id, context); }
  async wake(context: Context): Promise<{ active: boolean; at?: number }> {
    await this.#authorize({ action: "owner" }, context);
    const inspection = await this.store.harness.inspect(context);
    const wake = this.store.harness.wake();
    return { ...wake, active: wake.active || await this.store.active(context) || inspection.tasks.some((task) => task.state.kind === "blocked") };
  }
  async resume(context: Context): Promise<void> { await this.#authorize({ action: "owner" }, context); this.store.harness.resume(); }
  async close(): Promise<void> { await Promise.allSettled([...this.#abortions]); }
  #abort(id: TaskId): void {
    const work = this.store.harness.abortTask(id, BACKGROUND_CONTEXT);
    this.#abortions.add(work);
    void work.catch((error) => { try { this.#options.report(error); } catch { /* Reporting cannot authorize work. */ } }).finally(() => this.#abortions.delete(work));
  }
  async #authorize(request: GoalAuthorization, context: Context): Promise<void> {
    if (!(await this.#options.authorize(request, context)).allowed) throw refusal("forbidden", "current goal authority is required");
  }
  async #dispatch(goalId: string, runtime: Runtime, context: Context): Promise<void> {
    const record = await this.store.harness.snapshot(GoalDoc, goalId, context);
    const goal = requireSnapshot(record);
    if (record?.stop) return this.#stop(goalId, runtime, context);
    try { await this.#options.settled(goal, context); }
    catch (error) { context.abortSignal?.throwIfAborted(); this.#options.report(error); return this.#dependency(goalId, "original external operations still require reconciliation", runtime, context); }
    const conversation = await runtime.conversation(goal.conversationId as ConversationId, context);
    if (conversation === undefined) throw refusal("goal_binding", "goal conversation is missing");
    await runtime.commit(async (tx) => {
      const next = await tx.doc(GoalDoc, goalId, null);
      const snapshot = requireSnapshot(next);
      if (next.stop) return { status: "running", checkpoint: { phase: "dispatch" } };
      const input = next.pending[0];
      if (input === undefined) return { status: "running", checkpoint: { phase: "wait" } };
      const submission = await conversation.submit(tx, { type: "input", content: input.text, requestId: input.requestId,
        ...(input.origin === "driver" ? { entry: { kind: GOAL_CONTROL_KIND, data: { goalId } } } : {}) });
      next.pending.shift();
      snapshot.status = "running"; delete snapshot.waiting; bump(snapshot);
      return { status: "running", checkpoint: { phase: "run", submission: Number(submission) } };
    }, context);
  }
  async #run(goalId: string, submissionId: number, runtime: Runtime, context: Context): Promise<void> {
    const ctx = withAbortSignal(runtime.signal, context);
    const record = await this.store.harness.snapshot(GoalDoc, goalId, ctx);
    const goal = requireSnapshot(record);
    if (record?.stop) return this.#stop(goalId, runtime, ctx);
    const submission = await this.store.harness.submission(submissionId as import("@earendil-works/pi-durable").SubmissionId, ctx);
    const conversation = await this.store.harness.conversation(goal.conversationId as ConversationId, ctx);
    if (submission === undefined || conversation === undefined) throw refusal("goal_binding", "original execution record is missing");
    const settled = await submission.wait(ctx);
    await conversation.waitForIdle(ctx);
    await this.#owned(runtime.taskId, ctx);
    try { await this.#options.settled(await this.store.snapshot(goalId, ctx), ctx); }
    catch (error) { ctx.abortSignal?.throwIfAborted(); this.#options.report(error); return this.#dependency(goalId, "original external operations still require reconciliation", runtime, ctx, { phase: "run", submission: submissionId }); }
    const current = await this.store.harness.snapshot(GoalDoc, goalId, ctx);
    if (current?.stop) return this.#stop(goalId, runtime, ctx);
    if (current !== undefined && current.pending.length > 0) {
      return runtime.commit(() => ({ status: "running", checkpoint: { phase: "dispatch" } }), ctx);
    }
    const snapshot = requireSnapshot(current);
    if (settled.status !== "done") return this.#dependency(goalId, settled.reason ?? "submission did not settle successfully", runtime, ctx, { phase: "run", submission: submissionId });
    const answer = settled.type === "write" ? undefined : await this.store.storage.entry(settled.answer, ctx);
    const generation = answer?.entry.byTaskId;
    const audit = generation === undefined ? undefined : await this.store.harness.snapshot(RunAudit, `${goalId}:${generation}`, ctx);
    if (audit?.checked !== true || !audit.passed) return this.#dependency(goalId, "required post-run work is not verified", runtime, ctx, { phase: "run", submission: submissionId });
    let decision: GoalDecision;
    try {
      decision = typeof this.#options.review === "function"
        ? await this.#options.review({ reviewId: `${goalId}:${submissionId}`, goal: structuredClone(snapshot), submission: submissionId,
          entries: (limit, cursor) => conversation.entries({ order: "descending" }, limit, cursor, ctx) }, ctx)
        : await this.#reviewer!.review(snapshot, submissionId, runtime, ctx);
      await this.#validate(snapshot, decision, ctx);
    } catch (error) {
      ctx.abortSignal?.throwIfAborted();
      this.#options.report(error);
      return this.#dependency(goalId, "completion verification is unavailable", runtime, ctx, { phase: "run", submission: submissionId });
    }
    await runtime.commit(async (tx) => {
      const stored = await tx.doc(GoalDoc, goalId, null); const actual = requireSnapshot(stored);
      if (stored.stop || stored.pending.length > 0) return { status: "running", checkpoint: { phase: "dispatch" } };
      if (actual.conversationId !== snapshot.conversationId || actual.objective !== snapshot.objective
        || !isDeepStrictEqual(actual.completionCriteria, snapshot.completionCriteria) || !isDeepStrictEqual(actual.grant, snapshot.grant)) throw refusal("goal_binding", "original review input changed");
      if (decision.kind !== "wait" && decision.criteria !== undefined) actual.completionCriteria = [...decision.criteria];
      delete actual.waiting;
      if (decision.kind === "complete") {
        const active = await tx.doc(ActiveGoals);
        if (active.count < 1) throw new Error("goal activity projection is inconsistent");
        active.count--;
        actual.status = "completed"; actual.result = { summary: decision.summary, evidence: decision.evidence, verifiedAt: runtime.now() }; bump(actual);
        return { status: "terminal", outcome: { status: "completed", result: { goalId } } };
      }
      if (decision.kind === "continue") {
        actual.status = "running"; bump(actual);
        stored.pending.push({ requestId: `${goalId}:advance:${actual.version}`, text: decision.instruction, origin: "driver" });
        return { status: "running", checkpoint: { phase: "dispatch" } };
      }
      actual.status = decision.until === undefined ? "waiting_user" : "waiting_time";
      actual.waiting = { reason: decision.reason, ...(decision.until === undefined ? { questionId: `${goalId}:question:${submissionId}` } : { until: decision.until }) }; bump(actual);
      return { status: "running", checkpoint: { phase: "wait" } };
    }, ctx);
  }
  async #wait(goalId: string, resume: Extract<GoalCheckpoint, { phase: "wait" }>["resume"], runtime: Runtime, context: Context): Promise<void> {
    while (true) {
      const record = await this.store.harness.snapshot(GoalDoc, goalId, context); const snapshot = requireSnapshot(record);
      if (record?.stop) return this.#stop(goalId, runtime, context);
      if (record !== undefined && record.pending.length > 0 && (snapshot.status === "running" || snapshot.status === "accepted")) {
        return runtime.commit(() => ({ status: "running", checkpoint: { phase: "dispatch" } }), context);
      }
      if (snapshot.waiting?.until !== undefined && runtime.now() >= snapshot.waiting.until) {
        await runtime.commit(async (tx) => {
          const current = await tx.doc(GoalDoc, goalId, null); const goal = requireSnapshot(current);
          if (goal.version === snapshot.version) {
            goal.status = "running"; delete goal.waiting; bump(goal);
            if (resume === undefined && current.pending.length === 0) current.pending.push({ requestId: `${goalId}:wake:${goal.version}`, text: "Continue the original objective from its durable state and verify all completion criteria.", origin: "driver" });
          }
          return { status: "running", checkpoint: current.pending.length > 0 ? { phase: "dispatch" } : resume ?? { phase: "dispatch" } };
        }, context);
        return;
      }
      await this.#changed(goalId, snapshot.version, context, snapshot.waiting?.until);
    }
  }
  async #dependency(goalId: string, reason: string, runtime: Runtime, context: Context, resume: Extract<GoalCheckpoint, { phase: "wait" }>["resume"] = { phase: "dispatch" }): Promise<void> {
    await runtime.commit(async (tx) => {
      const record = await tx.doc(GoalDoc, goalId, null); const goal = requireSnapshot(record);
      if (record.stop) return { status: "running", checkpoint: { phase: "dispatch" } };
      goal.status = "waiting_dependency"; goal.waiting = { reason, until: runtime.now() + this.#options.retryAfterMs }; bump(goal);
      return { status: "running", checkpoint: { phase: "wait", resume } };
    }, context);
  }
  async #stop(goalId: string, runtime: Runtime, context: Context): Promise<void> {
    const goal = await this.store.snapshot(goalId, context);
    const conversation = await runtime.conversation(goal.conversationId as ConversationId, context);
    if (conversation === undefined) throw refusal("goal_binding", "original goal conversation is missing");
    await conversation.abort(context, { background: true });
    await this.#owned(runtime.taskId, context);
    while (true) {
      try { await this.#options.settled(await this.store.snapshot(goalId, context), context); break; }
      catch (error) {
        context.abortSignal?.throwIfAborted(); this.#options.report(error);
        let version = 0;
        let until = 0;
        await runtime.commit(async (tx) => {
          const record = await tx.doc(GoalDoc, goalId, null); const snapshot = requireSnapshot(record);
          record.stop = true; snapshot.status = "stopping"; until = runtime.now() + this.#options.retryAfterMs;
          snapshot.waiting = { reason: "original external operations still require reconciliation", until }; bump(snapshot); version = snapshot.version;
          return { status: "running", checkpoint: { phase: "wait" } };
        }, context);
        await this.#changed(goalId, version, context, until);
      }
    }
    await runtime.commit(async (tx) => {
      const record = await tx.doc(GoalDoc, goalId, null); const snapshot = requireSnapshot(record);
      if (!terminal(snapshot.status)) {
        const active = await tx.doc(ActiveGoals);
        if (active.count < 1) throw new Error("goal activity projection is inconsistent");
        active.count--;
      }
      record.stop = true; record.pending = []; record.blocks = {}; snapshot.status = "stopped"; delete snapshot.waiting; bump(snapshot);
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context);
  }
  async #evidence(goal: GoalSnapshot, evidence: GoalResult["evidence"], context: Context): Promise<void> {
    if (goal.completionCriteria.length === 0) throw new Error("completion has no established criteria");
    const covered = new Set<number>();
    for (const item of evidence) {
      if (item.criterion >= goal.completionCriteria.length) throw new Error("evidence names another criterion");
      const source = await this.store.storage.entry(item.entryId as EntryId, context);
      const entry = source?.entry;
      if (entry === undefined || await this.#goal(entry.conversationId, context) !== goal.goalId) throw new Error("evidence is not from this goal");
      const valid = item.kind === "assistant"
        ? entry.kind === AssistantEntry.kind && entry.model?.some((message) => message.role === "assistant" && message.stopReason === "stop" && message.content.some((part) => part.type === "text" && part.text.trim() !== ""))
        : entry.kind === ToolResultEntry.kind && entry.model?.some((message) => message.role === "toolResult" && !message.isError);
      if (!valid) throw new Error("evidence does not record a successful source result");
      if (item.kind === "tool") {
        const task = entry.byTaskId === undefined ? undefined : await this.store.storage.task(entry.byTaskId, context);
        if (task?.kind !== ToolTask.definition.name || task.state.status !== "terminal" || task.state.outcome.status !== "completed") throw new Error("tool evidence has no completed execution record");
        const result = task.state.outcome.result;
        if (result === null || typeof result !== "object" || Array.isArray(result) || result.entryId !== entry.id) throw new Error("tool evidence is not the committed task result");
        if (item.artifact !== undefined) {
          if (this.#options.artifact === undefined) throw new Error("artifact verification is unavailable");
          await this.#options.artifact(goal, item.artifact, context);
        }
      }
      covered.add(item.criterion);
    }
    if (covered.size !== goal.completionCriteria.length) throw new Error("not every criterion has source evidence");
  }
  async #validate(goal: GoalSnapshot, decision: GoalDecision, context: Context): Promise<void> {
    if (!Decision.check(decision)) throw new Error("goal verifier returned an invalid decision");
    const text = decision.kind === "complete" ? decision.summary : decision.kind === "continue" ? decision.instruction : decision.reason;
    if (text.trim() === "") throw new Error("goal decision must contain text");
    if (decision.kind !== "wait" && decision.criteria?.some((value) => value.trim() === "")) throw new Error("criteria must contain text");
    if (decision.kind !== "wait" && decision.criteria !== undefined && goal.completionCriteria.length !== 0 && !isDeepStrictEqual(decision.criteria, goal.completionCriteria)) throw new Error("goal verifier attempted to replace established criteria");
    if (decision.kind === "complete") await this.#evidence({ ...goal, completionCriteria: decision.criteria ?? goal.completionCriteria }, decision.evidence, context);
  }
  async #goal(conversationId: ConversationId, context: Context): Promise<string | undefined> {
    const visited = new Set<number>();
    let current: ConversationId | undefined = conversationId;
    while (current !== undefined) {
      if (visited.has(Number(current))) throw new Error("conversation ownership contains a cycle");
      visited.add(Number(current));
      const review = await this.store.harness.snapshot(ReviewBinding, current, context);
      if (review?.goalId != null) return review.goalId;
      const binding = await this.store.harness.snapshot(GoalBinding, current, context);
      if (binding?.goalId != null) return binding.goalId;
      current = (await this.store.storage.conversation(current, context))?.owner?.conversationId;
    }
    return undefined;
  }
  async #owned(driver: TaskId, context: Context): Promise<void> {
    while (true) {
      const graph = await this.store.harness.watchTaskGraph(context);
      const tasks = Object.values(graph.value.tasks);
      const owned = new Set<number>([Number(driver)]);
      const conversations = new Set<number>();
      let previous = -1;
      while (previous !== owned.size) {
        previous = owned.size;
        for (const task of tasks) {
          if (owned.has(Number(task.id))) for (const id of task.conversations) conversations.add(Number(id));
          if (task.owner !== undefined && owned.has(Number(task.owner)) || conversations.has(Number(task.conversationId))) owned.add(Number(task.id));
        }
      }
      await graph.stop();
      const pending = [...owned].filter((id) => id !== Number(driver));
      if (pending.length === 0) return;
      await Promise.all(pending.map((id) => this.store.harness.waitForTask(id as TaskId, context)));
    }
  }
  async #guard(api: Pick<HookApi, "conversationId" | "taskId">, action: "model" | "tool", context: Context, tool?: string): Promise<void> {
    try {
      const goalId = await this.#goal(api.conversationId, context);
      if (goalId === undefined) return;
      const key = String(api.taskId);
      while (true) {
        context.abortSignal?.throwIfAborted();
        const before = await this.store.harness.snapshot(GoalDoc, goalId, context); const goal = requireSnapshot(before);
        if (before?.stop || terminal(goal.status)) throw new Error("goal no longer admits execution");
        let block: GoalBlock | undefined;
        try {
          const result = await this.#options.authorize({ action, goalId, grant: goal.grant, ...(tool === undefined ? {} : { tool }) }, context);
          if (!result.allowed) block = { status: "waiting_authorization", reason: result.reason ?? "current execution authority is required" };
        } catch (error) {
          context.abortSignal?.throwIfAborted(); this.#options.report(error);
          block = { status: "waiting_dependency", reason: "execution authority is unavailable", until: Date.now() + this.#options.retryAfterMs };
        }
        const observed = await this.store.harness.commit(async (tx) => {
          const record = await tx.doc(GoalDoc, goalId, null); const snapshot = requireSnapshot(record);
          if (record.stop || terminal(snapshot.status) || !isDeepStrictEqual(snapshot.grant, goal.grant)) return { retry: true, version: snapshot.version };
          setBlock(record, key, block);
          return { retry: false, version: snapshot.version };
        }, context);
        if (observed.retry) continue;
        if (block === undefined) return;
        await this.#changed(goalId, observed.version, context, block.until);
      }
    } catch (error) {
      context.abortSignal?.throwIfAborted();
      this.#abort(api.taskId);
      // Hooks suppress ordinary errors; wait for the invocation's abort before propagating a failure.
      await new Promise<void>((_resolve, reject) => {
        const signal = context.abortSignal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      throw error;
    }
  }
  async #changed(goalId: string, version: number, context: Context, until?: number): Promise<void> {
    const watch = await this.store.harness.watchDoc(GoalDoc, goalId, context);
    if (watch === undefined) throw refusal("unknown_goal", "goal disappeared while waiting");
    let timer: NodeJS.Timeout | undefined;
    try {
      if (watch.value.snapshot?.version !== version) return;
      await new Promise<void>((resolve, reject) => {
        watch.start(async (change) => { if (change.kind === "failed") reject(change.error); else if (change.value.snapshot?.version !== version) resolve(); });
        void watch.closed.then((end) => reject(end.kind === "failed" ? end.error : context.abortSignal?.reason ?? new Error("goal observation ended")));
        // Node timers use a signed 32-bit delay; the absolute persisted deadline is rechecked after each chunk.
        if (until !== undefined) timer = setTimeout(resolve, Math.min(Math.max(0, until - Date.now()), 2_147_483_647));
      });
    } finally { clearTimeout(timer); await watch.stop(); }
  }
}
