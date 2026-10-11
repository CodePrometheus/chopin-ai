/**
 * The orchestrator: it claims tasks, runs bounded rounds of fresh workers, gates and delivers
 * their work, and follows it onto the trunk. It is deterministic and never calls a model;
 * workers and commands come in through ports, so the same engine runs under the host and
 * under tests. Every decision is read back from the log, so a restart resumes where it was.
 *
 * @module @chopin/team/engine
 */

import { watch } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { REPORT_TOOL, workerBrief } from "./brief.js";
import type { TeamConfig } from "./config.js";
import { teamEvent } from "./events.js";
import { authoredChecks, checkCommands, completionRefusal, listed } from "./gates.js";
import type { CheckRun, GateContext, Refusal } from "./gates.js";
import * as git from "./git.js";
import { assign } from "./scheduler.js";
import type { Assignment } from "./scheduler.js";
import type { TeamEventStore } from "./store.js";
import type {
  BatchProjection, ModelRoute, PauseReason, RoundReport, RoundUsage, TaskProjection, TeamActor, TeamEvent, TeamProjection,
} from "./types.js";

/** What the worker's own tools may ask the host while the round runs. */
export interface RoundGate {
  /** The check commands the slot's changes select right now. */
  checkCommands(): Promise<string[]>;
  /** Why a `complete` report would be refused now; the host asks the same question again before delivering. */
  refusal(report: RoundReport, passingCheck?: CheckRun): Promise<Refusal | undefined>;
}

export interface WorkerRound {
  taskId: string;
  attemptId: string;
  round: number;
  sessionId: string;
  /** The slot the worker runs in; its only writable root. */
  cwd: string;
  prompt: string;
  model?: ModelRoute;
  /** Model requests this round may make before it is cut off. */
  requestLimit: number;
  gate: RoundGate;
  signal: AbortSignal;
}

export interface WorkerOutcome {
  /** The report the worker submitted; absent when it never did. */
  report?: RoundReport;
  usage: RoundUsage;
  /** The round was cut off at its request limit. */
  exhausted: boolean;
  /** Tools whose approval was refused because nobody is there to ask. */
  deniedApprovals: string[];
  passingCheck?: CheckRun;
  failure?: string;
}

export interface WorkerPort {
  runRound(round: WorkerRound): Promise<WorkerOutcome>;
  /** What a round left in its persisted session when the host died during it. */
  salvage(sessionId: string): Promise<Pick<WorkerOutcome, "report" | "usage">>;
}

export interface CommandResult {
  exitCode: number | null;
  output: string;
}

export interface CommandPort {
  /** Run a configured command; with `writableRoot` it may write only there, without it nothing. */
  run(command: string, options: { cwd: string; writableRoot?: string; signal: AbortSignal }): Promise<CommandResult>;
}

export interface EngineOptions {
  config: TeamConfig;
  store: TeamEventStore;
  worker: WorkerPort;
  commands: CommandPort;
  hostId: string;
  onAttention?: (task: TaskProjection) => void;
  onError?: (error: unknown) => void;
  now?: () => number;
}

type StopReason = "cancelled" | "replanned";

interface LiveRun {
  controller: AbortController;
  stop?: { reason: StopReason; detail: string };
  done?: Promise<void>;
}

const NO_USAGE: RoundUsage = { requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
const OUTPUT_TAIL = 1_500;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tail(text: string): string {
  return text.length <= OUTPUT_TAIL ? text : `...${text.slice(-OUTPUT_TAIL)}`;
}

function missingReport(cause: string): RoundReport {
  return { status: "continue", summary: `No report: ${cause}. Treat the working tree as authoritative.`, evidence: [], nextSteps: [] };
}

export class TeamEngine {
  private readonly host: TeamActor;
  private readonly ref: git.TrunkRef;
  private readonly now: () => number;
  private readonly live = new Map<string, LiveRun>();
  /** Every run in flight, task rounds and batch checks alike, so closing can stop them all. */
  private readonly runs = new Set<LiveRun>();
  /** Slots lent to a batch check; the scheduler leaves them alone. */
  private readonly reserved = new Set<string>();
  private readonly checking = new Set<string>();
  /** Batches whose check could not run in this process without a person cleaning a slot. */
  private readonly stalled = new Set<string>();
  private readonly running = new Set<Promise<void>>();
  /** Deliveries go one at a time, so parallel tasks never push each other off the trunk. */
  private delivering: Promise<unknown> = Promise.resolve();
  private pumping: Promise<void> | undefined;
  private again = false;
  private pollDue = true;
  private lastPoll = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private nudge: ReturnType<typeof setTimeout> | undefined;
  /** Stops following the log; other processes append to it, and this engine acts on what they add. */
  private readonly watching = new AbortController();
  private closed = false;

  constructor(private readonly options: EngineOptions) {
    this.host = { kind: "host", id: options.hostId };
    this.ref = { remote: options.config.remote, trunk: options.config.trunk };
    this.now = options.now ?? Date.now;
  }

  /** Settle what a previous process left running, then start scheduling. */
  async start(): Promise<void> {
    await this.recover();
    this.timer = setInterval(() => void this.pump(true), this.options.config.pollSeconds * 1_000);
    this.timer.unref?.();
    void this.followLog();
    await this.pump(true);
  }

  private async followLog(): Promise<void> {
    const file = basename(this.options.store.path);
    try {
      for await (const change of watch(dirname(this.options.store.path), { signal: this.watching.signal })) {
        if (change.filename !== file || this.nudge !== undefined) continue;
        this.nudge = setTimeout(() => {
          this.nudge = undefined;
          void this.pump();
        }, 200);
      }
    } catch (error) {
      if (!this.watching.signal.aborted) this.options.onError?.(error);
    }
  }

  /** Stop every live round, keeping its work on its branch, and wait for them to settle. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.nudge !== undefined) clearTimeout(this.nudge);
    this.watching.abort();
    for (const run of this.runs) run.controller.abort();
    await Promise.allSettled([...this.running]);
    await this.pumping;
  }

  /** Stop a running task and wait until its work is saved on its branch; false when it was not running here. */
  async stopTask(taskId: string, reason: StopReason, detail: string): Promise<boolean> {
    const run = this.live.get(taskId);
    if (run === undefined) return false;
    run.stop = { reason, detail };
    run.controller.abort();
    await run.done;
    return true;
  }

  /** Whether the engine is busy with any round, batch check or scheduling pass. */
  get idle(): boolean {
    return this.running.size === 0 && this.pumping === undefined;
  }

  /** Wait until nothing runs; for tests and orderly shutdown. */
  async settled(): Promise<void> {
    while (!this.idle) await Promise.allSettled([...this.running, ...(this.pumping === undefined ? [] : [this.pumping])]);
  }

  /** One scheduling pass now; `poll` also looks at landings, stages and batch checks. */
  pump(poll = false): Promise<void> {
    if (poll) this.pollDue = true;
    if (this.pumping !== undefined) {
      this.again = true;
      return this.pumping;
    }
    this.pumping = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && !this.closed);
      } catch (error) {
        this.options.onError?.(error);
      } finally {
        this.pumping = undefined;
      }
    })();
    return this.pumping;
  }

  private async append(event: TeamEvent): Promise<void> {
    await this.options.store.append(event);
    if (event.type === "task.paused" && event.data.reason !== "interrupted" && event.data.reason !== "cancelled") {
      const task = (await this.options.store.fold()).tasks[event.data.taskId];
      if (task !== undefined) this.options.onAttention?.(task);
    }
  }

  private slotPath(name: string): string | undefined {
    return this.options.config.slots.find((slot) => slot.name === name)?.path;
  }

  private async pass(): Promise<void> {
    if (this.closed) return;
    const projection = await this.options.store.fold();
    const slots = this.options.config.slots.map((slot) => slot.name).filter((name) => !this.reserved.has(name));
    for (const assignment of assign(projection, slots)) {
      await this.append(teamEvent("task.claimed", this.host, assignment));
      this.track(this.runTask(assignment), assignment.taskId);
    }
    if (this.pollDue || this.now() - this.lastPoll >= this.options.config.pollSeconds * 1_000) {
      this.pollDue = false;
      this.lastPoll = this.now();
      await this.poll(await this.options.store.fold());
    }
  }

  private track(work: (signal: LiveRun) => Promise<void>, taskId?: string): void {
    const run: LiveRun = { controller: new AbortController() };
    if (taskId !== undefined) this.live.set(taskId, run);
    this.runs.add(run);
    const promise = work(run).catch((error) => this.options.onError?.(error)).finally(() => {
      if (taskId !== undefined && this.live.get(taskId) === run) this.live.delete(taskId);
      this.runs.delete(run);
      this.running.delete(promise);
      if (!this.closed) void this.pump();
    });
    run.done = promise;
    this.running.add(promise);
  }

  // ---- one task, round by round -------------------------------------------------------

  private runTask(assignment: Assignment): (run: LiveRun) => Promise<void> {
    return async (run) => {
      const slot = this.slotPath(assignment.slot)!;
      try {
        await git.prepareSlot(slot, assignment.branch, this.ref);
      } catch (error) {
        if (error instanceof git.SlotDirtyError) {
          await this.append(teamEvent("task.paused", this.host, { ...this.ids(assignment), reason: "interrupted", detail: `slot ${assignment.slot} was not clean` }));
          await this.append(teamEvent("slot.dirty", this.host, { slot: assignment.slot, detail: error.message }));
          return;
        }
        await this.append(teamEvent("task.paused", this.host, { ...this.ids(assignment), reason: "blocked", detail: `the host could not prepare ${assignment.slot}: ${message(error)}` }));
        return;
      }
      try {
        await this.rounds(assignment, slot, run);
      } catch (error) {
        // Whatever broke, the task must not stay running with nobody driving it.
        if ((await this.options.store.fold()).tasks[assignment.taskId]?.status !== "running") throw error;
        await this.park(assignment, slot, "blocked", `the host failed: ${message(error)}`);
        this.options.onError?.(error);
      }
    };
  }

  private async rounds(assignment: Assignment, slot: string, run: LiveRun): Promise<void> {
    const initial = (await this.options.store.fold()).tasks[assignment.taskId]!;
    const byCommit = new Map<string, string[]>();
    for (const check of initial.checks) byCommit.set(check.commit, [...(byCommit.get(check.commit) ?? []), check.path]);
    for (const [commit, paths] of byCommit) await git.restoreFiles(slot, commit, paths);

    for (;;) {
      const projection = await this.options.store.fold();
      const task = projection.tasks[assignment.taskId]!;
      if (run.controller.signal.aborted) return this.interrupt(assignment, slot, run);
      if (task.rounds >= task.spec.maxRounds) return this.park(assignment, slot, "round-budget", `used all ${task.spec.maxRounds} rounds`);
      const left = task.spec.maxRequests - task.usage.requests;
      if (left <= 0) return this.park(assignment, slot, "request-budget", `used ${task.usage.requests} of ${task.spec.maxRequests} model requests`);
      const round = task.attempt!.round + 1;
      const sessionId = `team-${assignment.attemptId}-r${round}`;
      await this.append(teamEvent("task.round-started", this.host, { ...this.ids(assignment), round, sessionId }));
      let outcome: WorkerOutcome;
      try {
        const gate = this.gate(slot, projection, task);
        outcome = await this.options.worker.runRound({
          ...this.ids(assignment), round, sessionId, cwd: slot, prompt: workerBrief(projection, task, left),
          ...(task.spec.model === undefined ? {} : { model: task.spec.model }), requestLimit: left, signal: run.controller.signal,
          gate: { checkCommands: () => checkCommands(gate), refusal: (report, check) => completionRefusal(gate, report, check) },
        });
      } catch (error) {
        outcome = { usage: NO_USAGE, exhausted: false, deniedApprovals: [], failure: message(error) };
      }
      const report = outcome.report ?? missingReport(run.controller.signal.aborted ? "the host stopped the round"
        : outcome.failure !== undefined ? `the round failed (${outcome.failure.slice(0, 300)})`
          : outcome.exhausted ? "the round ran out of model requests" : `the round ended without calling ${REPORT_TOOL}`);
      await this.append(teamEvent("task.round-reported", this.host, { ...this.ids(assignment), round, report, usage: outcome.usage }));
      if (run.controller.signal.aborted) return this.interrupt(assignment, slot, run);
      if (outcome.report?.status === "complete") return this.finish(assignment, slot, outcome);
      if (report.status === "blocked" || report.status === "needs-decision") return this.park(assignment, slot, report.status, report.blocker!);
      if (outcome.failure !== undefined && outcome.report === undefined) return this.park(assignment, slot, "blocked", `the worker failed: ${outcome.failure}`);
      if (outcome.exhausted) return this.park(assignment, slot, "request-budget", `the round used the last of ${task.spec.maxRequests} model requests`);
      if (outcome.deniedApprovals.length > 0) {
        return this.park(assignment, slot, "approval", `refused without asking anyone: ${listed([...new Set(outcome.deniedApprovals)])}`);
      }
    }
  }

  private gate(slot: string, projection: TeamProjection, task: TaskProjection): GateContext {
    return { config: this.options.config, ref: this.ref, slot, projection, task };
  }

  private ids(assignment: Pick<Assignment, "taskId" | "attemptId">): { taskId: string; attemptId: string } {
    return { taskId: assignment.taskId, attemptId: assignment.attemptId };
  }

  /** Keep the task's work on its branch, free the slot, and hold the task for a person. */
  private async park(assignment: Assignment, slot: string | undefined, reason: PauseReason, detail: string): Promise<void> {
    let savedCommit: string | undefined;
    let failure: string | undefined;
    if (slot !== undefined) {
      try {
        savedCommit = await git.saveWork(slot, assignment.branch, `wip(${assignment.taskId}): ${reason}`, this.ref);
      } catch (error) {
        failure = message(error);
      }
    }
    await this.append(teamEvent("task.paused", this.host, {
      ...this.ids(assignment), reason, detail: failure === undefined ? detail : `${detail}; the work could not be saved: ${failure}`,
      ...(savedCommit === undefined ? {} : { savedCommit }),
    }));
    if (failure !== undefined) await this.append(teamEvent("slot.dirty", this.host, { slot: assignment.slot, detail: failure }));
  }

  private interrupt(assignment: Assignment, slot: string, run: LiveRun): Promise<void> {
    return this.park(assignment, slot, run.stop?.reason ?? "interrupted", run.stop?.detail ?? "the host stopped");
  }

  private async finish(assignment: Assignment, slot: string, outcome: WorkerOutcome): Promise<void> {
    const projection = await this.options.store.fold();
    const task = projection.tasks[assignment.taskId]!;
    const gate = this.gate(slot, projection, task);
    const refusal = await completionRefusal(gate, outcome.report!, outcome.passingCheck);
    if (refusal !== undefined) return this.park(assignment, slot, refusal.reason, refusal.detail);
    switch (task.spec.kind) {
      case "read-only":
        await git.releaseSlot(slot, this.ref);
        await this.append(teamEvent("task.completed", this.host, this.ids(assignment)));
        return;
      case "acceptance": {
        const checks = await authoredChecks(gate, outcome.report!);
        const commit = await git.saveWork(slot, assignment.branch, `test(${task.spec.id}): acceptance checks`, this.ref);
        await this.append(teamEvent("task.checks-authored", this.host, { ...this.ids(assignment), commit, checks }));
        return;
      }
      case "change":
        return this.deliver(assignment, slot, task);
    }
  }

  private async deliver(assignment: Assignment, slot: string, task: TaskProjection): Promise<void> {
    const commitMessage = task.spec.commitMessage!;
    const attempt = () => git.deliver(slot, assignment.branch, commitMessage, this.options.config.delivery, this.ref);
    const delivery = this.delivering.then(async () => {
      const first = await attempt();
      return first.kind === "rejected" && first.detail.startsWith("git push") ? attempt() : first;
    });
    this.delivering = delivery.catch(() => undefined);
    const result = await delivery;
    switch (result.kind) {
      case "conflict":
        return this.park(assignment, slot, "rebase-conflict", result.detail);
      case "rejected":
        return this.park(assignment, slot, result.detail.startsWith("commit hook") ? "check-failed" : "blocked", result.detail);
      case "delivered": {
        await git.releaseSlot(slot, this.ref);
        await this.append(teamEvent("task.delivered", this.host, { ...this.ids(assignment), commit: result.commit, mode: this.options.config.delivery }));
        if (this.options.config.delivery === "push") await this.followLanding(task.spec.id, result.commit);
      }
    }
  }

  // ---- after delivery -------------------------------------------------------------------

  private async followLanding(taskId: string, commit: string): Promise<void> {
    const landed = await git.landedAs(this.options.config.root, commit, this.ref, this.options.config.delivery === "local");
    if (landed !== undefined) await this.append(teamEvent("task.landed", this.host, { taskId, commit: landed }));
  }

  private async poll(projection: TeamProjection): Promise<void> {
    for (const task of Object.values(projection.tasks)) {
      try {
        if (task.status === "delivered") await this.followLanding(task.spec.id, task.delivered!.commit);
        else if (task.status === "landed") await this.verifyStages(task);
      } catch (error) {
        this.options.onError?.(error);
      }
    }
    for (const batch of Object.values(projection.batches)) {
      if (this.options.config.fullCheck.where === "local" && this.needsCheck(projection, batch)) this.checkBatch(projection, batch);
    }
  }

  private async verifyStages(task: TaskProjection): Promise<void> {
    const stage = task.spec.stages.map((name) => this.options.config.stages.find((entry) => entry.name === name))
      .find((entry) => entry !== undefined && task.stages[entry.name]?.passed !== true);
    if (stage?.verify === undefined) return;
    const result = await this.options.commands.run(stage.verify.replaceAll("{commit}", task.landedCommit!), {
      cwd: this.options.config.root, signal: AbortSignal.timeout(10 * 60_000),
    });
    const evidence = tail(result.output.trim() || `exit ${String(result.exitCode)}`);
    if (result.exitCode === 0) {
      await this.append(teamEvent("task.stage-passed", this.host, { taskId: task.spec.id, stage: stage.name, evidence }));
    } else if (this.now() - Date.parse(task.landedAt!) > stage.timeoutMinutes * 60_000) {
      await this.append(teamEvent("task.stage-failed", this.host, { taskId: task.spec.id, stage: stage.name, evidence }));
    }
  }

  /** A batch is checked once all its changes are on the trunk, and again once a culprit lands a fix. */
  private needsCheck(projection: TeamProjection, batch: BatchProjection): boolean {
    if (batch.status !== "approved" || this.checking.has(batch.id) || this.stalled.has(batch.id)) return false;
    const changes = batch.taskIds.map((id) => projection.tasks[id]!).filter((task) => task.spec.kind === "change");
    const landed = changes.filter((task) => task.status === "landed" || task.status === "done");
    if (landed.length === 0 || landed.length + changes.filter((task) => task.status === "cancelled").length !== changes.length) return false;
    if (batch.check === undefined) return true;
    if (batch.check.passed || batch.check.culpritTaskId === undefined) return false;
    return projection.tasks[batch.check.culpritTaskId]!.landedCommit !== batch.check.culpritCommit;
  }

  private checkBatch(projection: TeamProjection, batch: BatchProjection): void {
    const name = this.options.config.slots.map((slot) => slot.name)
      .find((slot) => !this.reserved.has(slot) && projection.slots[slot]?.taskId === undefined && projection.slots[slot]?.dirty === undefined);
    if (name === undefined) return;
    this.reserved.add(name);
    this.checking.add(batch.id);
    this.track(async (run) => {
      try {
        await this.bisectBatch(batch, projection, name, run.controller.signal);
      } finally {
        this.reserved.delete(name);
        this.checking.delete(batch.id);
      }
    });
  }

  private async bisectBatch(batch: BatchProjection, projection: TeamProjection, name: string, signal: AbortSignal): Promise<void> {
    const slot = this.slotPath(name)!;
    const { run } = this.options.config.fullCheck as { run: string };
    let dirty: string | undefined;
    const passesAt = async (commit: string | "trunk"): Promise<{ passed: boolean; output: string }> => {
      await git.detachAt(slot, commit, this.ref);
      const result = await this.options.commands.run(run, { cwd: slot, writableRoot: slot, signal });
      const left = await git.dirtyEntries(slot);
      if (left.length > 0) {
        dirty = `the full check left files behind: ${listed(left)}`;
        throw new Error(dirty);
      }
      return { passed: result.exitCode === 0, output: tail(result.output) };
    };
    try {
      const head = await passesAt("trunk");
      if (head.passed) {
        await this.append(teamEvent("batch.checked", this.host, { batchId: batch.id, passed: true, detail: `${run} passed on the trunk` }));
        return;
      }
      const landed = batch.taskIds.map((id) => projection.tasks[id]!).filter((task) => task.landedCommit !== undefined);
      const counts = await Promise.all(landed.map((task) => git.ancestorCount(slot, task.landedCommit!)));
      const ordered = landed.map((task, index) => ({ task, count: counts[index]! })).sort((a, b) => a.count - b.count).map((entry) => entry.task);
      const base = await git.parentOf(slot, ordered[0]!.landedCommit!);
      if (!(await passesAt(base)).passed) {
        await this.append(teamEvent("batch.checked", this.host, { batchId: batch.id, passed: false, detail: `${run} already failed before this batch: ${head.output}` }));
        return;
      }
      if ((await passesAt(ordered.at(-1)!.landedCommit!)).passed) {
        await this.append(teamEvent("batch.checked", this.host, { batchId: batch.id, passed: false, detail: `${run} fails only after this batch's last commit: ${head.output}` }));
        return;
      }
      let low = 0;
      let high = ordered.length - 1;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if ((await passesAt(ordered[middle]!.landedCommit!)).passed) low = middle + 1;
        else high = middle;
      }
      const culprit = ordered[low]!;
      await this.append(teamEvent("batch.checked", this.host, {
        batchId: batch.id, passed: false, culpritTaskId: culprit.spec.id,
        detail: `${run} first fails at ${culprit.landedCommit!.slice(0, 12)} from ${culprit.spec.id}: ${head.output}`,
      }));
    } catch (error) {
      this.stalled.add(batch.id);
      if (dirty !== undefined) await this.append(teamEvent("slot.dirty", this.host, { slot: name, detail: dirty }));
      else throw error;
    } finally {
      if (dirty === undefined) await git.detachAt(slot, "trunk", this.ref).catch((error) => this.options.onError?.(error));
    }
  }

  // ---- restart ----------------------------------------------------------------------------

  /** Close out rounds a dead process left open: count what they spent, keep their work, requeue them. */
  private async recover(): Promise<void> {
    const projection = await this.options.store.fold();
    for (const task of Object.values(projection.tasks)) {
      if (task.status !== "running" || task.attempt === undefined) continue;
      const attempt = task.attempt;
      const assignment: Assignment = { taskId: task.spec.id, attemptId: attempt.id, slot: attempt.slot, branch: attempt.branch };
      if (attempt.round > attempt.reportedRound && attempt.sessionId !== undefined) {
        const salvaged = await this.options.worker.salvage(attempt.sessionId).catch(() => ({ usage: NO_USAGE }));
        await this.append(teamEvent("task.round-reported", this.host, {
          ...this.ids(assignment), round: attempt.round, usage: salvaged.usage,
          report: "report" in salvaged && salvaged.report !== undefined ? salvaged.report : missingReport("the host stopped during the round"),
        }));
      }
      await this.park(assignment, this.slotPath(attempt.slot), "interrupted", "the host restarted during the task");
    }
  }
}
