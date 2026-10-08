import { createHash } from "node:crypto";

import { canonicalJson, createEvolutionEvent } from "./events.js";
import type { EvolutionEvent, JsonObject, JsonValue } from "./types.js";
import { assertExecutionContext } from "./execution-context.js";
import type { ExecutionContext } from "./execution-context.js";

export const IMPROVER_TOOL = "learned_improver";

export interface ImproverReference {
  kind: "builtin" | "artifact";
  id: string;
  contentDigest: string;
}

export interface ImprovementWork {
  key: string;
  action: string;
  targetId: string;
  detail: string;
  evidenceUnits: number;
}

export interface ImprovementInput {
  schemaVersion: 1;
  objective: string;
  strategy: ImproverReference;
  budget: { maxActions: number };
  work: ImprovementWork[];
  environment?: ExecutionContext;
  evidence?: Array<{ digest: string; value: JsonValue }>;
  history: Array<{ artifactId: string; state: string; summary: string; outcome: {
    windowId: string; eligible: number; activated: number; taskPass: number; taskFail: number;
    recurrence: number; falseBlock: number;
  } | null }>;
}

export interface ImprovementPlan {
  schemaVersion: 1;
  actions: Array<{ key: string; reason: string; instructions: string }>;
}

export interface ImprovementRecord {
  id: string;
  sessionId: string;
  requestId: string;
  input: ImprovementInput;
  inputDigest: string;
  plan: ImprovementPlan;
  planDigest: string;
  createdAt: string;
}

export function improvementDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function baselineImprovementPlan(input: ImprovementInput): ImprovementPlan {
  return {
    schemaVersion: 1,
    actions: input.work.slice(0, input.budget.maxActions).map((work) => ({
      key: work.key,
      reason: work.detail,
      instructions: "Inspect the evidence and contract, perform the offered action within its stated scope, and verify the result with the supplied checks.",
    })),
  };
}

export function baselineImprover(): ImproverReference {
  return { kind: "builtin", id: "builtin-improver", contentDigest: improvementDigest(baselineImprovementPlan.toString()) };
}

function object(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new Error(`${label} fields differ from the contract`);
}

function text(value: unknown, max: number, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new Error(`${label} must contain 1-${max} characters`);
}

export function assertImprovementInput(value: unknown): asserts value is ImprovementInput {
  const optional = ["environment", "evidence"].filter(key => value !== null && typeof value === "object" && Object.hasOwn(value, key));
  object(value, ["schemaVersion", "objective", "strategy", "budget", "work", "history", ...optional], "improvement input");
  if (value.schemaVersion !== 1) throw new Error("unknown improvement input schema");
  text(value.objective, 4_000, "objective");
  if (value.environment !== undefined) assertExecutionContext(value.environment);
  if (value.evidence !== undefined) {
    if (!Array.isArray(value.evidence) || value.evidence.length > 8) throw new Error("Improvement evidence must contain at most eight entries");
    for (const evidence of value.evidence) {
      object(evidence, ["digest", "value"], "improvement evidence");
      if (evidence.digest !== improvementDigest(evidence.value)) throw new Error("Improvement evidence content changed");
    }
    if (canonicalJson(value.evidence).length > 32_000) throw new Error("Improvement evidence exceeds its budget");
  }
  object(value.strategy, ["kind", "id", "contentDigest"], "strategy");
  if (value.strategy.kind !== "builtin" && value.strategy.kind !== "artifact") throw new Error("unknown strategy kind");
  text(value.strategy.id, 128, "strategy id");
  if (typeof value.strategy.contentDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.strategy.contentDigest)) throw new Error("invalid strategy digest");
  object(value.budget, ["maxActions"], "improvement budget");
  if (!Number.isSafeInteger(value.budget.maxActions) || (value.budget.maxActions as number) < 0 || (value.budget.maxActions as number) > 3) throw new Error("improvement action limit must be 0-3");
  if (!Array.isArray(value.work) || value.work.length > 50) throw new Error("improvement work must contain at most 50 items");
  const keys = new Set<string>();
  for (const item of value.work) {
    object(item, ["key", "action", "targetId", "detail", "evidenceUnits"], "work item");
    text(item.key, 128, "work key");
    if (keys.has(item.key)) throw new Error("duplicate improvement work key");
    keys.add(item.key);
    text(item.action, 64, "work action");
    text(item.targetId, 128, "work target");
    text(item.detail, 1_000, "work detail");
    if (!Number.isSafeInteger(item.evidenceUnits) || (item.evidenceUnits as number) < 0) throw new Error("invalid evidence unit count");
  }
  if (!Array.isArray(value.history) || value.history.length > 30) throw new Error("improvement history must contain at most 30 entries");
  for (const item of value.history) {
    object(item, ["artifactId", "state", "summary", "outcome"], "history entry");
    text(item.artifactId, 128, "history artifact");
    text(item.state, 64, "history state");
    text(item.summary, 500, "history summary");
    if (item.outcome !== null) {
      object(item.outcome, ["windowId", "eligible", "activated", "taskPass", "taskFail", "recurrence", "falseBlock"], "history outcome");
      text(item.outcome.windowId, 256, "feedback window");
      for (const key of ["eligible", "activated", "taskPass", "taskFail", "recurrence", "falseBlock"]) {
        if (!Number.isSafeInteger(item.outcome[key]) || (item.outcome[key] as number) < 0) throw new Error("invalid observed outcome count");
      }
    }
  }
}

/** A strategy may only pick host-provided work and make suggestions; it cannot return directly executable host operations. */
export function assertImprovementPlan(value: unknown, input: ImprovementInput): asserts value is ImprovementPlan {
  assertImprovementInput(input);
  object(value, ["schemaVersion", "actions"], "improvement plan");
  if (value.schemaVersion !== 1 || !Array.isArray(value.actions) || value.actions.length > input.budget.maxActions) throw new Error("plan exceeds its action contract");
  const offered = new Set(input.work.map((work) => work.key));
  const selected = new Set<string>();
  for (const action of value.actions) {
    object(action, ["key", "reason", "instructions"], "plan action");
    text(action.key, 128, "action key");
    if (!offered.has(action.key) || selected.has(action.key)) throw new Error("plan selected an unknown or duplicate work item");
    selected.add(action.key);
    text(action.reason, 1_000, "action reason");
    text(action.instructions, 4_000, "action instructions");
  }
}

export function assertImprovementRecord(value: unknown): asserts value is ImprovementRecord {
  object(value, ["id", "sessionId", "requestId", "input", "inputDigest", "plan", "planDigest", "createdAt"], "improvement record");
  text(value.id, 128, "improvement id");
  text(value.sessionId, 128, "improvement session");
  text(value.requestId, 256, "improvement request");
  assertImprovementInput(value.input);
  assertImprovementPlan(value.plan, value.input);
  if (value.inputDigest !== improvementDigest(value.input) || value.planDigest !== improvementDigest(value.plan)) throw new Error("improvement record digest differs");
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) throw new Error("invalid improvement timestamp");
}

export function improvementPlanned(record: ImprovementRecord): EvolutionEvent {
  assertImprovementRecord(record);
  return createEvolutionEvent({
    entityKind: "improvement", entityId: record.id, eventId: record.id, type: "improvement.planned",
    actor: { kind: "system", id: "chopin-improver" }, occurredAt: record.createdAt,
    data: JSON.parse(JSON.stringify({ record })) as JsonObject,
  });
}
