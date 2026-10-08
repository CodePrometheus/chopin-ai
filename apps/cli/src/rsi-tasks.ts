import type { CapabilityManifest, JsonObject, JsonValue } from "@chopin/evolution";
import type { TrialCase, TrialTask } from "./rsi-trial.js";

function manifest(id: string, runtimeVersion: string): CapabilityManifest {
  return { schemaVersion: 1, id, version: "1.0.0", kind: "tool", runtime: "dsh-plugin", intendedEffect: "advisory",
    summary: "Select valid evidence from structured runtime records.", entry: "index.mjs", trigger: { when: "selecting runtime evidence" },
    provides: { contexts: [], skills: [], guards: [], tools: ["learned_select"], services: [], workflows: [] },
    permissions: ["tools:register"], dependencies: [], conflicts: [], requires: { chopinPluginApi: "^1.0.0", dsh: runtimeVersion },
    lineage: { candidateIds: [`request-${id}`], proposalIds: [`proposal-${id}`] } };
}

const starter = `const manifest = __MANIFEST__;
export default { manifest, activate(ctx) {
  ctx.registerTool({name: 'learned_select', description: 'Select valid evidence.',
    inputSchema: {type: 'object', additionalProperties: true},
    outputSchema: {type: 'array', items: {type: 'string'}},
    async execute({arguments: input}) { return []; }
  });
} };
`;

function test(id: string, input: JsonObject, expected: JsonValue): TrialCase { return { id, input, expected }; }

/** Fixed tasks and holdout answers are sealed before the model is called; the generator never runs candidate code to derive answers. */
export function acceptanceTasks(runtimeVersion: string): [TrialTask, TrialTask] {
  const request = { type: "request", id: "request", origin: "user" };
  const call = (id: string, args: JsonObject = { path: "alpha" }, name = "read") => ({ type: "call", id, name, args });
  const result = (id: string, ok = true) => ({ type: "result", id, ok });
  const cases: TrialCase[] = [
    test("one-success", { events: [request, call("a"), result("a")] }, ["a"]),
    test("latest-failure", { events: [request, call("a"), result("a"), call("b"), result("b", false)] }, []),
    test("distinct-inputs", { events: [request, call("a"), result("a"), call("b", { path: "beta" }), result("b")] }, ["a", "b"]),
    test("no-owning-request", { events: [call("a"), result("a")] }, []),
    test("new-request", { events: [request, call("a"), result("a"), { ...request, id: "new" }] }, []),
    test("notice-does-not-reset", { events: [request, call("a"), result("a"), { type: "request", id: "notice", origin: "plugin" }] }, ["a"]),
    test("pending-invalidates-success", { events: [request, call("a"), result("a"), call("b")] }, []),
    test("old-result-arrives-late", { events: [request, call("a"), call("b"), result("b", false), result("a")] }, []),
    test("object-key-order", { events: [request, call("a", { x: 1, nested: { a: 1, b: 2 } }), result("a"), call("b", { nested: { b: 2, a: 1 }, x: 1 }), result("b")] }, ["b"]),
    test("array-order-matters", { events: [request, call("a", { values: [1, 2] }), result("a"), call("b", { values: [2, 1] }), result("b")] }, ["a", "b"]),
    test("unmatched-result", { events: [request, result("missing")] }, []),
    test("dispatch-invalidates-direct", { events: [request, call("a"), result("a"), { ...call("b"), type: "dispatch", ok: false }] }, []),
    test("dispatch-success", { events: [request, { ...call("a"), type: "dispatch", ok: true }] }, ["a"]),
    test("chronological-call-order", { events: [request, call("a"), call("b", { path: "beta" }), result("b"), result("a")] }, ["a", "b"]),
    test("replacement-order", { events: [request, call("a"), result("a"), call("b", { path: "beta" }), result("b"), call("c"), result("c")] }, ["b", "c"]),
    test("tool-name-is-part-of-identity", { events: [request, call("a"), result("a"), call("b", { path: "alpha" }, "inspect"), result("b", false)] }, ["a"]),
  ];
  const evidence: TrialTask = { id: "request-evidence", manifest: manifest("request-evidence", runtimeVersion), starter,
    description: "Implement learned_select({events}) returning valid successful call IDs in call order. Events are ordered. Only events after the latest request with origin=user belong to this request; without one return []. Plugin requests do not reset it. A call has type=call,id,name,args (JSON object); its result has type=result,id,ok (boolean). A dispatch has type=dispatch,id,name,args,ok and represents one completed nested tool call. Ignore unmatched results. Identity is name plus structurally equal args: object key order is irrelevant recursively, array order matters. Only the newest invocation per identity counts, even when pending or failed. A result of an older invocation must not restore it. Retain distinct identities. IDs are unique. Do not change the manifest or tool interface.",
    publicCases: cases.slice(0, 3), hiddenCases: cases.slice(3) };

  const version = (id: string, family: string, sequence: number, changes: JsonObject = {}) => ({
    id, family, version: `${sequence}.0.0`, digest: `content-${id}`, enabled: true, state: "active",
    approvalDigest: `content-${id}`, activeDigest: `content-${id}`, loadedDigest: `content-${id}`, loadedSequence: sequence,
    generation: "running", dependencies: [], ...changes,
  });
  const versions = (values: JsonObject[]) => ({ generation: "running", versions: values });
  const selections = [
    test("one-ready-version", versions([version("a", "alpha", 1)]), ["a"]),
    test("disabled-version", versions([version("a", "alpha", 1, { enabled: false })]), []),
    test("latest-loaded-wins", versions([version("a", "alpha", 1), version("b", "alpha", 2)]), ["b"]),
    test("approval-content-mismatch", versions([version("a", "alpha", 1, { approvalDigest: "other" })]), []),
    test("active-content-mismatch", versions([version("a", "alpha", 1, { activeDigest: "other" })]), []),
    test("loaded-content-mismatch", versions([version("a", "alpha", 1, { loadedDigest: "other" })]), []),
    test("old-process-load", versions([version("a", "alpha", 1, { generation: "stopped" })]), []),
    test("rollback-to-retired-version", versions([version("a", "alpha", 9, { version: "1.0.0", state: "retired" }), version("b", "alpha", 2, { version: "20.0.0" })]), ["a"]),
    test("quarantined-version", versions([version("a", "alpha", 1, { state: "quarantined" })]), []),
    test("missing-dependency", versions([version("a", "alpha", 1, { dependencies: ["absent"] })]), []),
    test("dependency-fixed-point", versions([version("a", "alpha", 1, { dependencies: ["beta"] }), version("b", "beta", 2, { dependencies: ["absent"] })]), []),
    test("present-dependency", versions([version("a", "alpha", 1, { dependencies: ["beta"] }), version("b", "beta", 2)]), ["a", "b"]),
    test("dependency-cycle-present", versions([version("a", "alpha", 1, { dependencies: ["beta"] }), version("b", "beta", 2, { dependencies: ["alpha"] })]), ["a", "b"]),
    test("input-order-independent", versions([version("b", "beta", 2), version("a", "alpha", 1)]), ["a", "b"]),
    test("no-fallback-after-selection", versions([version("a", "alpha", 1), version("b", "alpha", 2, { dependencies: ["absent"] })]), []),
    test("invalid-new-version-keeps-old", versions([version("a", "alpha", 1), version("b", "alpha", 2, { enabled: false })]), ["a"]),
  ];
  const activation: TrialTask = { id: "effective-versions", manifest: manifest("effective-versions", runtimeVersion), starter,
    description: "Implement learned_select({generation,versions}) returning IDs of effective versions sorted lexicographically. Each version has id,family,version,digest,enabled,state,approvalDigest,activeDigest,loadedDigest,loadedSequence,generation,dependencies (family names). First eligibility requires enabled=true, state active or retired, all three receipt digests equal digest, same generation as input, positive integer loadedSequence. Per family choose eligible version with greatest loadedSequence (sequences unique; version string does not decide, rollback can load old retired code). Then repeatedly remove selected versions whose dependency family is absent, until stable. Do not fall back to another version after dependency pruning. Present dependency cycles are allowed. Return IDs sorted ascending, regardless of input order. Do not change the manifest or tool interface.",
    publicCases: selections.slice(0, 3), hiddenCases: selections.slice(3) };
  return [evidence, activation];
}
