/**
 * The lead's view of the team: what waits for a person first, then what is moving. It is
 * rendered from the log on every request, so a fresh lead session knows exactly as much as
 * the one before it.
 *
 * @module @chopin/team/status
 */

import { stuckTasks } from "./scheduler.js";
import type { TaskProjection, TaskStatus, TeamProjection } from "./types.js";

const DETAIL_CHARS = 300;
const ORDER: TaskStatus[] = ["attention", "running", "queued", "proposed", "delivered", "landed", "done", "cancelled", "rejected"];

function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= DETAIL_CHARS ? line : `${line.slice(0, DETAIL_CHARS - 3)}...`;
}

function awaitingPerson(task: TaskProjection): string[] {
  const stages = task.spec.stages.filter((stage) => task.stages[stage]?.passed !== true);
  return [...stages.map((stage) => `stage ${stage}`), ...(task.spec.manualAcceptance && !task.accepted ? ["acceptance"] : [])];
}

/** A compact account of the team for the lead's context; empty when the log holds nothing. */
export function leadBrief(projection: TeamProjection): string {
  const tasks = Object.values(projection.tasks);
  if (tasks.length === 0) return "";
  const counts = ORDER.map((status) => [status, tasks.filter((task) => task.status === status).length] as const)
    .filter(([, count]) => count > 0).map(([status, count]) => `${count} ${status}`);
  const lines = [`Team: ${counts.join(", ")}.`];
  const attention = tasks.filter((task) => task.status === "attention");
  if (attention.length > 0) {
    lines.push("Waiting for a decision (relay the person's answer with team_task_decide, or team_task_cancel):",
      ...attention.map((task) => `- ${task.spec.id} [${task.attention!.reason}] ${clip(task.attention!.detail)}${task.branch === undefined ? "" : ` (work kept on ${task.branch})`}`));
  }
  const approvals = Object.values(projection.batches).filter((batch) => batch.status === "proposed");
  for (const batch of approvals) {
    const authoring = batch.taskIds.map((id) => projection.tasks[id]!).filter((task) => task.spec.kind === "acceptance" && task.status !== "done" && task.status !== "cancelled");
    lines.push(authoring.length > 0
      ? `Batch ${batch.id}: acceptance checks still being written by ${authoring.map((task) => task.spec.id).join(", ")}.`
      : `Batch ${batch.id}: ready for the person's approval with team_batch_approve; ${batch.taskIds.length} tasks, at most ${batch.maxRequests} model requests.`);
  }
  const merge = tasks.filter((task) => task.status === "delivered" && task.delivered!.mode !== "push");
  if (merge.length > 0) {
    lines.push("Committed and waiting for the person to merge into the trunk:",
      ...merge.map((task) => `- ${task.spec.id}: branch ${task.branch} (${task.delivered!.commit.slice(0, 12)})`));
  }
  const landed = tasks.filter((task) => task.status === "landed").map((task) => [task, awaitingPerson(task)] as const).filter(([, waits]) => waits.length > 0);
  if (landed.length > 0) {
    lines.push("Landed, waiting for the person (team_task_accept or team_task_rework):",
      ...landed.map(([task, waits]) => `- ${task.spec.id}: ${waits.join(", ")}`));
  }
  for (const stuck of stuckTasks(projection)) lines.push(`- ${stuck.taskId} can never start: ${stuck.deadDependencies.join(", ")} will not land.`);
  for (const batch of Object.values(projection.batches)) {
    if (batch.check !== undefined && !batch.check.passed) lines.push(`Batch ${batch.id} full check failed: ${clip(batch.check.detail)}`);
  }
  const running = tasks.filter((task) => task.status === "running");
  if (running.length > 0) lines.push(`Running: ${running.map((task) => `${task.spec.id} (${task.attempt!.slot}, round ${task.attempt!.round})`).join(", ")}.`);
  return lines.join("\n");
}
