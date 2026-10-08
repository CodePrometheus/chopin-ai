import { baselineContextSelection, baselineImprovementPlan, CONTEXT_SELECTOR_TOOL, IMPROVER_TOOL,
  improvementDigest, assertCapabilityManifest, capabilitySurfaceDigest, dispatchInterface } from "@chopin/evolution";
import type { CapabilityFixtureSuite, CapabilityManifest, JsonObject } from "@chopin/evolution";
import { IMPROVER_INPUT_SCHEMA, IMPROVER_OUTPUT_SCHEMA, improverContractFixtures } from "@chopin/evolution-runtime/improver-template";
import { CONTEXT_SELECTION_INPUT_SCHEMA, CONTEXT_SELECTION_OUTPUT_SCHEMA, contextSelectorFixtures } from "@chopin/evolution-runtime/context-selector-template";
import type { StrategyCandidate } from "./rsi-engine.js";
import { PROJECT_CORE_TOOLS } from "./rsi-input.js";

export function executionInterfaceContract(): JsonObject {
  return { ...dispatchInterface(PROJECT_CORE_TOOLS), publicOutputSchemaKeywords: ["type", "oneOf", "properties", "required",
    "additionalProperties", "items", "enum", "const", "description", "title", "default", "examples"] };
}

export interface ProposalOrigin {
  experimentId: string;
  key: string;
  baseline: StrategyCandidate["reference"];
  parent: StrategyCandidate["reference"];
  target: StrategyCandidate["reference"];
  candidateId: string;
  proposalId: string;
  manifest: CapabilityManifest;
}

/** Experiment lineage only describes origin; a formal rollback target only references a deployed capability of the same kind. */
export function proposalOrigin(input: {
  experimentId: string; key: string; baseline: StrategyCandidate; parent: StrategyCandidate; target: StrategyCandidate;
  workspace: string; model: string; runtimeVersion: string;
}): ProposalOrigin {
  const scope = improvementDigest({ workspace: input.workspace, model: input.model }).slice(7, 23);
  const operation = improvementDigest({ experimentId: input.experimentId, key: input.key }).slice(7, 39);
  const id = `learned-harness-${scope}`;
  const previous = input.baseline.manifest;
  const supersedes = previous?.id === id && previous.kind === "plugin" ? {
    artifactId: input.baseline.reference.id, contentDigest: input.baseline.reference.contentDigest,
    surfaceDigest: capabilitySurfaceDigest(previous),
  } : undefined;
  const manifest: CapabilityManifest = {
    schemaVersion: 1, id, version: `1.0.0-r${operation}`, kind: "plugin", runtime: "dsh-plugin", intendedEffect: "advisory",
    summary: "Evolve task execution and the procedure that improves it.", entry: "index.mjs",
    trigger: { repos: [input.workspace], environments: [input.model], when: "executing and improving tasks in this project and model scope" },
    provides: { contexts: [`guidance-${scope}`], guards: [`protocol-${scope}`],
      tools: [IMPROVER_TOOL, CONTEXT_SELECTOR_TOOL, `learned_recovery_${scope}`, `learned_execution_${scope}`], skills: [], services: [], workflows: [] },
    permissions: ["system-prompt:context", "tools:guard", "tools:register", "tools:dispatch"], dependencies: [], conflicts: [],
    requires: { chopinPluginApi: "^1.1.0", dsh: input.runtimeVersion },
    lineage: { candidateIds: [`experiment-${operation}`], proposalIds: [`proposal-${operation}`],
      ...(supersedes ? { supersedes } : {}) },
  };
  assertCapabilityManifest(manifest);
  return { experimentId: input.experimentId, key: input.key, baseline: input.baseline.reference,
    parent: input.parent.reference, target: input.target.reference, candidateId: manifest.lineage.candidateIds[0]!,
    proposalId: manifest.lineage.proposalIds[0]!, manifest };
}

export function executionContractFixtures(manifest: CapabilityManifest): CapabilityFixtureSuite {
  const context = manifest.provides.contexts[0]!; const guard = manifest.provides.guards[0]!;
  const recovery = manifest.provides.tools.find(name => name !== IMPROVER_TOOL && name !== CONTEXT_SELECTOR_TOOL)!;
  const execution = manifest.provides.tools.find(name => name.startsWith("learned_execution_"));
  const environment = { objective: "Inspect the declared file", taskKinds: ["module-engineering"], tools: ["read"],
    sourceIds: [], files: ["input.txt"], writable: [], budget: { limit: 4, remaining: 0 } };
  return { schemaVersion: 1, cases: [...improverContractFixtures().cases, ...contextSelectorFixtures().cases,
    { id: "empty-guidance", kind: "context", name: context, input: { workspace: "", prompt: "" }, expect: { equals: "" } },
    { id: "bounded-guidance", kind: "context", name: context, input: { workspace: "project", prompt: environment.objective, environment }, expect: { maxChars: 2_000 } },
    { id: "valid-read", kind: "guard", name: guard,
      input: { toolName: "read", arguments: { file_path: "input.txt" }, successfulCalls: [] }, expect: { decision: null } },
    { id: "missing-path", kind: "guard", name: guard,
      input: { toolName: "write", arguments: {}, successfulCalls: [] }, expect: { decision: "A file path is required." } },
    { id: "admitted-read", kind: "guard", name: guard,
      input: { toolName: "read", arguments: { file_path: "input.txt" }, successfulCalls: [], environment }, expect: { decision: null } },
    { id: "empty-recovery", kind: "tool", name: recovery,
      input: { callId: "contract-empty", arguments: {} }, expect: { equals: {} } },
    ...(execution ? [{ id: "empty-execution", kind: "tool" as const, name: execution,
      input: { callId: "contract-execution", arguments: {}, steps: [] }, expect: { equals: { kind: "done", value: {} } } }] : []),
  ] };
}

export function executionTemplate(manifest: CapabilityManifest): string {
  const recovery = manifest.provides.tools.find(name => name !== IMPROVER_TOOL && name !== CONTEXT_SELECTOR_TOOL)!;
  const execution = manifest.provides.tools.find(name => name.startsWith("learned_execution_"));
  const tool = (name: string, description: string, input: JsonObject, output: JsonObject, execute: string) =>
    `context.registerTool({ name: ${JSON.stringify(name)}, description: ${JSON.stringify(description)}, inputSchema: ${JSON.stringify(input)}, outputSchema: ${JSON.stringify(output)}, async execute(execution) { ${execute} } });`;
  return [
    `const manifest = ${JSON.stringify(manifest)};`, baselineImprovementPlan.toString(), baselineContextSelection.toString(),
    "export default { manifest, activate(context) {",
    tool(IMPROVER_TOOL, "Plan a bounded improvement from supplied evidence.", IMPROVER_INPUT_SCHEMA, IMPROVER_OUTPUT_SCHEMA, "return baselineImprovementPlan(execution.arguments);"),
    tool(CONTEXT_SELECTOR_TOOL, "Select admitted context within the host budget.", CONTEXT_SELECTION_INPUT_SCHEMA, CONTEXT_SELECTION_OUTPUT_SCHEMA, "return baselineContextSelection(execution.arguments);"),
    tool(recovery, "Compute recovery advice from supplied structured tool outcomes; performs no external operations.",
      { type: "object", additionalProperties: true }, { type: "object", additionalProperties: true }, "return {};"),
    ...(execution ? [`context.registerTool({ name: ${JSON.stringify(execution)}, description: 'Execute a bounded procedure through the currently authorized tools.', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, dispatch: ${JSON.stringify((executionInterfaceContract().registerTool as JsonObject).dispatch)}, async execute(execution) { return { kind: 'done', value: {} }; } });`] : []),
    `context.registerContext({ name: ${JSON.stringify(manifest.provides.contexts[0])}, order: 100, render(request) { return ''; } });`,
    `context.registerGuard({ name: ${JSON.stringify(manifest.provides.guards[0])}, tools: ['read', 'write', 'edit'], evaluate(execution) {`,
    "  if (typeof execution.arguments.file_path !== 'string' || !execution.arguments.file_path.trim()) return 'A file path is required.';",
    "  return undefined; } });",
    "} };",
  ].join("\n");
}
