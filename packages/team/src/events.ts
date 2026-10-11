/**
 * Team event construction and shape validation. Validation is per line and context-free;
 * rules that need the history (dependencies, attempts, slots) live in the fold.
 *
 * @module @chopin/team/events
 */

import { randomUUID } from "node:crypto";

import { assertReport, InvalidReportError } from "./report.js";

import type { TaskSpec, TeamActor, TeamEvent, TeamEventData, TeamEventType } from "./types.js";

export class InvalidTeamEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTeamEventError";
  }
}

/** A leading letter keeps ids from being integer keys, which would reorder the projection. */
const SLUG = /^[a-z][a-z0-9-]{0,127}$/;
const ENVELOPE_KEYS = new Set(["schemaVersion", "eventId", "occurredAt", "type", "actor", "data"]);
const PAUSE_REASONS = new Set(["blocked", "needs-decision", "request-budget", "round-budget", "write-scope", "rebase-conflict",
  "approval", "check-failed", "batch-check", "interrupted", "rework", "cancelled", "replanned"]);
/** Which actor may write each event; the master never approves, delivers or verifies its own work. */
const WRITERS: Record<TeamEventType, readonly TeamActor["kind"][]> = {
  "batch.proposed": ["master"],
  "batch.approved": ["host"],
  "batch.rejected": ["host"],
  "task.claimed": ["host"],
  "task.round-started": ["host"],
  "task.round-reported": ["host"],
  "task.paused": ["host"],
  "decision.recorded": ["master"],
  "task.delivered": ["host"],
  "task.landed": ["host"],
  "task.completed": ["host"],
  "task.checks-authored": ["host"],
  "task.stage-passed": ["host"],
  "task.stage-failed": ["host"],
  "task.accepted": ["host"],
  "task.rework": ["host"],
  "task.cancelled": ["host", "master"],
  "batch.checked": ["host"],
  "slot.dirty": ["host"],
  "slot.cleaned": ["host"],
};

function fail(message: string): never {
  throw new InvalidTeamEventError(message);
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${what} must be a non-empty string`);
  return value;
}

function slug(value: unknown, what: string): string {
  if (typeof value !== "string" || !SLUG.test(value)) fail(`${what} must be a lowercase slug of letters, digits and dashes starting with a letter`);
  return value;
}

function strings(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) fail(`${what} must be an array of non-empty strings`);
  return value as string[];
}

function count(value: unknown, what: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail(`${what} must be an integer of at least ${minimum}`);
  return value;
}

function assertTaskSpec(value: unknown, where: string): asserts value is TaskSpec {
  const spec = object(value, where);
  slug(spec.id, `${where}.id`);
  if (spec.kind !== "acceptance" && spec.kind !== "change" && spec.kind !== "read-only") fail(`${where}.kind is not a task kind`);
  text(spec.objective, `${where}.objective`);
  if (spec.kind === "change") {
    const message = text(spec.commitMessage, `${where}.commitMessage`);
    if (message.includes("\n") || message.length > 200) fail(`${where}.commitMessage must be one line of at most 200 characters`);
  } else if (spec.commitMessage !== undefined) fail(`${where}.commitMessage is only for a change task`);
  const scope = strings(spec.writeScope, `${where}.writeScope`);
  if (spec.kind === "read-only" ? scope.length > 0 : scope.length === 0) {
    fail(`${where}.writeScope must be empty exactly for a read-only task`);
  }
  strings(spec.dependsOn, `${where}.dependsOn`).forEach((id, index) => slug(id, `${where}.dependsOn[${index}]`));
  const acceptance = object(spec.acceptance, `${where}.acceptance`);
  text(acceptance.criteria, `${where}.acceptance.criteria`);
  strings(acceptance.examples, `${where}.acceptance.examples`);
  if (spec.model !== undefined) {
    const model = object(spec.model, `${where}.model`);
    text(model.provider, `${where}.model.provider`);
    text(model.model, `${where}.model.model`);
  }
  count(spec.maxRequests, `${where}.maxRequests`, 1);
  count(spec.maxRounds, `${where}.maxRounds`, 1);
  strings(spec.stages, `${where}.stages`);
  if (typeof spec.manualAcceptance !== "boolean") fail(`${where}.manualAcceptance must be a boolean`);
  if (spec.kind !== "change" && (spec.stages as string[]).length > 0) fail(`${where}.stages must be empty unless the task lands a change`);
  if (spec.kind === "acceptance" && (spec.dependsOn as string[]).length > 0) fail(`${where}.dependsOn must be empty for an acceptance task`);
}

function assertData(type: TeamEventType, data: Record<string, unknown>): void {
  switch (type) {
    case "batch.proposed": {
      slug(data.batchId, "batchId");
      if (!Array.isArray(data.tasks) || data.tasks.length === 0) fail("tasks must be a non-empty array");
      data.tasks.forEach((task, index) => assertTaskSpec(task, `tasks[${index}]`));
      text(data.proposedBy, "proposedBy");
      return;
    }
    case "batch.approved":
      slug(data.batchId, "batchId"); text(data.approvalAuditId, "approvalAuditId"); text(data.decidedAt, "decidedAt"); return;
    case "batch.rejected":
      slug(data.batchId, "batchId"); text(data.reason, "reason"); return;
    case "task.claimed":
      slug(data.taskId, "taskId"); text(data.attemptId, "attemptId"); text(data.slot, "slot"); text(data.branch, "branch"); return;
    case "task.round-started":
      slug(data.taskId, "taskId"); text(data.attemptId, "attemptId"); count(data.round, "round", 1); text(data.sessionId, "sessionId"); return;
    case "task.round-reported": {
      slug(data.taskId, "taskId"); text(data.attemptId, "attemptId"); count(data.round, "round", 1);
      try {
        assertReport(data.report);
      } catch (error) {
        if (error instanceof InvalidReportError) fail(error.message);
        throw error;
      }
      const usage = object(data.usage, "usage");
      for (const key of ["requests", "inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"]) count(usage[key], `usage.${key}`, 0);
      return;
    }
    case "task.paused":
      slug(data.taskId, "taskId"); text(data.attemptId, "attemptId");
      if (!PAUSE_REASONS.has(data.reason as string)) fail("reason is not a pause reason");
      text(data.detail, "detail");
      if (data.savedCommit !== undefined) text(data.savedCommit, "savedCommit");
      return;
    case "decision.recorded":
      slug(data.taskId, "taskId"); text(data.decision, "decision"); text(data.sessionId, "sessionId"); return;
    case "task.delivered":
      slug(data.taskId, "taskId"); text(data.attemptId, "attemptId"); text(data.commit, "commit");
      if (data.mode !== "local" && data.mode !== "push" && data.mode !== "pull-request") fail("mode must be local, push or pull-request");
      return;
    case "task.landed":
      slug(data.taskId, "taskId"); text(data.commit, "commit"); return;
    case "task.completed":
      slug(data.taskId, "taskId"); text(data.attemptId, "attemptId"); return;
    case "task.checks-authored": {
      slug(data.taskId, "taskId"); text(data.attemptId, "attemptId"); text(data.commit, "commit");
      if (!Array.isArray(data.checks) || data.checks.length === 0) fail("checks must be a non-empty array");
      data.checks.forEach((value, index) => {
        const check = object(value, `checks[${index}]`);
        slug(check.forTaskId, `checks[${index}].forTaskId`);
        const path = text(check.path, `checks[${index}].path`);
        if (path.startsWith("/") || path.split("/").includes("..")) fail(`checks[${index}].path must be repository-relative`);
        if (typeof check.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(check.sha256)) fail(`checks[${index}].sha256 must be a hex digest`);
      });
      return;
    }
    case "task.stage-passed":
    case "task.stage-failed":
      slug(data.taskId, "taskId"); text(data.stage, "stage"); text(data.evidence, "evidence"); return;
    case "task.accepted":
      slug(data.taskId, "taskId"); return;
    case "task.rework":
    case "task.cancelled":
      slug(data.taskId, "taskId"); text(data.reason, "reason"); return;
    case "batch.checked":
      slug(data.batchId, "batchId");
      if (typeof data.passed !== "boolean") fail("passed must be a boolean");
      text(data.detail, "detail");
      if (data.culpritTaskId !== undefined) slug(data.culpritTaskId, "culpritTaskId");
      return;
    case "slot.dirty":
      text(data.slot, "slot"); text(data.detail, "detail"); return;
    case "slot.cleaned":
      text(data.slot, "slot"); return;
  }
}

export function assertTeamEvent(value: unknown): asserts value is TeamEvent {
  const event = object(value, "team event");
  for (const key of Object.keys(event)) if (!ENVELOPE_KEYS.has(key)) fail(`unknown envelope field ${key}`);
  if (event.schemaVersion !== 1) fail("schemaVersion must be 1");
  text(event.eventId, "eventId");
  if (typeof event.occurredAt !== "string" || new Date(event.occurredAt).toISOString() !== event.occurredAt) {
    fail("occurredAt must be a canonical ISO timestamp");
  }
  const type = event.type as TeamEventType;
  if (typeof type !== "string" || !(type in WRITERS)) fail(`unknown team event type ${String(event.type)}`);
  const actor = object(event.actor, "actor");
  text(actor.id, "actor.id");
  if (!WRITERS[type].includes(actor.kind as TeamActor["kind"])) fail(`${type} cannot be written by ${String(actor.kind)}`);
  assertData(type, object(event.data, "data"));
}

/** Build one event with a fresh id and the current time; the result is validated before it is returned. */
export function teamEvent<T extends TeamEventType>(type: T, actor: TeamActor, data: TeamEventData<T>): Extract<TeamEvent, { type: T }> {
  const event: unknown = { schemaVersion: 1, eventId: randomUUID(), occurredAt: new Date().toISOString(), type, actor, data };
  assertTeamEvent(event);
  return event as Extract<TeamEvent, { type: T }>;
}
