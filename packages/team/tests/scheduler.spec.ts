import { describe, expect, it } from "vitest";

import { teamEvent } from "../src/events.js";
import { foldTeamEvents } from "../src/fold.js";
import { assign, scopesOverlap, stuckTasks } from "../src/scheduler.js";
import type { TaskSpec, TeamEvent } from "../src/types.js";

const HOST = { kind: "host", id: "orchestrator" } as const;
const MASTER = { kind: "master", id: "master-session" } as const;
const SLOTS = ["slot-1", "slot-2", "slot-3"];

function spec(id: string, overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id, kind: "change", objective: `do ${id}`, ...(overrides.kind === undefined || overrides.kind === "change" ? { commitMessage: `feat: ${id}` } : {}), writeScope: [`src/${id}/**`], dependsOn: [],
    acceptance: { criteria: `${id} works`, examples: [] }, maxRequests: 20, maxRounds: 3, stages: [], manualAcceptance: true,
    ...overrides,
  };
}

function approved(batchId: string, ...tasks: TaskSpec[]): TeamEvent[] {
  return [
    teamEvent("batch.proposed", MASTER, { batchId, tasks, proposedBy: "master-session" }),
    teamEvent("batch.approved", HOST, { batchId, approvalAuditId: `audit-${batchId}`, decidedAt: new Date().toISOString() }),
  ];
}

function claim(taskId: string, attemptId: string, slot: string): TeamEvent {
  return teamEvent("task.claimed", HOST, { taskId, attemptId, slot, branch: `team/${taskId}` });
}

describe("scope overlap", () => {
  it("compares the literal leading segments of each glob", () => {
    expect(scopesOverlap(["src/api/**"], ["src/api/routes.ts"])).toBe(true);
    expect(scopesOverlap(["src/api/**"], ["src/apis/**"])).toBe(false);
    expect(scopesOverlap(["src/a.ts"], ["src/b.ts"])).toBe(false);
    expect(scopesOverlap(["**/*.md"], ["src/api/**"])).toBe(true);
    expect(scopesOverlap([], ["src/api/**"])).toBe(false);
  });
});

describe("assignment", () => {
  it("fills free slots in batch order and skips a task whose scope is held", () => {
    const events = [
      ...approved("first", spec("alpha", { writeScope: ["src/shared/**"] }), spec("beta"), spec("gamma", { writeScope: ["src/shared/util.ts"] })),
      ...approved("second", spec("delta"), spec("epsilon")),
    ];
    expect(assign(foldTeamEvents(events), SLOTS)).toEqual([
      { taskId: "alpha", attemptId: "alpha-a1", slot: "slot-1", branch: "team/alpha" },
      { taskId: "beta", attemptId: "beta-a1", slot: "slot-2", branch: "team/beta" },
      { taskId: "delta", attemptId: "delta-a1", slot: "slot-3", branch: "team/delta" },
    ]);
  });

  it("never hands out a held or dirty slot, and resumes a paused task on its branch with a fresh attempt", () => {
    const events = [...approved("first", spec("alpha"), spec("beta")), claim("alpha", "alpha-a1", "slot-1"),
      teamEvent("task.paused", HOST, { taskId: "alpha", attemptId: "alpha-a1", reason: "interrupted", detail: "host restarted" }),
      claim("beta", "beta-a1", "slot-1"),
      teamEvent("slot.dirty", HOST, { slot: "slot-2", detail: "stray file" })];
    expect(assign(foldTeamEvents(events), SLOTS)).toEqual([{ taskId: "alpha", attemptId: "alpha-a2", slot: "slot-3", branch: "team/alpha" }]);
  });

  it("runs acceptance tasks of a proposed batch before approved work", () => {
    const events = [...approved("first", spec("alpha")),
      teamEvent("batch.proposed", MASTER, { batchId: "second", tasks: [spec("author", { kind: "acceptance", writeScope: ["tests/acceptance/**"] }), spec("beta")], proposedBy: "master-session" })];
    expect(assign(foldTeamEvents(events), ["slot-1"]).map((assignment) => assignment.taskId)).toEqual(["author"]);
  });

  it("reports queued tasks whose dependency will never land", () => {
    const events = [teamEvent("batch.proposed", MASTER, { batchId: "first", tasks: [spec("alpha"), spec("beta", { dependsOn: ["alpha"] })], proposedBy: "master-session" }),
      teamEvent("task.cancelled", MASTER, { taskId: "alpha", reason: "replanned" }),
      teamEvent("batch.approved", HOST, { batchId: "first", approvalAuditId: "audit", decidedAt: new Date().toISOString() })];
    const projection = foldTeamEvents(events);
    expect(assign(projection, SLOTS)).toEqual([]);
    expect(stuckTasks(projection)).toEqual([{ taskId: "beta", deadDependencies: ["alpha"] }]);
  });
});
