/**
 * The brief each round's fresh worker starts from. Everything in it is derived from the team
 * log, so a round after a restart reads exactly what it would have read without one.
 *
 * @module @chopin/team/brief
 */

import type { RoundReport, TaskProjection, TeamProjection } from "./types.js";

export const REPORT_TOOL = "team_report";
export const CHECK_TOOL = "team_check";

function list(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function reportText(report: RoundReport): string {
  return [
    `Status: ${report.status}`,
    `Summary: ${report.summary}`,
    ...(report.evidence.length > 0 ? [`Evidence:\n${list(report.evidence)}`] : []),
    ...(report.nextSteps.length > 0 ? [`Next steps:\n${list(report.nextSteps)}`] : []),
    ...(report.blocker === undefined ? [] : [`Blocker: ${report.blocker}`]),
  ].join("\n");
}

function acceptanceText(task: TaskProjection): string {
  return [`Criteria: ${task.spec.acceptance.criteria}`,
    ...(task.spec.acceptance.examples.length > 0 ? [`Examples:\n${list(task.spec.acceptance.examples)}`] : [])].join("\n");
}

function kindText(task: TaskProjection, projection: TeamProjection): string {
  switch (task.spec.kind) {
    case "read-only":
      return "This task is read-only: change no file. Your report is the deliverable; put the findings in its summary and evidence.";
    case "acceptance": {
      const targets = projection.batches[task.batchId]!.taskIds.map((id) => projection.tasks[id]!)
        .filter((target) => target.spec.kind === "change");
      return [
        "Turn the acceptance criteria of the tasks below into executable checks, before anyone implements them.",
        "Write the checks only, never the implementation, inside your write scope, so that each check runs under a configured check command.",
        `When they are written, report complete and list in \`checks\` which file gates which task.`,
        ...targets.map((target) => `## ${target.spec.id}\nObjective: ${target.spec.objective}\nWrite scope: ${target.spec.writeScope.join(", ")}\n${acceptanceText(target)}`),
      ].join("\n\n");
    }
    case "change":
      return [
        `Before reporting complete, run ${CHECK_TOOL} on the final working tree; completion is refused unless its last run passed on exactly the tree you leave behind.`,
        "The host commits, rebases and pushes once you report complete: do not commit or push yourself.",
        ...(task.checks.length > 0 ? [`These acceptance checks were written for this task. Make them pass; never edit, move or delete them:\n${list(task.checks.map((check) => check.path))}`] : []),
      ].join("\n");
  }
}

/** The opening message of one round. */
export function workerBrief(projection: TeamProjection, task: TaskProjection, requestsLeft: number): string {
  const dependencies = task.spec.dependsOn.map((id) => projection.tasks[id]!)
    .filter((dependency) => dependency.lastReport !== undefined)
    .map((dependency) => `## ${dependency.spec.id}\n${reportText(dependency.lastReport!.report)}`);
  const previous = task.lastReport === undefined
    ? (task.rounds > 0 ? ["The previous round ended without a report. Treat the working tree as authoritative."] : [])
    : task.lastReport.round < task.rounds
      ? [`The latest round ended without a report; the last one, from round ${task.lastReport.round}, follows. The working tree is authoritative where they differ.\n${reportText(task.lastReport.report)}`]
      : [`Report from round ${task.lastReport.round}:\n${reportText(task.lastReport.report)}`];
  return [
    `# Team task ${task.spec.id} (${task.spec.kind}), round ${task.rounds + 1} of at most ${task.spec.maxRounds}`,
    `Objective: ${task.spec.objective}`,
    `Write scope: ${task.spec.writeScope.length === 0 ? "none" : task.spec.writeScope.join(", ")}`,
    ...(task.spec.kind === "acceptance" ? [] : [`Acceptance\n${acceptanceText(task)}`]),
    kindText(task, projection),
    ...(task.decisions.length > 0 ? [`Decisions made for this task, in order:\n${list(task.decisions)}`] : []),
    ...(dependencies.length > 0 ? [`Reports from the tasks this one depends on:\n\n${dependencies.join("\n\n")}`] : []),
    ...previous,
    `You have ${requestsLeft} model requests left for this task. End the round by calling ${REPORT_TOOL}: complete when the objective holds, continue to hand the remaining work to a fresh worker, blocked or needs-decision when only a person can unblock it.`,
  ].join("\n\n");
}
