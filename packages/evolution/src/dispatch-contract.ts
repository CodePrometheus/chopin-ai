import type { CapabilityDispatch, CapabilityDispatchDecision, JsonObject } from "./types.js";

const identifier = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" };
export const DISPATCH_SCHEMA = {
  type: "object", additionalProperties: false, required: ["tools", "maxSteps"],
  properties: {
    tools: { type: "array", minItems: 1, maxItems: 16, uniqueItems: true, items: identifier },
    maxSteps: { type: "integer", minimum: 1, maximum: 8 },
  },
};
export const DISPATCH_STEP_SCHEMA = {
  type: "object", additionalProperties: false, required: ["tool", "arguments", "value"],
  properties: { tool: identifier, arguments: { type: "object" }, value: {} },
};
const call = { type: "object", additionalProperties: false, required: ["kind", "tool", "arguments"],
  properties: { kind: { const: "call" }, tool: identifier, arguments: { type: "object" } } };
const done = { type: "object", additionalProperties: false, required: ["kind", "value"],
  properties: { kind: { const: "done" }, value: {} } };
export const DISPATCH_DECISION_SCHEMA = { oneOf: [call, done] };

function record(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`${label} must be an object with exactly: ${keys.join(", ")}`);
  }
}

export function assertCapabilityDispatch(value: unknown, name: string): asserts value is CapabilityDispatch {
  record(value, DISPATCH_SCHEMA.required, "registerTool.dispatch");
  const limit = DISPATCH_SCHEMA.properties.maxSteps;
  if (!Number.isSafeInteger(value.maxSteps) || Number(value.maxSteps) < limit.minimum || Number(value.maxSteps) > limit.maximum) {
    throw new Error(`registerTool.dispatch.maxSteps must be an integer from ${limit.minimum} to ${limit.maximum}`);
  }
  const tools = value.tools; const bounds = DISPATCH_SCHEMA.properties.tools;
  if (!Array.isArray(tools) || tools.length < bounds.minItems || tools.length > bounds.maxItems || new Set(tools).size !== tools.length
    || tools.some(tool => typeof tool !== "string" || !new RegExp(identifier.pattern).test(tool) || tool === name || tool === "run_code")) {
    throw new Error("registerTool.dispatch.tools must list unique tool names, excluding itself and the code transport");
  }
}

export function assertDispatchDecision(value: unknown): asserts value is CapabilityDispatchDecision {
  const kind = value && typeof value === "object" && "kind" in value ? value.kind : undefined;
  if (kind !== "call" && kind !== "done") throw new Error("Dispatch decision.kind must be call or done");
  record(value, kind === "call" ? call.required : done.required, "dispatch decision");
  if (kind === "call" && (typeof value.tool !== "string" || !new RegExp(identifier.pattern).test(value.tool)
    || !value.arguments || typeof value.arguments !== "object" || Array.isArray(value.arguments))) {
    throw new Error("Call decisions require a tool name and an arguments object");
  }
}

export function dispatchInterface(tools: readonly string[]): JsonObject {
  const dispatch = { tools: [...tools], maxSteps: DISPATCH_SCHEMA.properties.maxSteps.maximum };
  assertCapabilityDispatch(dispatch, "");
  return { registerTool: { dispatch }, registrationSchema: DISPATCH_SCHEMA,
    execution: { steps: { type: "array", maxItems: dispatch.maxSteps, items: DISPATCH_STEP_SCHEMA } },
    outputSchemaMeaning: "Registered outputSchema validates done.value or a terminating child result, not the call/done decision.",
    returnSchema: DISPATCH_DECISION_SCHEMA };
}
