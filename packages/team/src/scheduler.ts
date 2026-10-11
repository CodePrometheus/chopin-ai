/**
 * Deterministic assignment of claimable tasks to free slots. Two tasks whose write scopes
 * may touch the same file never run at once; the overlap test is conservative, so a false
 * overlap only delays a task while a missed one would cost a rebase conflict.
 *
 * @module @chopin/team/scheduler
 */

import { claimableTasks } from "./fold.js";
import type { TaskProjection, TaskStatus, TeamProjection } from "./types.js";

export interface Assignment {
  taskId: string;
  attemptId: string;
  slot: string;
  branch: string;
}

const GLOB_SYNTAX = /[*?[\]{}()!+@]/;
/** Work that will reach the trunk as it stands, so its scope stays held until it lands. */
const HOLDING: ReadonlySet<TaskStatus> = new Set(["running", "delivered"]);
const DEAD: ReadonlySet<TaskStatus> = new Set(["cancelled", "rejected"]);

/** The leading path segments of a glob that contain no glob syntax. */
function staticPrefix(glob: string): string[] {
  const segments = glob.split("/").filter((segment) => segment !== "" && segment !== ".");
  const end = segments.findIndex((segment) => GLOB_SYNTAX.test(segment));
  return end === -1 ? segments : segments.slice(0, end);
}

function prefixOf(shorter: readonly string[], longer: readonly string[]): boolean {
  return shorter.length <= longer.length && shorter.every((segment, index) => segment === longer[index]);
}

/** Whether any glob of `a` may match a file some glob of `b` matches. */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((left) => b.some((right) => {
    const l = staticPrefix(left);
    const r = staticPrefix(right);
    return prefixOf(l, r) || prefixOf(r, l);
  }));
}

export function branchFor(task: TaskProjection): string {
  return task.branch ?? `team/${task.spec.id}`;
}

/**
 * Assignments for this pass: acceptance tasks first, since a person waits on them to approve
 * a batch; then batch order. `slots` is the configured pool, in configuration order.
 */
export function assign(projection: TeamProjection, slots: readonly string[]): Assignment[] {
  const free = slots.filter((slot) => projection.slots[slot]?.taskId === undefined && projection.slots[slot]?.dirty === undefined);
  const held = Object.values(projection.tasks).filter((task) => HOLDING.has(task.status)).map((task) => task.spec.writeScope);
  const order = Object.values(projection.batches).flatMap((batch) => batch.taskIds);
  const candidates = claimableTasks(projection)
    .sort((a, b) => Number(b.spec.kind === "acceptance") - Number(a.spec.kind === "acceptance")
      || order.indexOf(a.spec.id) - order.indexOf(b.spec.id));
  const assignments: Assignment[] = [];
  for (const task of candidates) {
    const slot = free[assignments.length];
    if (slot === undefined) break;
    if (held.some((scope) => scopesOverlap(scope, task.spec.writeScope))) continue;
    held.push(task.spec.writeScope);
    assignments.push({ taskId: task.spec.id, attemptId: `${task.spec.id}-a${task.attemptIds.length + 1}`, slot, branch: branchFor(task) });
  }
  return assignments;
}

/** Queued tasks that can never be claimed because a dependency was cancelled or rejected. */
export function stuckTasks(projection: TeamProjection): { taskId: string; deadDependencies: string[] }[] {
  return Object.values(projection.tasks).filter((task) => task.status === "queued").flatMap((task) => {
    const dead = task.spec.dependsOn.filter((id) => DEAD.has(projection.tasks[id]!.status));
    return dead.length === 0 ? [] : [{ taskId: task.spec.id, deadDependencies: dead }];
  });
}
