import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claimableTasks, foldTeamEvents } from "../src/fold.js";
import { teamEvent } from "../src/events.js";
import { TeamEventStore } from "../src/store.js";
import type { RoundReport, TaskSpec, TeamEvent } from "../src/types.js";

const HOST = { kind: "host", id: "orchestrator" } as const;
const MASTER = { kind: "master", id: "master-session" } as const;
const NO_USAGE = { requests: 1, inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 };
const COMPLETE: RoundReport = { status: "complete", summary: "done", evidence: ["tests pass"], nextSteps: [] };

function spec(id: string, overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id, kind: "change", objective: `do ${id}`, ...(overrides.kind === undefined || overrides.kind === "change" ? { commitMessage: `feat: ${id}` } : {}), writeScope: [`src/${id}/**`], dependsOn: [],
    acceptance: { criteria: `${id} works`, examples: [] }, maxRequests: 20, maxRounds: 3, stages: [], manualAcceptance: false,
    ...overrides,
  };
}

/** An approved batch, ready to claim; an acceptance task has written one check for each change task first. */
function approved(...tasks: TaskSpec[]): TeamEvent[] {
  const changes = tasks.filter((task) => task.kind === "change");
  const authoring = changes.length === 0 ? [] : [
    ...round("checks", "checks-1", "slot-0"),
    teamEvent("task.checks-authored", HOST, { taskId: "checks", attemptId: "checks-1", commit: "c0",
      checks: changes.map((task) => ({ forTaskId: task.id, path: `tests/acceptance/${task.id}.spec.ts`, sha256: "0".repeat(64) })) }),
  ];
  const author = changes.length === 0 ? [] : [spec("checks", { kind: "acceptance", writeScope: ["tests/acceptance/**"] })];
  return [
    teamEvent("batch.proposed", MASTER, { batchId: "b1", tasks: [...author, ...tasks], proposedBy: "master-session" }),
    ...authoring,
    teamEvent("batch.approved", HOST, { batchId: "b1", approvalAuditId: "audit-1", decidedAt: new Date().toISOString() }),
  ];
}

/** Claim a task and run one round that reports `report`. */
function round(taskId: string, attemptId: string, slot: string, report: RoundReport = COMPLETE): TeamEvent[] {
  return [
    teamEvent("task.claimed", HOST, { taskId, attemptId, slot, branch: `team/${taskId}` }),
    teamEvent("task.round-started", HOST, { taskId, attemptId, round: 1, sessionId: `${attemptId}-r1` }),
    teamEvent("task.round-reported", HOST, { taskId, attemptId, round: 1, report, usage: NO_USAGE }),
  ];
}

describe("team fold", () => {
  it("takes a change task from proposal to done once it lands", () => {
    const events = [...approved(spec("alpha")), ...round("alpha", "a1", "slot-1"),
      teamEvent("task.delivered", HOST, { taskId: "alpha", attemptId: "a1", commit: "c1", mode: "push" }),
      teamEvent("task.landed", HOST, { taskId: "alpha", commit: "c1" })];
    const projection = foldTeamEvents(events);
    expect(projection.tasks.alpha).toMatchObject({ status: "done", landedCommit: "c1", usage: { requests: 1 } });
    expect(projection.slots["slot-1"]?.taskId).toBeUndefined();
    expect(projection.batches.b1?.maxRequests).toBe(40);
  });

  it("keeps a landed task open until every stage passes and a person accepts it", () => {
    const base = [...approved(spec("alpha", { stages: ["deployed"], manualAcceptance: true })), ...round("alpha", "a1", "slot-1"),
      teamEvent("task.delivered", HOST, { taskId: "alpha", attemptId: "a1", commit: "c1", mode: "push" }),
      teamEvent("task.landed", HOST, { taskId: "alpha", commit: "c1" })];
    expect(foldTeamEvents(base).tasks.alpha?.status).toBe("landed");
    const staged = [...base, teamEvent("task.stage-passed", HOST, { taskId: "alpha", stage: "deployed", evidence: "tag 1.2" })];
    expect(foldTeamEvents(staged).tasks.alpha?.status).toBe("landed");
    expect(foldTeamEvents([...staged, teamEvent("task.accepted", HOST, { taskId: "alpha" })]).tasks.alpha?.status).toBe("done");
  });

  it("refuses to claim a task before its dependencies land", () => {
    const events = approved(spec("alpha"), spec("beta", { dependsOn: ["alpha"] }));
    expect(claimableTasks(foldTeamEvents(events)).map((task) => task.spec.id)).toEqual(["alpha"]);
    expect(() => foldTeamEvents([...events, teamEvent("task.claimed", HOST, { taskId: "beta", attemptId: "b1", slot: "slot-1", branch: "team/beta" })]))
      .toThrow("still waits for alpha");
  });

  it("completes a read-only task from its report and never delivers one", () => {
    const readOnly = spec("scout", { kind: "read-only", writeScope: [] });
    const events = [...approved(readOnly), ...round("scout", "s1", "slot-1")];
    expect(() => foldTeamEvents([...events, teamEvent("task.delivered", HOST, { taskId: "scout", attemptId: "s1", commit: "c", mode: "push" })]))
      .toThrow("read-only task delivers no commit");
    expect(foldTeamEvents([...events, teamEvent("task.completed", HOST, { taskId: "scout", attemptId: "s1" })]).tasks.scout?.status).toBe("done");
    expect(() => approved(spec("bad", { kind: "read-only" }))).toThrow("must be empty exactly for a read-only task");
  });

  it("gives one slot to one task at a time", () => {
    const events = [...approved(spec("alpha"), spec("beta")), teamEvent("task.claimed", HOST, { taskId: "alpha", attemptId: "a1", slot: "slot-1", branch: "team/alpha" })];
    expect(() => foldTeamEvents([...events, teamEvent("task.claimed", HOST, { taskId: "beta", attemptId: "b1", slot: "slot-1", branch: "team/beta" })]))
      .toThrow("slot slot-1 is held by alpha");
  });

  it("rejects a report from a superseded attempt", () => {
    const events = [...approved(spec("alpha")), ...round("alpha", "a1", "slot-1", { ...COMPLETE, status: "blocked", blocker: "needs a key" }),
      teamEvent("task.paused", HOST, { taskId: "alpha", attemptId: "a1", reason: "blocked", detail: "needs a key", savedCommit: "wip" }),
      teamEvent("decision.recorded", MASTER, { taskId: "alpha", decision: "use the staging key", sessionId: "master-session" }),
      teamEvent("task.claimed", HOST, { taskId: "alpha", attemptId: "a2", slot: "slot-2", branch: "team/alpha" })];
    const projection = foldTeamEvents(events);
    expect(projection.tasks.alpha).toMatchObject({ status: "running", decisions: ["use the staging key"], attemptIds: ["a1", "a2"] });
    expect(() => foldTeamEvents([...events, teamEvent("task.round-started", HOST, { taskId: "alpha", attemptId: "a1", round: 2, sessionId: "late" })]))
      .toThrow("attempt a1 is not the current attempt");
  });

  it("enforces the round cap and one report per round", () => {
    const events = [...approved(spec("alpha", { maxRounds: 1 })), ...round("alpha", "a1", "slot-1", { ...COMPLETE, status: "continue" })];
    expect(() => foldTeamEvents([...events, teamEvent("task.round-reported", HOST, { taskId: "alpha", attemptId: "a1", round: 1, report: COMPLETE, usage: NO_USAGE })]))
      .toThrow("no running round 1 awaits a report");
    expect(() => foldTeamEvents([...events, teamEvent("task.round-started", HOST, { taskId: "alpha", attemptId: "a1", round: 2, sessionId: "r2" })]))
      .toThrow("has used all 1 rounds");
  });

  it("requeues an interrupted task without asking anyone and holds other pauses for a decision", () => {
    const base = [...approved(spec("alpha")), teamEvent("task.claimed", HOST, { taskId: "alpha", attemptId: "a1", slot: "slot-1", branch: "team/alpha" })];
    const interrupted = foldTeamEvents([...base, teamEvent("task.paused", HOST, { taskId: "alpha", attemptId: "a1", reason: "interrupted", detail: "host restarted" })]);
    expect(interrupted.tasks.alpha).toMatchObject({ status: "queued", branch: "team/alpha" });
    expect(interrupted.tasks.alpha?.attention).toBeUndefined();
    const budget = foldTeamEvents([...base, teamEvent("task.paused", HOST, { taskId: "alpha", attemptId: "a1", reason: "request-budget", detail: "20 of 20" })]);
    expect(budget.tasks.alpha).toMatchObject({ status: "attention", attention: { reason: "request-budget" } });
    expect(budget.slots["slot-1"]?.taskId).toBeUndefined();
  });

  it("lets only the host approve a batch and only a paused task be cancelled", () => {
    expect(() => teamEvent("batch.approved", MASTER, { batchId: "b1", approvalAuditId: "x", decidedAt: new Date().toISOString() }))
      .toThrow("batch.approved cannot be written by master");
    const running = [...approved(spec("alpha")), teamEvent("task.claimed", HOST, { taskId: "alpha", attemptId: "a1", slot: "slot-1", branch: "team/alpha" })];
    expect(() => foldTeamEvents([...running, teamEvent("task.cancelled", MASTER, { taskId: "alpha", reason: "replanned" })]))
      .toThrow("pause it before cancelling");
  });

  it("puts the culprit of a failed batch check back in front of a person", () => {
    const events = [...approved(spec("alpha")), ...round("alpha", "a1", "slot-1"),
      teamEvent("task.delivered", HOST, { taskId: "alpha", attemptId: "a1", commit: "c1", mode: "push" }),
      teamEvent("task.landed", HOST, { taskId: "alpha", commit: "c1" }),
      teamEvent("batch.checked", HOST, { batchId: "b1", passed: false, detail: "pnpm test failed", culpritTaskId: "alpha" })];
    expect(foldTeamEvents(events).tasks.alpha).toMatchObject({ status: "attention", attention: { reason: "batch-check" } });
  });

  it("writes acceptance checks before approval and pins them to the task they gate", () => {
    const author = spec("author", { kind: "acceptance", writeScope: ["tests/acceptance/**"] });
    const proposed = [teamEvent("batch.proposed", MASTER, { batchId: "b1", tasks: [author, spec("alpha"), spec("beta", { manualAcceptance: true })], proposedBy: "master-session" })];
    const approve = teamEvent("batch.approved", HOST, { batchId: "b1", approvalAuditId: "audit-1", decidedAt: new Date().toISOString() });
    expect(claimableTasks(foldTeamEvents(proposed)).map((task) => task.spec.id)).toEqual(["author"]);
    expect(() => foldTeamEvents([...proposed, approve])).toThrow("acceptance checks are not written yet: author");

    const check = { forTaskId: "alpha", path: "tests/acceptance/alpha.spec.ts", sha256: "a".repeat(64) };
    const authored = [...proposed, ...round("author", "w1", "slot-1"),
      teamEvent("task.checks-authored", HOST, { taskId: "author", attemptId: "w1", commit: "c0", checks: [check] })];
    const projection = foldTeamEvents([...authored, approve]);
    expect(projection.tasks.author?.status).toBe("done");
    expect(projection.tasks.alpha).toMatchObject({ status: "queued", checks: [{ commit: "c0", path: check.path }] });
    expect(projection.slots["slot-1"]?.taskId).toBeUndefined();
    expect(() => foldTeamEvents([...authored, approve, ...round("author", "w2", "slot-1")])).toThrow("task author is done, not queued");
  });

  it("refuses to approve a change nothing will accept and rejects a batch only once its author is paused", () => {
    const author = spec("author", { kind: "acceptance", writeScope: ["tests/acceptance/**"] });
    const proposed = [teamEvent("batch.proposed", MASTER, { batchId: "b1", tasks: [author, spec("alpha")], proposedBy: "master-session" })];
    const claimed = [...proposed, teamEvent("task.claimed", HOST, { taskId: "author", attemptId: "w1", slot: "slot-1", branch: "team/author" })];
    expect(() => foldTeamEvents([...claimed, teamEvent("batch.rejected", HOST, { batchId: "b1", reason: "replanned" })])).toThrow("pause author before rejecting");
    const paused = [...claimed, teamEvent("task.paused", HOST, { taskId: "author", attemptId: "w1", reason: "replanned", detail: "batch rejected" })];
    expect(foldTeamEvents([...paused, teamEvent("batch.rejected", HOST, { batchId: "b1", reason: "replanned" })]).tasks.author?.status).toBe("rejected");
    const dropped = [...proposed, teamEvent("task.cancelled", MASTER, { taskId: "author", reason: "no automated checks" })];
    expect(() => foldTeamEvents([...dropped, teamEvent("batch.approved", HOST, { batchId: "b1", approvalAuditId: "audit-1", decidedAt: new Date().toISOString() })]))
      .toThrow("no acceptance check or manual acceptance gates alpha");
  });

  it("rejects dependency cycles, unknown dependencies and duplicate tasks", () => {
    expect(() => foldTeamEvents(approved(spec("alpha", { dependsOn: ["beta"] }), spec("beta", { dependsOn: ["alpha"] })))).toThrow("dependency cycle");
    expect(() => foldTeamEvents(approved(spec("alpha", { dependsOn: ["ghost"] })))).toThrow("depends on unknown ghost");
    expect(() => foldTeamEvents(approved(spec("alpha"), spec("alpha")))).toThrow("task alpha already exists");
  });
});

describe("team event store", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("lands no bytes for an event the history does not allow", async () => {
    const directory = await mkdtemp(join(tmpdir(), "team-log-"));
    directories.push(directory);
    const store = new TeamEventStore(join(directory, "team.jsonl"));
    await store.append(teamEvent("batch.proposed", MASTER, { batchId: "b1", tasks: [spec("alpha")], proposedBy: "master-session" }));
    const before = await readFile(store.path, "utf8");
    await expect(store.append(teamEvent("task.claimed", HOST, { taskId: "alpha", attemptId: "a1", slot: "slot-1", branch: "team/alpha" })))
      .rejects.toThrow("task alpha is proposed, not queued");
    expect(await readFile(store.path, "utf8")).toBe(before);
    expect((await store.fold()).tasks.alpha?.status).toBe("proposed");
  });
});
