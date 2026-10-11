/**
 * When a `complete` report is accepted. The worker's report tool asks before the round ends,
 * so a fixable miss is fixed in the same round; the host asks again before it delivers, and
 * only its answer counts.
 *
 * @module @chopin/team/gates
 */

import { join, matchesGlob } from "node:path";

import { CHECK_TOOL } from "./brief.js";
import { modifiedChecks, sha256File } from "./checks.js";
import { affectedChecks, scopeViolations } from "./config.js";
import type { TeamConfig } from "./config.js";
import { changedFiles, treeDigest } from "./git.js";
import type { TrunkRef } from "./git.js";
import type { AuthoredCheck, PauseReason, RoundReport, TaskProjection, TeamProjection } from "./types.js";

export interface GateContext {
  config: TeamConfig;
  ref: TrunkRef;
  slot: string;
  projection: TeamProjection;
  task: TaskProjection;
}

/** The last check run that passed in a round, as the session log records it. */
export interface CheckRun {
  tree: string;
  commands: string[];
}

export interface Refusal {
  reason: PauseReason;
  detail: string;
}

export function listed(items: readonly string[]): string {
  return items.length <= 8 ? items.join(", ") : `${items.slice(0, 8).join(", ")} and ${items.length - 8} more`;
}

/** Every acceptance check path pinned for tasks other than `taskId`. */
export function otherChecks(projection: TeamProjection, taskId: string): string[] {
  return Object.values(projection.tasks).filter((task) => task.spec.id !== taskId).flatMap((task) => task.checks.map((check) => check.path));
}

/** The check commands the slot's changes select right now. */
export async function checkCommands(context: GateContext): Promise<string[]> {
  return affectedChecks(context.config, await changedFiles(context.slot, context.ref));
}

/** An acceptance task's checks, pinned by content; call only once {@link completionRefusal} found nothing. */
export async function authoredChecks(context: GateContext, report: RoundReport): Promise<AuthoredCheck[]> {
  return Promise.all((report.checks ?? []).map(async (check) => ({ ...check, sha256: (await sha256File(join(context.slot, check.path)))! })));
}

/** Why `report` cannot complete the task as the slot stands; undefined when it can. */
export async function completionRefusal(context: GateContext, report: RoundReport, passingCheck?: CheckRun): Promise<Refusal | undefined> {
  const { config, projection, task, slot } = context;
  const changed = await changedFiles(slot, context.ref);
  switch (task.spec.kind) {
    case "read-only":
      return changed.length === 0 ? undefined : { reason: "write-scope", detail: `a read-only task changed ${listed(changed)}` };
    case "acceptance": {
      if (report.checks === undefined) return { reason: "check-failed", detail: "reported complete without listing which check gates which task" };
      const violations = scopeViolations(changed, task.spec.writeScope, [], otherChecks(projection, task.spec.id));
      if (violations.length > 0) return { reason: "write-scope", detail: `changed outside its write scope: ${listed(violations)}` };
      const problems: string[] = [];
      for (const check of report.checks) {
        const target = projection.tasks[check.forTaskId];
        if (target === undefined || target.batchId !== task.batchId || target.spec.kind !== "change") problems.push(`${check.forTaskId} is not a change task of this batch`);
        if (!task.spec.writeScope.some((glob) => matchesGlob(check.path, glob))) problems.push(`${check.path} is outside the write scope`);
        if (affectedChecks(config, [check.path]).length === 0) problems.push(`no configured check runs ${check.path}`);
        if (await sha256File(join(slot, check.path)) === undefined) problems.push(`${check.path} does not exist`);
      }
      return problems.length === 0 ? undefined : { reason: "check-failed", detail: listed(problems) };
    }
    case "change": {
      const violations = scopeViolations(changed, task.spec.writeScope, task.checks.map((check) => check.path), otherChecks(projection, task.spec.id));
      if (violations.length > 0) return { reason: "write-scope", detail: `changed outside its write scope: ${listed(violations)}` };
      const edited = await modifiedChecks(slot, task.checks);
      if (edited.length > 0) return { reason: "write-scope", detail: `edited or removed its acceptance checks: ${listed(edited)}` };
      const required = affectedChecks(config, changed);
      if (required.length === 0) return undefined;
      if (passingCheck === undefined) return { reason: "check-failed", detail: `no passing ${CHECK_TOOL} run in the completing round` };
      const skipped = required.filter((command) => !passingCheck.commands.includes(command));
      if (skipped.length > 0) return { reason: "check-failed", detail: `the last passing check skipped ${listed(skipped)}` };
      if (passingCheck.tree !== await treeDigest(slot)) return { reason: "check-failed", detail: "the working tree changed after the last passing check" };
      return undefined;
    }
  }
}
