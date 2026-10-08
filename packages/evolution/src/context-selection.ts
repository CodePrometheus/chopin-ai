import { createEvolutionEvent } from "./events.js";
import { improvementDigest } from "./improvement.js";
import type { ImproverReference } from "./improvement.js";
import type { EvolutionEvent, JsonObject } from "./types.js";

export const CONTEXT_SELECTOR_TOOL = "learned_context_selector";
export type ContextPlacement = "index" | "inline" | "both";
export interface ContextSelectionInput {
  schemaVersion: 1;
  objective: string;
  budget: { indexChars: number; indexItems: number; inlineChars: number; inlineItems: number; indexHeaderChars: number };
  candidates: Array<{ id: string; contentDigest: string; kind: "memory" | "skill"; summary: string; when: string;
    indexChars: number; inlineChars: number | null; matchedSelectors: string[] }>;
}
export interface ContextSelectionPlan {
  schemaVersion: 1;
  items: Array<{ id: string; mode: ContextPlacement; reason: string }>;
}
export interface ContextSelectionRecord {
  id: string;
  sessionId: string;
  requestId: string;
  stepSeq: number;
  snapshotSeq: number | null;
  strategy: ImproverReference;
  fallback: { strategy: ImproverReference; reason: string } | null;
  inputDigest: string;
  plan: ContextSelectionPlan;
  applied: Array<{ id: string; contentDigest: string; index: boolean; inline: boolean; chars: number }>;
  omitted: number;
  sections: Array<{ name: string; chars: number; digest: string }>;
  createdAt: string;
}

/** By default keeps the index discoverable and loads, from the same candidate set, the short memories that fit whole. */
export function baselineContextSelection(input: ContextSelectionInput): ContextSelectionPlan {
  let indexChars = input.budget.indexHeaderChars;
  let inlineChars = 0;
  let indexItems = 0;
  let inlineItems = 0;
  const items: ContextSelectionPlan["items"] = [];
  const ranked = [...input.candidates].sort((left, right) =>
    right.matchedSelectors.filter((field) => field !== "when").length
      - left.matchedSelectors.filter((field) => field !== "when").length
      || (left.inlineChars ?? Number.MAX_SAFE_INTEGER) - (right.inlineChars ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id));
  for (const candidate of ranked) {
    const inline = candidate.kind === "memory" && candidate.inlineChars !== null
      && inlineItems < input.budget.inlineItems && inlineChars + candidate.inlineChars <= input.budget.inlineChars;
    const index = !inline && indexItems < input.budget.indexItems && indexChars + candidate.indexChars <= input.budget.indexChars;
    if (!index && !inline) continue;
    if (index) { indexChars += candidate.indexChars; indexItems += 1; }
    if (inline) { inlineChars += candidate.inlineChars!; inlineItems += 1; }
    items.push({ id: candidate.id, mode: inline ? "inline" : "index", reason: inline ? "Complete lesson fits the context budget; apply only when its condition holds." : "Full text exceeds the remaining automatic context budget; available on demand." });
  }
  return { schemaVersion: 1, items };
}

export function baselineContextSelector(): ImproverReference {
  return { kind: "builtin", id: "builtin-context-selector", contentDigest: improvementDigest(baselineContextSelection.toString()) };
}

function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("context selection fields differ from the contract");
}
function natural(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("context counts must be non-negative integers");
}
function text(value: unknown, max = 256): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new Error("invalid context selection text");
}
function digest(value: unknown): void {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error("invalid context selection digest");
}
function reference(value: unknown): void {
  object(value, ["kind", "id", "contentDigest"]);
  if (value.kind !== "builtin" && value.kind !== "artifact") throw new Error("unknown context strategy kind");
  text(value.id, 128); digest(value.contentDigest);
}
export function assertContextSelectionInput(value: unknown): asserts value is ContextSelectionInput {
  object(value, ["schemaVersion", "objective", "budget", "candidates"]);
  if (value.schemaVersion !== 1) throw new Error("unknown context selection schema");
  text(value.objective, 2_000);
  object(value.budget, ["indexChars", "indexItems", "inlineChars", "inlineItems", "indexHeaderChars"]);
  for (const count of Object.values(value.budget)) natural(count);
  if (!Array.isArray(value.candidates)) throw new Error("context candidates must be an array");
  const ids = new Set<string>();
  for (const item of value.candidates) {
    object(item, ["id", "contentDigest", "kind", "summary", "when", "indexChars", "inlineChars", "matchedSelectors"]);
    text(item.id, 128); digest(item.contentDigest); text(item.summary, 500); text(item.when, 1_000);
    if (ids.has(item.id)) throw new Error("duplicate context candidate");
    ids.add(item.id);
    if (item.kind !== "memory" && item.kind !== "skill") throw new Error("context candidate is not an experience");
    natural(item.indexChars);
    if (item.inlineChars !== null) natural(item.inlineChars);
    if (!Array.isArray(item.matchedSelectors) || item.matchedSelectors.some((field) => typeof field !== "string")) throw new Error("invalid matched selectors");
  }
}
export function assertContextSelectionPlan(value: unknown, input: ContextSelectionInput): asserts value is ContextSelectionPlan {
  assertContextSelectionInput(input);
  object(value, ["schemaVersion", "items"]);
  if (value.schemaVersion !== 1 || !Array.isArray(value.items) || value.items.length > input.candidates.length) throw new Error("invalid context selection plan");
  const available = new Map(input.candidates.map((item) => [item.id, item]));
  let indexChars = 0, inlineChars = 0, indexItems = 0, inlineItems = 0;
  for (const item of value.items) {
    object(item, ["id", "mode", "reason"]); text(item.id, 128); text(item.reason, 160);
    const candidate = available.get(item.id);
    if (!candidate) throw new Error("context selection contains an unknown or duplicate entry");
    available.delete(item.id);
    if (item.mode !== "index" && item.mode !== "inline" && item.mode !== "both") throw new Error("unknown context placement");
    if (item.mode !== "inline") { indexChars += candidate.indexChars; indexItems += 1; }
    if (item.mode !== "index") {
      if (candidate.kind !== "memory" || candidate.inlineChars === null) throw new Error("context entry cannot be loaded inline");
      inlineChars += candidate.inlineChars; inlineItems += 1;
    }
  }
  if (indexItems > 0) indexChars += input.budget.indexHeaderChars;
  if (indexChars > input.budget.indexChars || indexItems > input.budget.indexItems
    || inlineChars > input.budget.inlineChars || inlineItems > input.budget.inlineItems) throw new Error("context selection exceeds the host budget");
}
export function assertContextSelectionRecord(value: unknown): asserts value is ContextSelectionRecord {
  object(value, ["id", "sessionId", "requestId", "stepSeq", "snapshotSeq", "strategy", "fallback", "inputDigest", "plan", "applied", "omitted", "sections", "createdAt"]);
  text(value.id, 128); text(value.sessionId, 128); text(value.requestId); natural(value.stepSeq);
  if (value.snapshotSeq !== null) natural(value.snapshotSeq);
  reference(value.strategy); digest(value.inputDigest); natural(value.omitted);
  if (value.fallback !== null) { object(value.fallback, ["strategy", "reason"]); reference(value.fallback.strategy); text(value.fallback.reason, 500); }
  object(value.plan, ["schemaVersion", "items"]);
  if (value.plan.schemaVersion !== 1 || !Array.isArray(value.plan.items)) throw new Error("invalid recorded context plan");
  const planned = new Set<string>();
  for (const item of value.plan.items) {
    object(item, ["id", "mode", "reason"]); text(item.id, 128); text(item.reason, 160);
    if (!["index", "inline", "both"].includes(String(item.mode)) || planned.has(item.id)) throw new Error("invalid recorded context choice");
    planned.add(item.id);
  }
  if (!Array.isArray(value.applied) || !Array.isArray(value.sections)) throw new Error("invalid applied context entries");
  const seen = new Set<string>();
  for (const item of value.applied) {
    object(item, ["id", "contentDigest", "index", "inline", "chars"]); text(item.id, 128); digest(item.contentDigest); natural(item.chars);
    if (!planned.has(item.id) || seen.has(item.id) || typeof item.index !== "boolean" || typeof item.inline !== "boolean" || (!item.index && !item.inline)) throw new Error("applied context was not selected");
    seen.add(item.id);
    const choice = value.plan.items.find((choice) => choice.id === item.id)!;
    if ((item.index && choice.mode === "inline") || (item.inline && choice.mode === "index")) throw new Error("applied context placement differs");
  }
  for (const section of value.sections) {
    object(section, ["name", "chars", "digest"]);
    if (typeof section.name !== "string") throw new Error("invalid context section name");
    natural(section.chars); digest(section.digest);
  }
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) throw new Error("invalid context selection timestamp");
}
export function contextSelectionRecorded(record: ContextSelectionRecord): EvolutionEvent {
  assertContextSelectionRecord(record);
  return createEvolutionEvent({ entityKind: "context-selection", type: "context.selection-recorded", entityId: record.id,
    eventId: record.id, occurredAt: record.createdAt, actor: { kind: "system", id: "chopin-context-selector" },
    data: JSON.parse(JSON.stringify({ record })) as JsonObject });
}
