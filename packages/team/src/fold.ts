/**
 * Replay the team log into its projection. Every rule that needs history is enforced here,
 * so an event that breaks one is rejected before any byte lands: the journal folds the
 * history plus the new events before every append.
 *
 * @module @chopin/team/fold
 */

import type {
  PauseReason,
  RoundUsage,
  TaskProjection,
  TaskStatus,
  TeamEvent,
  TeamProjection,
} from "./types.js";

export class TeamFoldError extends Error {
  constructor(event: TeamEvent, message: string) {
    super(`${event.type} ${event.eventId}: ${message}`);
    this.name = "TeamFoldError";
  }
}

/** A dependency is satisfied once its work is on the trunk, or its report is accepted for read-only work. */
const FINISHED: ReadonlySet<TaskStatus> = new Set(["landed", "done"]);
const CANCELLABLE: ReadonlySet<TaskStatus> = new Set(["proposed", "queued", "attention"]);

function emptyUsage(): RoundUsage {
  return { requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
}

function addUsage(total: RoundUsage, usage: RoundUsage): void {
  total.requests += usage.requests;
  total.inputTokens += usage.inputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheWriteTokens += usage.cacheWriteTokens;
  total.outputTokens += usage.outputTokens;
}

/** Whether every configured stage passed and, when required, a person accepted the result. */
function settled(task: TaskProjection): boolean {
  return task.spec.stages.every((stage) => task.stages[stage]?.passed === true)
    && (!task.spec.manualAcceptance || task.accepted);
}

/** Tasks that may be claimed now: approved, not running, every dependency finished. */
export function claimableTasks(projection: TeamProjection): TaskProjection[] {
  return Object.values(projection.tasks).filter((task) => task.status === "queued"
    && task.spec.dependsOn.every((id) => FINISHED.has(projection.tasks[id]!.status)));
}

export function foldTeamEvents(events: readonly TeamEvent[]): TeamProjection {
  const projection: TeamProjection = { batches: {}, tasks: {}, slots: {}, eventCount: 0 };
  for (const event of events) {
    apply(projection, event);
    projection.eventCount += 1;
  }
  return projection;
}

function apply(projection: TeamProjection, event: TeamEvent): void {
  const reject = (message: string): never => { throw new TeamFoldError(event, message); };
  const task = (id: string): TaskProjection => projection.tasks[id] ?? reject(`unknown task ${id}`);
  const running = (id: string, attemptId: string): TaskProjection => {
    const current = task(id);
    if (current.status !== "running" || current.attempt === undefined) reject(`task ${id} is not running`);
    if (current.attempt!.id !== attemptId) reject(`attempt ${attemptId} is not the current attempt of ${id}`);
    return current;
  };
  const release = (current: TaskProjection): void => {
    if (current.attempt !== undefined) delete projection.slots[current.attempt.slot]?.taskId;
    delete current.attempt;
  };
  const pause = (current: TaskProjection, reason: PauseReason, detail: string, savedCommit?: string): void => {
    current.status = "attention";
    current.attention = { reason, detail, ...(savedCommit === undefined ? {} : { savedCommit }) };
  };

  switch (event.type) {
    case "batch.proposed": {
      const { batchId, tasks } = event.data;
      if (projection.batches[batchId] !== undefined) reject(`batch ${batchId} already exists`);
      const ids = new Set<string>();
      for (const spec of tasks) {
        if (projection.tasks[spec.id] !== undefined || ids.has(spec.id)) reject(`task ${spec.id} already exists`);
        ids.add(spec.id);
      }
      for (const spec of tasks) {
        for (const dependency of spec.dependsOn) {
          if (dependency === spec.id) reject(`task ${spec.id} depends on itself`);
          if (!ids.has(dependency) && projection.tasks[dependency] === undefined) reject(`task ${spec.id} depends on unknown ${dependency}`);
        }
      }
      // Dependencies on earlier batches cannot close a cycle; only this batch's own edges can.
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const byId = new Map(tasks.map((spec) => [spec.id, spec]));
      const visit = (id: string): void => {
        if (visited.has(id)) return;
        if (visiting.has(id)) reject(`dependency cycle through ${id}`);
        visiting.add(id);
        for (const dependency of byId.get(id)?.dependsOn ?? []) if (byId.has(dependency)) visit(dependency);
        visiting.delete(id);
        visited.add(id);
      };
      for (const spec of tasks) visit(spec.id);
      projection.batches[batchId] = {
        id: batchId, status: "proposed", proposedBy: event.data.proposedBy, taskIds: tasks.map((spec) => spec.id),
        maxRequests: tasks.reduce((sum, spec) => sum + spec.maxRequests, 0),
      };
      for (const spec of tasks) {
        // Acceptance checks are written before approval: the person approves the batch with them in hand.
        projection.tasks[spec.id] = {
          spec: structuredClone(spec), batchId, status: spec.kind === "acceptance" ? "queued" : "proposed", attemptIds: [], rounds: 0,
          usage: emptyUsage(), decisions: [], stages: {}, accepted: false, checks: [],
        };
      }
      return;
    }
    case "batch.approved":
    case "batch.rejected": {
      const batch = projection.batches[event.data.batchId] ?? reject(`unknown batch ${event.data.batchId}`);
      if (batch.status !== "proposed") reject(`batch ${batch.id} is already ${batch.status}`);
      const members = batch.taskIds.map(task);
      const authoring = members.filter((member) => member.spec.kind === "acceptance");
      const ids = (list: TaskProjection[]): string => list.map((member) => member.spec.id).join(", ");
      if (event.type === "batch.approved") {
        const pending = authoring.filter((member) => member.status !== "done" && member.status !== "cancelled");
        if (pending.length > 0) reject(`acceptance checks are not written yet: ${ids(pending)}`);
        const ungated = members.filter((member) => member.spec.kind === "change" && member.checks.length === 0 && !member.spec.manualAcceptance);
        if (ungated.length > 0) reject(`no acceptance check or manual acceptance gates ${ids(ungated)}`);
      } else {
        const active = authoring.filter((member) => member.status === "running");
        if (active.length > 0) reject(`pause ${ids(active)} before rejecting the batch`);
      }
      batch.status = event.type === "batch.approved" ? "approved" : "rejected";
      for (const member of members) {
        if (member.status === "done" || member.status === "cancelled") continue;
        member.status = event.type === "batch.approved" ? "queued" : "rejected";
        delete member.attention;
      }
      return;
    }
    case "task.claimed": {
      const { taskId, attemptId, slot, branch } = event.data;
      const current = task(taskId);
      if (current.status !== "queued") reject(`task ${taskId} is ${current.status}, not queued`);
      const waiting = current.spec.dependsOn.filter((id) => !FINISHED.has(task(id).status));
      if (waiting.length > 0) reject(`task ${taskId} still waits for ${waiting.join(", ")}`);
      if (current.attemptIds.includes(attemptId)) reject(`attempt ${attemptId} was already used`);
      const occupant = projection.slots[slot];
      if (occupant?.taskId !== undefined) reject(`slot ${slot} is held by ${occupant.taskId}`);
      if (occupant?.dirty !== undefined) reject(`slot ${slot} is dirty`);
      projection.slots[slot] = { taskId };
      current.attemptIds.push(attemptId);
      current.attempt = { id: attemptId, slot, branch, round: 0, reportedRound: 0 };
      current.branch = branch;
      current.status = "running";
      return;
    }
    case "task.round-started": {
      const current = running(event.data.taskId, event.data.attemptId);
      if (event.data.round !== current.attempt!.round + 1) reject(`round ${event.data.round} does not follow ${current.attempt!.round}`);
      if (current.attempt!.reportedRound !== current.attempt!.round) reject(`round ${current.attempt!.round} has not reported yet`);
      if (current.rounds >= current.spec.maxRounds) reject(`task ${current.spec.id} has used all ${current.spec.maxRounds} rounds`);
      current.attempt!.round = event.data.round;
      current.attempt!.sessionId = event.data.sessionId;
      current.rounds += 1;
      return;
    }
    case "task.round-reported": {
      const current = running(event.data.taskId, event.data.attemptId);
      if (event.data.round !== current.attempt!.round || event.data.round === current.attempt!.reportedRound) {
        reject(`no running round ${event.data.round} awaits a report`);
      }
      current.attempt!.reportedRound = event.data.round;
      current.attempt!.lastReport = structuredClone(event.data.report);
      current.lastReport = { round: current.rounds, report: structuredClone(event.data.report) };
      addUsage(current.usage, event.data.usage);
      return;
    }
    case "task.paused": {
      const { taskId, attemptId, reason, detail, savedCommit } = event.data;
      const current = running(taskId, attemptId);
      release(current);
      if (reason === "interrupted") current.status = "queued";
      else if (reason === "cancelled") current.status = "cancelled";
      else pause(current, reason, detail, savedCommit);
      return;
    }
    case "decision.recorded": {
      const current = task(event.data.taskId);
      if (current.status !== "attention") reject(`task ${current.spec.id} is not waiting for a decision`);
      current.decisions.push(event.data.decision);
      delete current.attention;
      current.status = "queued";
      return;
    }
    case "task.delivered": {
      const current = running(event.data.taskId, event.data.attemptId);
      if (current.spec.kind !== "change") reject(`a ${current.spec.kind} task delivers no commit to the trunk`);
      if (current.attempt!.lastReport?.status !== "complete") reject("the last report did not say complete");
      release(current);
      current.status = "delivered";
      current.delivered = { commit: event.data.commit, mode: event.data.mode };
      return;
    }
    case "task.landed": {
      const current = task(event.data.taskId);
      if (current.status !== "delivered") reject(`task ${current.spec.id} is ${current.status}, not delivered`);
      current.status = "landed";
      current.landedCommit = event.data.commit;
      current.landedAt = event.occurredAt;
      if (settled(current)) current.status = "done";
      return;
    }
    case "task.completed": {
      const current = running(event.data.taskId, event.data.attemptId);
      if (current.spec.kind !== "read-only") reject("only a read-only task completes without landing");
      if (current.attempt!.lastReport?.status !== "complete") reject("the last report did not say complete");
      release(current);
      current.status = "done";
      return;
    }
    case "task.checks-authored": {
      const current = running(event.data.taskId, event.data.attemptId);
      if (current.spec.kind !== "acceptance") reject("only an acceptance task authors checks");
      if (current.attempt!.lastReport?.status !== "complete") reject("the last report did not say complete");
      const byTask = new Map<string, TaskProjection["checks"]>();
      for (const check of event.data.checks) {
        const target = task(check.forTaskId);
        if (target.batchId !== current.batchId) reject(`task ${check.forTaskId} is not in batch ${current.batchId}`);
        if (target.spec.kind !== "change") reject(`task ${check.forTaskId} lands no change for a check to gate`);
        if (target.status !== "proposed") reject(`task ${check.forTaskId} has already started`);
        const list = byTask.get(check.forTaskId) ?? [];
        if (list.some((entry) => entry.path === check.path)) reject(`check ${check.path} is listed twice for ${check.forTaskId}`);
        list.push({ commit: event.data.commit, path: check.path, sha256: check.sha256 });
        byTask.set(check.forTaskId, list);
      }
      for (const [id, checks] of byTask) task(id).checks = checks;
      release(current);
      current.status = "done";
      return;
    }
    case "task.stage-passed":
    case "task.stage-failed": {
      const current = task(event.data.taskId);
      if (current.status !== "landed") reject(`task ${current.spec.id} is ${current.status}, not landed`);
      if (!current.spec.stages.includes(event.data.stage)) reject(`stage ${event.data.stage} is not configured for ${current.spec.id}`);
      const passed = event.type === "task.stage-passed";
      current.stages[event.data.stage] = { passed, evidence: event.data.evidence };
      if (!passed) pause(current, "check-failed", `stage ${event.data.stage}: ${event.data.evidence}`);
      else if (settled(current)) current.status = "done";
      return;
    }
    case "task.accepted": {
      const current = task(event.data.taskId);
      if (current.status !== "landed" || !current.spec.manualAcceptance) reject(`task ${current.spec.id} is not awaiting acceptance`);
      current.accepted = true;
      if (settled(current)) current.status = "done";
      return;
    }
    case "task.rework": {
      const current = task(event.data.taskId);
      if (current.status !== "landed" && current.status !== "done") reject(`task ${current.spec.id} has not landed`);
      current.stages = {};
      current.accepted = false;
      pause(current, "rework", event.data.reason);
      return;
    }
    case "task.cancelled": {
      const current = task(event.data.taskId);
      if (!CANCELLABLE.has(current.status)) reject(`task ${current.spec.id} is ${current.status}; pause it before cancelling`);
      current.status = "cancelled";
      delete current.attention;
      return;
    }
    case "batch.checked": {
      const batch = projection.batches[event.data.batchId] ?? reject(`unknown batch ${event.data.batchId}`);
      if (batch.status !== "approved") reject(`batch ${batch.id} is not approved`);
      batch.check = { passed: event.data.passed, detail: event.data.detail,
        ...(event.data.culpritTaskId === undefined ? {} : { culpritTaskId: event.data.culpritTaskId }) };
      if (event.data.culpritTaskId !== undefined) {
        if (event.data.passed) reject("a passing check names no culprit");
        if (!batch.taskIds.includes(event.data.culpritTaskId)) reject(`task ${event.data.culpritTaskId} is not in batch ${batch.id}`);
        const culprit = task(event.data.culpritTaskId);
        if (!FINISHED.has(culprit.status)) reject(`culprit ${culprit.spec.id} has not landed`);
        batch.check.culpritCommit = culprit.landedCommit;
        pause(culprit, "batch-check", event.data.detail);
      }
      return;
    }
    case "slot.dirty": {
      const slot = projection.slots[event.data.slot] ??= {};
      if (slot.taskId !== undefined) reject(`slot ${event.data.slot} is held by ${slot.taskId}`);
      slot.dirty = event.data.detail;
      return;
    }
    case "slot.cleaned": {
      const slot = projection.slots[event.data.slot];
      if (slot?.dirty === undefined) reject(`slot ${event.data.slot} is not dirty`);
      delete slot!.dirty;
      return;
    }
  }
}
