import { canonicalJson } from "./events.js";

export interface ExecutionContext {
  objective: string;
  taskKinds: string[];
  tools: string[];
  sourceIds: string[];
  files: string[];
  writable?: string[];
  budget?: { limit: number; remaining: number };
}

/** The environment only describes resources already provided; it cannot grant new permissions or raise quotas. */
export function assertExecutionContext(value: unknown): asserts value is ExecutionContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Execution context must be an object");
  const input = value as Record<string, unknown>;
  const required = ["objective", "taskKinds", "tools", "sourceIds", "files"];
  if (required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => ![...required, "writable", "budget"].includes(key))) {
    throw new Error("Execution context fields differ from its contract");
  }
  if (typeof input.objective !== "string" || input.objective.length > 8_000) throw new Error("Invalid execution objective");
  for (const key of [...required.slice(1), ...(input.writable === undefined ? [] : ["writable"])]) {
    const items = input[key];
    if (!Array.isArray(items) || items.length > 256 || new Set(items).size !== items.length
      || items.some(item => typeof item !== "string" || !item.trim() || item.length > 1_000)) {
      throw new Error("Invalid execution resource list");
    }
  }
  if (input.budget !== undefined) {
    const budget = input.budget as Record<string, unknown>;
    if (!budget || typeof budget !== "object" || Object.keys(budget).length !== 2
      || !Number.isSafeInteger(budget.limit) || !Number.isSafeInteger(budget.remaining)
      || Number(budget.limit) < 0 || Number(budget.remaining) < 0 || Number(budget.remaining) > Number(budget.limit)) {
      throw new Error("Invalid execution budget view");
    }
  }
  if (canonicalJson(input).length > 24_000) throw new Error("Execution context exceeds its budget");
}
