import { baselineContextSelection, CONTEXT_SELECTOR_TOOL } from "@chopin/evolution";
import type { CapabilityFixtureSuite, CapabilityManifest, ContextSelectionInput, JsonObject } from "@chopin/evolution";

const count = { type: "integer", minimum: 0 };
export const CONTEXT_SELECTION_INPUT_SCHEMA: JsonObject = {
  type: "object", additionalProperties: false, required: ["schemaVersion", "objective", "budget", "candidates"], properties: {
    schemaVersion: { const: 1, type: "integer" }, objective: { type: "string", maxLength: 2_000 },
    budget: { type: "object", additionalProperties: false, required: ["indexChars", "indexItems", "inlineChars", "inlineItems", "indexHeaderChars"],
      properties: { indexChars: count, indexItems: count, inlineChars: count, inlineItems: count, indexHeaderChars: count } },
    candidates: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["id", "contentDigest", "kind", "summary", "when", "indexChars", "inlineChars", "matchedSelectors"], properties: {
        id: { type: "string" }, contentDigest: { type: "string" }, kind: { type: "string", enum: ["memory", "skill"] },
        summary: { type: "string", maxLength: 500 }, when: { type: "string", maxLength: 1_000 }, indexChars: count,
        inlineChars: { anyOf: [count, { type: "null" }] }, matchedSelectors: { type: "array", items: { type: "string" } },
      } } },
  },
};
export const CONTEXT_SELECTION_OUTPUT_SCHEMA: JsonObject = {
  type: "object", additionalProperties: false, required: ["schemaVersion", "items"], properties: {
    schemaVersion: { const: 1, type: "integer" }, items: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["id", "mode", "reason"], properties: { id: { type: "string" },
        mode: { type: "string", enum: ["index", "inline", "both"] }, reason: { type: "string", description: "Non-empty selection reason, at most 160 characters." } } } },
  },
};
export function contextSelectorTemplate(manifest: CapabilityManifest): string {
  return [`const manifest = ${JSON.stringify(manifest, null, 2)};`, baselineContextSelection.toString(),
    "export default { manifest, activate(ctx) { ctx.registerTool({",
    `name: ${JSON.stringify(CONTEXT_SELECTOR_TOOL)}, description: 'Select eligible experience within fixed host budgets.',`,
    `inputSchema: ${JSON.stringify(CONTEXT_SELECTION_INPUT_SCHEMA)},`,
    `outputSchema: ${JSON.stringify(CONTEXT_SELECTION_OUTPUT_SCHEMA)},`,
    "async execute({ arguments: input }) { return baselineContextSelection(input); }",
    "}); } };"].join("\n");
}
export function contextSelectorFixtures(): CapabilityFixtureSuite {
  const input: ContextSelectionInput = { schemaVersion: 1, objective: "Select relevant experience.",
    budget: { indexChars: 0, indexItems: 0, inlineChars: 0, inlineItems: 0, indexHeaderChars: 20 }, candidates: [] };
  return { schemaVersion: 1, cases: [input, { ...input, candidates: [{ id: "entry", contentDigest: `sha256:${"a".repeat(64)}`,
    kind: "memory" as const, summary: "A candidate", when: "checking changes", indexChars: 50, inlineChars: 200, matchedSelectors: ["when"] }] }]
    .map((value, index) => ({ id: `empty-or-no-budget-${index}`, kind: "tool", name: CONTEXT_SELECTOR_TOOL,
      input: { callId: `contract-${index}`, arguments: JSON.parse(JSON.stringify(value)) }, expect: { equals: { schemaVersion: 1, items: [] } } })) };
}
