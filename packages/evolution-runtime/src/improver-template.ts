import { baselineImprovementPlan, baselineImprover, IMPROVER_TOOL } from "@chopin/evolution";
import type { CapabilityManifest, CapabilityFixtureSuite, ImprovementInput, JsonObject } from "@chopin/evolution";

export const IMPROVER_INPUT_SCHEMA: JsonObject = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "objective", "strategy", "budget", "work", "history"],
  properties: {
    schemaVersion: { type: "number", const: 1 }, objective: { type: "string", minLength: 1, maxLength: 4_000 },
    environment: { type: "object", additionalProperties: false,
      required: ["objective", "taskKinds", "tools", "sourceIds", "files"], properties: {
        objective: { type: "string", maxLength: 8_000 },
        ...Object.fromEntries(["taskKinds", "tools", "sourceIds", "files", "writable"].map(key => [key,
          { type: "array", maxItems: 256, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 1_000 } }])),
        budget: { type: "object", additionalProperties: false, required: ["limit", "remaining"], properties: {
          limit: { type: "integer", minimum: 0 }, remaining: { type: "integer", minimum: 0 },
        } },
      } },
    evidence: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false,
      required: ["digest", "value"], properties: { digest: { type: "string" }, value: {} } } },
    strategy: { type: "object", additionalProperties: false, required: ["kind", "id", "contentDigest"], properties: {
      kind: { type: "string", enum: ["builtin", "artifact"] }, id: { type: "string" }, contentDigest: { type: "string" },
    } },
    budget: { type: "object", additionalProperties: false, required: ["maxActions"], properties: {
      maxActions: { type: "integer", minimum: 0, maximum: 3 },
    } },
    work: { type: "array", maxItems: 50, items: { type: "object", additionalProperties: false,
      required: ["key", "action", "targetId", "detail", "evidenceUnits"], properties: {
        key: { type: "string" }, action: { type: "string" }, targetId: { type: "string" },
        detail: { type: "string", maxLength: 1_000 }, evidenceUnits: { type: "integer", minimum: 0 },
      } } },
    history: { type: "array", maxItems: 30, items: { type: "object", additionalProperties: false,
      required: ["artifactId", "state", "summary", "outcome"], properties: {
        artifactId: { type: "string" }, state: { type: "string" }, summary: { type: "string", maxLength: 500 },
        outcome: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false,
          required: ["windowId", "eligible", "activated", "taskPass", "taskFail", "recurrence", "falseBlock"], properties: {
            windowId: { type: "string" }, eligible: { type: "integer", minimum: 0 }, activated: { type: "integer", minimum: 0 },
            taskPass: { type: "integer", minimum: 0 }, taskFail: { type: "integer", minimum: 0 },
            recurrence: { type: "integer", minimum: 0 }, falseBlock: { type: "integer", minimum: 0 },
          } }] },
      } } },
  },
};

export const IMPROVER_OUTPUT_SCHEMA: JsonObject = {
  type: "object", additionalProperties: false, required: ["schemaVersion", "actions"],
  properties: {
    schemaVersion: { type: "number", const: 1 },
    actions: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false,
      required: ["key", "reason", "instructions"], properties: {
        key: { type: "string", minLength: 1, maxLength: 128 }, reason: { type: "string", minLength: 1, maxLength: 1_000 },
        instructions: { type: "string", minLength: 1, maxLength: 4_000 },
      } } },
  },
};

export function improverTemplate(manifest: CapabilityManifest): string {
  return [
    `const manifest = ${JSON.stringify(manifest, null, 2)};`,
    baselineImprovementPlan.toString(),
    "export default { manifest, activate(context) {",
    "  context.registerTool({",
    `    name: ${JSON.stringify(IMPROVER_TOOL)},`,
    "    description: 'Plan the next bounded capability improvement, including revisions of this strategy itself.',",
    `    inputSchema: ${JSON.stringify(IMPROVER_INPUT_SCHEMA)},`,
    `    outputSchema: ${JSON.stringify(IMPROVER_OUTPUT_SCHEMA)},`,
    "    async execute(execution) { return baselineImprovementPlan(execution.arguments); }",
    "  });",
    "} };",
  ].join("\n");
}

export function improverContractFixtures(): CapabilityFixtureSuite {
  const input: ImprovementInput = { schemaVersion: 1, objective: "Check the strategy contract.",
    strategy: baselineImprover(), budget: { maxActions: 1 }, work: [], history: [] };
  return { schemaVersion: 1, cases: [
    { id: "no-work", kind: "tool", name: IMPROVER_TOOL,
      input: { callId: "contract-empty", arguments: JSON.parse(JSON.stringify(input)) as JsonObject },
      expect: { equals: { schemaVersion: 1, actions: [] } } },
    { id: "no-budget", kind: "tool", name: IMPROVER_TOOL,
      input: { callId: "contract-budget", arguments: JSON.parse(JSON.stringify({ ...input, budget: { maxActions: 0 },
        work: [{ key: "self", action: "improve-strategy", targetId: "builtin-improver", detail: "Review the strategy.", evidenceUnits: 1 }] })) as JsonObject },
      expect: { equals: { schemaVersion: 1, actions: [] } } },
  ] };
}
