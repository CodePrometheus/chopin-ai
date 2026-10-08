import { beforeEach, describe, expect, it, vi } from "vitest";

const records = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const exists = (path: string) => records.has(path) || [...records.keys()].some(key => key.startsWith(`${path}/`));
  return { ...fs,
    readFile: async (path: string, ...args: unknown[]) => {
      if (!path.startsWith("virtual/")) return fs.readFile(path, ...args as [BufferEncoding]);
      if (!records.has(path)) throw missing(); return records.get(path)!;
    },
    mkdir: async (path: string) => { if (!path.startsWith("virtual/")) throw new Error("Unexpected disk write"); },
    access: async (path: string) => { if (!path.startsWith("virtual/")) return fs.access(path); if (!exists(path)) throw missing(); },
    realpath: async (path: string) => { if (!path.startsWith("virtual/")) return fs.realpath(path); if (!exists(path)) throw missing(); return path; },
    readdir: async (path: string) => {
      if (!path.startsWith("virtual/")) return fs.readdir(path);
      if (!exists(path)) throw missing();
      return [...new Set([...records.keys()].filter(key => key.startsWith(`${path}/`)).map(key => key.slice(path.length + 1).split("/")[0]!))];
    },
    link: async (from: string, to: string) => {
      if (!from.startsWith("virtual/") || !to.startsWith("virtual/")) throw new Error("Unexpected disk link");
      if (records.has(to)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      if (!records.has(from)) throw missing(); records.set(to, records.get(from)!);
    },
    mkdtemp: async () => { throw new Error("A completed trial must not create a new attempt"); },
    open: async (path: string, flag: string) => {
      if (!path.startsWith("virtual/")) throw new Error("Unexpected disk open");
      if (flag === "wx") {
        if (records.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        records.set(path, "");
      }
      if (!records.has(path)) throw missing();
      const bytes = Buffer.from(records.get(path)!); let cursor = 0;
      return { writeFile: async (text: string) => { records.set(path, text); }, sync: async () => {}, close: async () => {},
        stat: async () => ({ isFile: () => true }),
        read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
          const start = position ?? cursor; const end = Math.min(bytes.length, start + length);
          bytes.copy(buffer, offset, start, end); cursor = end; return { bytesRead: end - start };
        } };
    },
  };
});

import { assertImprovementInput, baselineImprover, improvementDigest, assertCapabilityDispatch, assertDispatchDecision } from "@chopin/evolution";
import type { JsonObject, JsonValue } from "@chopin/evolution";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools, { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";
import Llm, { ToolCallId, LlmAdapter, ReasoningEffortId, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import Agents from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import Sessions, { SessionId } from "@deepseek-ai/dsh-session";
import Projection from "@deepseek-ai/dsh-session-projection";
import { mountIsolatedCapability } from "@chopin/plugin-adapter/isolated";
import { RequestBudget } from "@chopin/evolution-runtime/request-budget";
import { allocateExperimentRequests, diagnosticGenerationLimit, improvementVerdict, minimumExperimentRequests, runExperiment } from "../../apps/cli/src/rsi-engine.js";
import { searchFeedback, selectSearchParent } from "../../apps/cli/src/rsi-search.js";
import { executeCapabilityTool } from "../../packages/plugin-adapter/src/dispatch.js";
import { assertPublicToolOutputs } from "../../packages/plugin-adapter/src/index.js";
import { executionEvidence } from "../../apps/cli/src/rsi-evidence.js";
import type { ExperimentPlan, ExperimentHooks, StrategyCandidate, TrialScore } from "../../apps/cli/src/rsi-engine.js";
import { failureReplay, FailureReplays, replayContract } from "../../apps/cli/src/rsi-replay.js";
import { assertProjectTaskPack, checkProject } from "../../apps/cli/src/rsi-project.js";
import type { ProjectCheck, ProjectTask } from "../../apps/cli/src/rsi-project.js";
import { assertTrialContext } from "../../apps/cli/src/rsi-context.js";
import type { TrialContextSnapshot } from "../../apps/cli/src/rsi-context.js";
import { executionTemplate, executionContractFixtures, executionInterfaceContract, proposalOrigin } from "../../apps/cli/src/rsi-capability.js";
import { measuredCompletion, runProjectSession, projectToolContracts } from "../../apps/cli/src/rsi-session.js";
import { SandboxedPlugin } from "@chopin/plugin-sandbox";
import { fileURLToPath } from "node:url";
import { improvementEvidence, projectEnvironment, projectEvidence } from "../../apps/cli/src/rsi-input.js";
import { projectCheckTool } from "../../apps/cli/src/rsi-check.js";

/** Executable code runs only inside the macOS OS sandbox; other platforms refuse it (covered by the refusal tests). */
const SANDBOXED = process.platform === "darwin";
import { applySourceEdits, assertGenerationFinish } from "../../apps/cli/src/rsi-generation.js";
import { historicalOutcome, readDevelopmentHistory, readUnopenedAudit } from "../../apps/cli/src/rsi-history.js";
import type { Agent } from "@deepseek-ai/dsh-agent";

const source = { sessionId: "session", requestId: "request" };
const initial: StrategyCandidate = { reference: baselineImprover(), source: "baseline" };
function task(id: string, split: "search" | "holdout"): ProjectTask {
  return { id, family: id, split, objective: `Repair ${id}`, files: { "input.txt": id }, writable: ["input.txt"], publicChecks: [],
    checks: [{ id: "output", kind: "text", path: "input.txt", expected: "valid" }] };
}
function context(): TrialContextSnapshot {
  return { input: { schemaVersion: 1, objective: "Select context", budget: { indexChars: 0, indexItems: 0,
    inlineChars: 0, inlineItems: 0, indexHeaderChars: 0 }, candidates: [] }, entries: [] };
}
function plan(): ExperimentPlan {
  return { schemaVersion: 3, id: "experiment", objective: "Improve the declared execution protocol", initial,
    tasks: [task("search", "search"), task("private", "holdout")], contexts: { search: context(), private: context() }, repetitions: 2, rounds: 2 };
}
function candidate(id: string): StrategyCandidate {
  return { source: id, reference: { kind: "artifact", id, contentDigest: improvementDigest(id) } };
}
function score(task: ProjectTask, passed: number, requests = 2): TrialScore {
  return { taskId: task.id, taskDigest: improvementDigest(task), sourceDigest: improvementDigest({ passed }),
    passed, total: task.checks.length, requests, completed: requests > 0,
    results: task.checks.map((check, index) => ({ id: check.id, passed: index < passed })), publicFeedback: { task: task.id, passed } };
}

beforeEach(() => { records.clear(); });

describe("sealed recursive improvement protocol", () => {
  it("retains interrupted output without feeding it into search or rerunning it on resume", async () => {
    const p = plan(); const solve = vi.fn(async (_strategy: StrategyCandidate, t: ProjectTask) => ({ ...score(t, 1), infrastructureFailures: 1 }));
    const propose = vi.fn(); const promote = vi.fn();
    const hooks: ExperimentHooks = { solve, propose, promote, reject: async () => {}, progress() {} };
    await expect(runExperiment(p, "virtual/interrupted-comparison", hooks, new AbortController().signal)).rejects.toThrow("infrastructure-affected");
    expect(records.has("virtual/interrupted-comparison/baseline-task-0-repeat-0.result.json")).toBe(true);
    await expect(runExperiment(p, "virtual/interrupted-comparison", hooks, new AbortController().signal, true)).rejects.toThrow("infrastructure-affected");
    expect(solve).toHaveBeenCalledTimes(1); expect(propose).not.toHaveBeenCalled(); expect(promote).not.toHaveBeenCalled();
  });

  it("publishes the same dispatch shape enforced at registration and execution", async () => {
    const contract = executionInterfaceContract();
    const declaration = (contract.registerTool as Record<string, unknown>).dispatch;
    expect(declaration).toEqual({ tools: ["read", "write", "edit", "project_check"], maxSteps: 8 });
    for (const [value, expected] of [[declaration, true], [true, false], [null, false], [{}, false],
      [{ tools: ["read"], maxSteps: 0 }, false], [{ tools: ["read"], maxSteps: 9 }, false],
      [{ tools: [], maxSteps: 1 }, false], [{ tools: ["read", "read"], maxSteps: 2 }, false],
      [{ tools: ["read"], maxSteps: 2, extra: true }, false]] as const) {
      let accepted = true; try { assertCapabilityDispatch(value, "learned_execution"); } catch { accepted = false; }
      expect(accepted).toBe(expected);
    }
    expect(() => assertCapabilityDispatch(true, "learned_execution")).toThrow("exactly: tools, maxSteps");
    const tools = await projectToolContracts(process.cwd());
    expect(tools.map(tool => tool.name)).toEqual(["read", "write", "edit", "project_check"]);
    const read = tools.find(tool => tool.name === "read")!;
    expect((read.inputSchema as JsonObject).required).toContain("file_path");
    expect(validateJsonSchemaValue(read.inputSchema as JsonSchemaNode, { file_path: "input.txt" })).toEqual([]);
    const check = tools.find(tool => tool.name === "project_check")!;
    expect((check.outputSchema as JsonObject).required).toEqual(["sourceDigest", "passed", "total", "results"]);
    const publicTool = { name: "learned_output", inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1 } } },
      outputSchema: { type: "object" } };
    const inspected = { inspection: { definitions: { tools: [publicTool] } } } as unknown as SandboxedPlugin;
    expect(() => assertPublicToolOutputs(inspected)).not.toThrow();
    publicTool.outputSchema = { type: "object", unknownKeyword: true } as typeof publicTool.outputSchema;
    expect(() => assertPublicToolOutputs(inspected)).toThrow("learned_output");
    for (const value of [{ kind: "done", value: {} }, { kind: "call", tool: "read", arguments: {} },
      { kind: "call", tool: "read" }, { kind: "done" }, { kind: "call", tool: "read", arguments: [] }]) {
      const schemaAccepts = validateJsonSchemaValue(contract.returnSchema as JsonSchemaNode, value).length === 0;
      let accepted = true; try { assertDispatchDecision(value); } catch { accepted = false; }
      expect(accepted).toBe(schemaAccepts);
    }
  });

  it.runIf(SANDBOXED)("executes sandboxed decisions through native guards, preserves completion and limits runaway procedures", async () => {
    const ctx = new Context();
    try {
      await ctx.plugin(SystemPrompt, {}); await ctx.plugin(Sessions); await ctx.plugin(Tools); await ctx.plugin(Llm);
      await ctx.plugin(Agents); await ctx.plugin(Projection); await ctx.plugin(AgentLoop, { agents: [] });
      const plugin = await SandboxedPlugin.inspect(fileURLToPath(new URL("./fixtures/dispatch-procedure.mjs", import.meta.url)), "dispatch-procedure", "1.0.0");
      let content = "input"; let reads = 0; let writes = 0; let checks = 0;
      ctx.tools.register({ name: "read", description: "Read state.", parameters: { type: "object" },
        output: { schema: { type: "object" }, render: () => [] }, async execute() { reads++; return { content }; } });
      ctx.tools.register({ name: "write", description: "Update state.", parameters: { type: "object" },
        output: { schema: { type: "object" }, render: () => [] }, async execute(args) { writes++; content = (args as { content: string }).content; return {}; } });
      const check = projectCheckTool(async () => { checks++; return { "input.txt": content }; },
        [{ id: "value", kind: "text", path: "input.txt", expected: "input:checked" }]);
      ctx.tools.register(check);
      ctx.tools.register({ name: "learned_procedure", description: "Compose native calls.", parameters: { type: "object" },
        output: { schema: { type: "object" }, render: () => [] },
        execute: (args, execution) => executeCapabilityTool(ctx, plugin, "learned_procedure", args as never, execution, {}) });
      const invoke = (args = {}) => ctx.tools.execute({ name: "learned_procedure", callId: ToolCallId("procedure"), arguments: args, signal: new AbortController().signal });
      expect(await invoke()).toMatchObject({ isError: false, concludesTurn: true });
      expect({ content, reads, writes, checks }).toEqual({ content: "input:checked", reads: 1, writes: 1, checks: 1 });
      content = "input";
      const release = ctx.tools.guard(execution => execution.name === "write" ? "Policy denied" : undefined);
      expect(await invoke()).toMatchObject({ isError: true });
      expect({ content, writes, checks }).toEqual({ content: "input", writes: 1, checks: 1 });
      release();
      const before = reads;
      expect(await invoke({ loop: true })).toMatchObject({ isError: true });
      expect(reads - before).toBe(3);
      expect(await invoke({ operation: "undeclared" })).toMatchObject({ isError: true });
      expect(writes).toBe(1);
      class ProtocolTransport extends LlmAdapter {
        calls = 0;
        async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
          const off = ReasoningEffortId("off");
          return { provider, id: model, name: model, reasoning: { efforts: [{ id: off, name: "Off" }], defaultEffort: off } };
        }
        async *stream(): AsyncIterable<StreamChunk> {
          this.calls++;
          if (this.calls === 1) {
            const id = ToolCallId("native-procedure");
            yield { type: "block-start", index: 0, blockType: "tool-call" };
            yield { type: "tool-call-delta", index: 0, id, name: "learned_procedure", argumentsDelta: "{}" };
            yield { type: "block-end", index: 0, block: { type: "tool-call", id, name: "learned_procedure", arguments: "{}" } };
            yield { type: "finish", reason: { kind: "tool-calls" } };
          } else yield { type: "finish", reason: { kind: "stop" } };
        }
      }
      const transport = new ProtocolTransport(); ctx.llm.registerAdapter(["protocol-capture"], transport);
      const handle = await ctx.agents.create({ sessionId: SessionId("dispatch-session"), agentOptions: { provider: "protocol-capture", model: "protocol" } });
      const ended = new Promise(resolve => { const release = ctx.on("session/event", (session, event) => {
        if (session.id === handle.agent.session.id && event.type === "turn/end") { release(); resolve(event.data.reason); }
      }); });
      handle.agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "Exercise the bounded procedure protocol." }] }));
      expect(await ended).toMatchObject({ kind: "completed" }); await handle.agent.whenIdle();
      expect(transport.calls).toBe(1);
      const events = handle.agent.session.snapshotEvents();
      expect(events.filter(event => event.type === "tool/ptc-dispatch-start").map(event => event.data.name)).toEqual(["read", "write", "project_check"]);
      expect(events.filter(event => event.type === "tool/ptc-dispatch")).toHaveLength(3);
    } finally { await ctx.fiber.dispose(); }
  });

  it("keeps experimental lineage selection independent from immediate deployment fitness", () => {
    const t = task("search", "search");
    const best = { strategy: candidate("best"), scores: [score(t, 1)], expansions: 20 };
    const exploratory = { strategy: candidate("exploratory"), scores: [score(t, 0)], expansions: 0 };
    expect(selectSearchParent([best, exploratory])).toBe(exploratory);
    expect(improvementVerdict(best.scores, exploratory.scores).accepted).toBe(false);
  });

  it("never upgrades a single-observation diagnostic into deployment evidence", async () => {
    const p = plan(); p.rounds = 1; p.repetitions = 1;
    p.audit = { sourceExperiment: "prior", target: initial, evidence: [{ evidence: true }] };
    const promote = vi.fn();
    const hooks: ExperimentHooks = { solve: async (strategy, task) => score(task, 1,
      strategy.reference.id === "builtin-improver" || strategy.reference.id.includes("control") ? 4 : 3),
      propose: async (_parent, _feedback, key) => ({ candidate: candidate(key) }), promote, reject: async () => {}, progress() {} };
    await expect(runExperiment(p, "virtual/not-repeated", hooks, new AbortController().signal)).rejects.toThrow("repeated controls");
    p.diagnostic = true;
    const allocation = allocateExperimentRequests(p, 34);
    expect(allocation.taskLimit).toBe(4);
    expect(diagnosticGenerationLimit(p, 34)).toBe(2);
    p.audit.generationLimit = diagnosticGenerationLimit(p, 32);
    expect(p.audit.generationLimit).toBe(1);
    const preserved = allocateExperimentRequests(p, 32);
    expect(preserved.taskLimit).toBe(4);
    expect(Object.values(preserved.phaseLimits).reduce((sum, count) => sum + count, 0)).toBe(29);
    const result = await runExperiment(p, "virtual/diagnostic", hooks, new AbortController().signal);
    expect(result).toMatchObject({ promoted: false, stopReason: "diagnostic-only", productivity: { accepted: false } });
    expect(promote).not.toHaveBeenCalled();
  });

  it("runs valid diagnostic branches without inventing scores for failed generations", async () => {
    const p = plan(); p.rounds = 1; p.repetitions = 1; p.diagnostic = true;
    p.audit = { sourceExperiment: "prior", target: initial, nominee: candidate("nominee"), evidence: [{ observed: true }],
      frozenChildren: [{ ...candidate("bad-child"), validationError: "SyntaxError" }, candidate("new-0"), candidate("old-1"), candidate("new-1")] };
    expect(allocateExperimentRequests(p, 24).taskLimit).toBe(4);
    expect(() => allocateExperimentRequests({ ...p, diagnostic: undefined }, 48)).toThrow("Incomplete frozen");
    const solved: string[] = []; const propose = vi.fn(); const promote = vi.fn();
    const result = await runExperiment(p, "virtual/partial-diagnostic", {
      solve: async (strategy, task) => { solved.push(strategy.reference.id); return score(task, 1, 3); },
      propose, promote, reject: async () => {}, progress() {},
    }, new AbortController().signal);
    expect(solved).toEqual(["builtin-improver", "nominee", "new-0", "old-1", "new-1"]);
    expect(propose).not.toHaveBeenCalled(); expect(promote).not.toHaveBeenCalled();
    expect(result).toMatchObject({ promoted: false, stopReason: "diagnostic-only", productivity: { accepted: false,
      generationFailures: [{ parent: "control", sample: 0, artifactId: "bad-child", reason: "SyntaxError" }] } });
    expect(result.productivity?.control).toHaveLength(1);
    expect(result.productivity?.candidate).toHaveLength(2);
  });

  it("recovers an unopened diagnostic cohort but rejects exposure through another run", async () => {
    const id = "00000000-0000-0000-0000-000000000001";
    const root = `virtual/cohorts/${id}`;
    const p = plan(); p.id = id; p.rounds = 1; p.diagnostic = true;
    p.audit = { sourceExperiment: "development", target: initial, evidence: [{ observed: true }] };
    const nominee = candidate("nominee");
    records.set(`${root}/run.json`, JSON.stringify({ id, plan: p }));
    records.set(`${root}/complete.json`, JSON.stringify({ promoted: false }));
    const record = (key: string, input: unknown, child: StrategyCandidate) => {
      const value = { candidate: child };
      records.set(`${root}/${key}-proposal.result.json`, JSON.stringify({ inputDigest: improvementDigest(input), valueDigest: improvementDigest(value), value }));
    };
    record("round-1", { parent: initial, target: initial, feedback: p.audit.evidence }, nominee);
    for (let sample = 0; sample < 2; sample++) for (const [label, parent] of [["control", initial], ["candidate", nominee]] as const) {
      const key = `productivity-${label}-${sample}`;
      record(key, { parent, target: initial, feedback: p.audit.evidence }, { ...candidate(key),
        ...(label === "control" && sample === 0 ? { validationError: "SyntaxError" } : {}) });
    }
    const recovered = await readUnopenedAudit(root);
    expect(recovered.audit.frozenChildren).toHaveLength(4);
    expect(recovered.audit.frozenChildren?.[0]?.validationError).toBe("SyntaxError");
    const derived = "virtual/cohorts/00000000-0000-0000-0000-000000000002";
    records.set(`${derived}/run.json`, JSON.stringify({ plan: p }));
    records.set(`${derived}/holdout-control-task-0-repeat-0.started.json`, "{}");
    await expect(readUnopenedAudit(root)).rejects.toThrow("already exposed");
    const fresh = [task("fresh-holdout", "holdout")];
    const reassessed = await readUnopenedAudit(root, fresh);
    expect(reassessed.audit).toMatchObject({ nominee, evaluationOnly: true, generationLimit: 2, evidence: p.audit.evidence });
    expect(reassessed.audit.frozenChildren).toBeUndefined();
    await expect(readUnopenedAudit(root, p.tasks)).rejects.toThrow("Previously declared");
    records.set(`${derived}/run.json`, JSON.stringify({ plan: { ...p, tasks: fresh } }));
    await expect(readUnopenedAudit(root, fresh)).rejects.toThrow("already exposed");
    records.set(`${derived}/run.json`, JSON.stringify({ plan: p }));
    const changed = JSON.parse(records.get(`${root}/round-1-proposal.result.json`)!);
    changed.value.candidate.source += "changed";
    records.set(`${root}/round-1-proposal.result.json`, JSON.stringify(changed));
    await expect(readUnopenedAudit(root, fresh)).rejects.toThrow("nomination is not valid");
  });

  it.runIf(SANDBOXED)("identifies the broken module instead of returning an unlocated parser error", async () => {
    const result = await checkProject({ "entry.mjs": "import { value } from './broken.mjs'; export function run() { return value; }",
      "broken.mjs": "export const value = };" }, [{ id: "syntax", kind: "module", path: "entry.mjs", export: "run", arguments: [], expected: 1 }]);
    expect(result.passed).toBe(0);
    expect(result.results[0]?.error).toContain("Module broken.mjs:");
  });

  it("binds ordered failure observations to task, strategy and changed-file versions", () => {
    const t = task("search", "search");
    const evidence = executionEvidence(t, initial.reference.contentDigest, [
      { type: "tool/call", data: { callId: "edit", name: "edit", arguments: JSON.stringify({ file_path: "input.txt", content: "private body" }) } },
      { type: "tool/result", data: { message: { role: "tool", toolCallId: "edit", isError: true, content: [{ type: "text", text: "Edit failed" }] } } },
    ] as never, { "input.txt": "changed" });
    expect(evidence).toMatchObject({ strategyDigest: initial.reference.contentDigest, taskDigest: improvementDigest(t),
      failures: [{ sequence: 0, tool: "edit", path: "input.txt", message: "Edit failed" }],
      files: [{ path: "input.txt", before: improvementDigest("search"), after: improvementDigest("changed") }] });
    expect(JSON.stringify(evidence)).not.toContain("private body");
  });

  it("records returned data separately from tool failure and attributes every nested result", () => {
    const t = task("search", "search"); t.writable.push("new.txt");
    const call = (callId: string, name: string, args = {}) => ({ type: "tool/call", data: { callId, name, arguments: JSON.stringify(args) } });
    const result = (toolCallId: string, value: unknown, isError = false) => ({ type: "tool/result",
      data: { message: { role: "tool", toolCallId, isError, content: [{ type: "text", text: JSON.stringify(value) }] } } });
    const nested = { rootCallId: "procedure", parentCallId: "procedure", subCallId: "nested", name: "write", arguments: { file_path: "new.txt", content: "private body" } };
    const evidence = executionEvidence(t, improvementDigest("strategy"), [
      call("empty", "learned_execution", { objective: "private objective" }),
      call("procedure", "learned_execution"),
      { type: "tool/ptc-dispatch-start", data: nested },
      { type: "tool/ptc-dispatch", data: { ...nested, isError: true, content: [{ type: "text", text: "Policy denied" }] } },
      result("empty", { ok: false, error: "Unsupported operation" }),
      result("procedure", "Policy denied", true),
      call("pending", "read"),
      call("large", "read"),
      result("large", { payload: "large private body".repeat(100) }),
    ] as never, t.files);
    expect(evidence.operations[0]).toMatchObject({ argumentKeys: ["objective"], status: "returned", nestedCalls: 0, result: { value: { ok: false, error: "Unsupported operation" } } });
    expect(evidence.operations[1]).toMatchObject({ status: "failed", nestedCalls: 1 });
    expect(evidence.operations[2]).toMatchObject({ status: "failed", nested: true, parentSequence: 1, path: "new.txt" });
    expect(evidence.operations[3]).toMatchObject({ status: "pending" });
    expect(evidence.operations[3]?.result).toBeUndefined();
    expect(evidence.operations[4]?.result).toMatchObject({ format: "json", kind: "object", keys: ["payload"] });
    expect(evidence.operations[4]?.result).not.toHaveProperty("value");
    expect(evidence.failures).toHaveLength(2);
    expect(JSON.stringify(evidence)).not.toContain("private body");
    expect(JSON.stringify(evidence)).not.toContain("private objective");
  });

  it("retains zero-request policy failures without inventing a completed task artifact", async () => {
    const p = plan(); p.id = "history";
    const t = p.tasks[0]!;
    const failed: TrialScore = { ...score(t, 0, 0), sourceDigest: improvementDigest(t.files),
      publicFeedback: { policyError: "Invalid improvement plan" } };
    records.set("virtual/history/run.json", JSON.stringify({ plan: p, workspace: "project", provider: "subscription", model: "fixed" }));
    records.set("virtual/history/complete.json", JSON.stringify({ rounds: [{ candidate: candidate("nominee") }] }));
    const resultPath = "virtual/history/round-1-task-0-repeat-0.result.json";
    const inputDigest = improvementDigest({ strategy: candidate("nominee"), task: t, context: p.contexts[t.id] });
    records.set(resultPath, JSON.stringify({ inputDigest, value: failed, valueDigest: improvementDigest(failed) }));
    const history = await readDevelopmentHistory("virtual/history", [task("new-independent", "holdout")]);
    expect(history.audit.evidence).toMatchObject([{ outcome: "task-failure", requests: 0,
      completed: false, project: { sources: [{ input: t.files["input.txt"] }] } }]);
    failed.sourceDigest = improvementDigest({ "input.txt": "unrecorded output" });
    records.set(resultPath, JSON.stringify({ inputDigest, value: failed, valueDigest: improvementDigest(failed) }));
    await expect(readDevelopmentHistory("virtual/history", [task("new-independent", "holdout")])).rejects.toThrow("contains task output");
  });

  it("applies non-overlapping edits to one immutable preimage and preserves provider failures", () => {
    const before = "const a = 1;\nconst b = 2;\nexport {a,b};";
    const edits = { edits: [{ startLine: 1, endLine: 1, text: "const a = 3;\nconst c = 4;" },
      { startLine: 3, endLine: 3, text: "export {a,b,c};" }] };
    expect(applySourceEdits(before, improvementDigest(before), edits)).toBe("const a = 3;\nconst c = 4;\nconst b = 2;\nexport {a,b,c};");
    expect(() => applySourceEdits(before, improvementDigest("different"), edits)).toThrow("preimage");
    expect(() => applySourceEdits(before, improvementDigest(before), { edits: [edits.edits[0], edits.edits[0]] })).toThrow("overlapping");
    expect(() => assertGenerationFinish(true, { kind: "error", failure: { code: "RATE_LIMIT", message: "Unavailable" } })).toThrow("Unavailable");
    expect(() => assertGenerationFinish(true, { kind: "max-tokens" })).toThrow("max-tokens");
  });
  it.runIf(SANDBOXED)("passes attributable evidence and the actual resource budget through isolation", async () => {
    const t = task("search", "search");
    const environment = projectEnvironment(t, context(), 6, 2);
    expect(environment.budget).toEqual({ limit: 6, remaining: 4 });
    expect(environment.sourceIds).toEqual([]);
    expect(environment.tools).not.toContain("experience_read");
    const evidence = improvementEvidence([{ checks: [{ id: "output", passed: false }], requests: 6 }]);
    const input = { schemaVersion: 1, objective: "Improve the failing procedure", strategy: baselineImprover(),
      budget: { maxActions: 1 }, work: [], history: [], evidence, environment };
    expect(() => assertImprovementInput(input)).not.toThrow();
    const plugin = await SandboxedPlugin.inspect(fileURLToPath(new URL("./fixtures/input-fidelity.mjs", import.meta.url)), "input-fidelity", "1.0.0");
    expect(await plugin.executeTool("learned_echo_input", { callId: "execution-view", arguments: input as unknown as JsonObject, environment })).toEqual({ arguments: input, environment });
    expect(JSON.parse(plugin.renderContext("inspect-input", { workspace: "project", prompt: t.objective, environment }))).toEqual(environment);
    evidence[0]!.value = { checks: [{ id: "output", passed: true }] };
    expect(() => assertImprovementInput(input)).toThrow("content changed");
    const proof = projectEvidence(t, { "input.txt": "actual output" });
    expect(proof.sources[0]).toMatchObject({ input: "search", output: "actual output", writable: true });
    expect(JSON.stringify(proof)).not.toContain('"expected"');
  });

  it.runIf(SANDBOXED)("uses the owning agent's live tools in isolated guards and public tools", async () => {
    const ctx = new Context();
    try {
      await ctx.plugin(SystemPrompt, {}); await ctx.plugin(Sessions); await ctx.plugin(Tools); await ctx.plugin(Llm);
      await ctx.plugin(Agents); await ctx.plugin(Projection); await ctx.plugin(AgentLoop, { agents: [] });
      const plugin = await SandboxedPlugin.inspect(fileURLToPath(new URL("./fixtures/input-fidelity.mjs", import.meta.url)), "input-fidelity", "1.0.0");
      const registerRead = (scope: Context) => scope.tools.register({ name: "read", description: "Read declared input.",
        parameters: { type: "object" }, output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
        async execute() { return "declared input"; } });
      const owner = await ctx.agents.create({ sessionId: SessionId("catalog-owner"), setup: (scope, agent) => {
        registerRead(scope);
        scope.effect(() => mountIsolatedCapability(scope, agent, plugin, "project", "Inspect the input",
          () => ({ objective: "Inspect the input", taskKinds: [], tools: ["unavailable"], sourceIds: [], files: [] })));
      } });
      const sibling = await ctx.agents.create({ sessionId: SessionId("catalog-sibling"), setup: scope => { registerRead(scope); } });
      expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain("read");
      const invoke = (agent: Agent, name: string) => ctx.tools.execute({ agent, name, callId: ToolCallId(`call-${name}`),
        arguments: {}, signal: new AbortController().signal });
      expect(await invoke(owner.agent, "read")).toMatchObject({ isError: false });
      const echoed = await invoke(owner.agent, "learned_echo_input");
      expect(echoed.isError).toBe(false);
      expect(JSON.stringify(echoed)).toContain('learned_echo_input');
      expect(JSON.stringify(echoed)).not.toContain('unavailable');
      expect(ctx.tools.schemas(sibling.agent).map(tool => tool.name)).toEqual(["read"]);
      expect(await invoke(sibling.agent, "learned_echo_input")).toMatchObject({ isError: true });
      const release = owner.agent.ctx.tools.register({ name: "late_tool", description: "Late capability.", parameters: { type: "object" },
        output: { schema: { type: "string" }, render: () => [] }, async execute() { return "late"; } });
      expect(JSON.stringify(await invoke(owner.agent, "learned_echo_input"))).toContain('late_tool');
      release();
      expect(JSON.stringify(await invoke(owner.agent, "learned_echo_input"))).not.toContain('late_tool');
    } finally { await ctx.fiber.dispose(); }
  });

  it("concludes only a successful native submission, never a failed or policy-blocked check", async () => {
    const ctx = new Context();
    let content = "bad";
    try {
      await ctx.plugin(SystemPrompt, {}); await ctx.plugin(Tools);
      ctx.tools.register(projectCheckTool(async () => ({ "input.txt": content }),
        [{ id: "content", kind: "text", path: "input.txt", expected: "ready" }]));
      const execute = (finish: boolean) => ctx.tools.execute({ callId: ToolCallId("submission"), name: "project_check",
        arguments: { finish }, signal: new AbortController().signal });
      expect(await execute(true)).toMatchObject({ isError: true });
      content = "ready";
      expect((await execute(false)).concludesTurn).toBeUndefined();
      expect(await execute(true)).toMatchObject({ isError: false, concludesTurn: true });
      ctx.tools.guard(() => "Policy denied");
      const denied = await execute(true);
      expect(denied.isError).toBe(true); expect(denied.concludesTurn).toBeUndefined();
    } finally { await ctx.fiber.dispose(); }
  });
  it("never converts a transport failure into a candidate quality score", () => {
    expect(() => measuredCompletion({ kind: "error", error: { message: "fetch failed", code: "TRANSPORT" } })).toThrow("fetch failed");
    expect(() => measuredCompletion({ kind: "error", error: { message: "token expired", code: "AUTH" } })).toThrow("token expired");
    expect(() => measuredCompletion({ kind: "interrupted" })).toThrow("interrupted");
    expect(measuredCompletion({ kind: "completed" })).toBe(true);
    expect(measuredCompletion({ kind: "error", error: { message: "limit", code: "TASK_BUDGET_EXHAUSTED" } })).toBe(false);
    const t = task("source", "search");
    const interrupted = { ...score(t, 0), completed: false, publicFeedback: { completion: "error",
      terminal: JSON.stringify({ kind: "error", error: { code: "TRANSPORT" } }) } };
    expect(historicalOutcome(interrupted)).toBe("infrastructure");
    interrupted.publicFeedback.terminal = JSON.stringify({ kind: "error", error: { code: "TASK_BUDGET_EXHAUSTED" } });
    expect(historicalOutcome(interrupted)).toBe("task-failure");
  });
  it("rejects local regressions, zero-work savings and mismatched measurements", () => {
    const t = task("search", "search");
    expect(improvementVerdict([score(t, 1, 5)], [score(t, 1, 4)]).accepted).toBe(true);
    expect(improvementVerdict([score(t, 1, 5)], [score(t, 0, 1)]).accepted).toBe(false);
    expect(improvementVerdict([score(t, 0, 0)], [score(t, 0, 0)]).accepted).toBe(false);
    expect(improvementVerdict([score(t, 0, 5)], [score(t, 0, 1)]).accepted).toBe(false);
    // Repeated controls set the noise band: the candidate's worst run must beat the baseline's best run on some task.
    expect(improvementVerdict([score(t, 0), score(t, 1)], [score(t, 1), score(t, 1)]).accepted).toBe(false);
    expect(improvementVerdict([score(t, 0), score(t, 0)], [score(t, 1), score(t, 1)]).accepted).toBe(true);
    expect(() => improvementVerdict([score(t, 1)], [score(t, 1, 0)])).toThrow();
    expect(() => improvementVerdict([score(t, 1)], [{ ...score(t, 1), taskDigest: improvementDigest("changed") }])).toThrow();
  });

  it("rejects loss of a passed check even when total correctness increases", () => {
    const t = task("search", "search");
    t.checks = ["retained", "new-a", "new-b"].map(id => ({ ...t.checks[0]!, id }));
    const before = score(t, 1); const after = score(t, 2);
    after.results = [{ id: "retained", passed: false }, { id: "new-a", passed: true }, { id: "new-b", passed: true }];
    expect(improvementVerdict([before], [after])).toMatchObject({ accepted: false, reason: expect.stringContaining("previously passed") });
    after.results[0]!.passed = true; after.results[2]!.passed = false;
    expect(improvementVerdict([before], [after]).accepted).toBe(true);
    expect(improvementVerdict([before], [{ ...after, completed: false, passed: 0 }]).accepted).toBe(false);
    const partial = { ...before, completed: false, passed: 0 };
    const lost = { ...after, results: after.results.map(item => ({ ...item, passed: item.id !== "retained" })) };
    expect(improvementVerdict([partial], [lost]).accepted).toBe(false);
    expect(() => improvementVerdict([before], [{ ...after, results: after.results.slice(1) }])).toThrow("check outcomes");
  });

  it("keeps complementary rejected candidates available without using private tasks", () => {
    const t = task("search", "search");
    const current = { strategy: candidate("current"), scores: [score(t, 0)] };
    const complementary = { strategy: candidate("specialist"), scores: [score(t, 1)] };
    const feedback = searchFeedback(current, [current, complementary]);
    expect(feedback).toHaveLength(2);
    expect(feedback[1]).toMatchObject({ source: "specialist", complementaryPasses: [expect.stringContaining(":output")] });
    complementary.strategy.source = "x".repeat(13_000);
    expect(feedback[0]).toMatchObject({ kind: "current-search" });
    expect(searchFeedback(current, [complementary])[1]).toHaveProperty("source", complementary.strategy.source);
    complementary.strategy.source = "x".repeat(24_000);
    expect(searchFeedback(current, [complementary])[1]).toHaveProperty("sourceOmitted");
    complementary.strategy.source = '"\\\n'.repeat(3_000);
    expect(JSON.stringify(searchFeedback(current, [complementary])).length).toBeLessThanOrEqual(24_000);
  });

  it("reserves independent verification even when search consumes its complete allocation", async () => {
    const allocation = allocateExperimentRequests(plan(), 120);
    expect(allocation.taskLimit).toBe(6);
    expect(allocation.confirmationReserve).toBe(80);
    const identity = { runId: "reserved", provider: "provider", model: "model", maxRequests: 120, phaseLimits: allocation.phaseLimits };
    const root = new RequestBudget("virtual/reserved", identity); await root.initialize();
    await expect(root.reserve("provider", "model")).rejects.toThrow("allocated phase");
    for (const [id, limit] of Object.entries(allocation.phaseLimits).filter(([id]) => id.startsWith("round-") || id.startsWith("baseline-"))) {
      const phase = new RequestBudget(root.directory, identity, { id, limit }); await phase.initialize();
      await Promise.all(Array.from({ length: limit }, () => phase.reserve("provider", "model")));
      await expect(phase.reserve("provider", "model")).rejects.toThrow("phase budget");
    }
    expect((await root.status()).remaining).toBeGreaterThanOrEqual(allocation.confirmationReserve);
    expect(() => new RequestBudget(root.directory, identity, { id: "rogue", limit: 1 })).toThrow("sealed allocation");
    const id = "holdout-control-task-0-repeat-0";
    const check = new RequestBudget(root.directory, identity, { id, limit: allocation.taskLimit }); await check.initialize();
    expect((await check.reserve("provider", "model")).phase).toBe(id);
  });

  // Scoring is a scheduling fixture; it aborts at the holdout acceptance entry and produces no model benefit or promotion conclusion.
  it("executes the accepted parent next, but both productivity probes share one target and no private evidence", async () => {
    const p = plan(); const first = candidate("first");
    const calls: Array<{ parent: string; target: string; key: string; feedback: string }> = [];
    const promote = vi.fn();
    const hooks: ExperimentHooks = {
      solve: async (strategy, task) => {
        if (task.split === "holdout") throw new Error("inspection-boundary");
        return score(task, strategy === initial ? 0 : 1);
      },
      propose: async (parent, feedback, key, _signal, target = parent) => {
        calls.push({ parent: parent.reference.id, target: target.reference.id, key, feedback: JSON.stringify(feedback) });
        return { candidate: key === "round-1" ? first : key === "round-2" ? null : candidate(key) };
      }, reject: async () => {}, promote, progress() {},
    };
    await expect(runExperiment(p, "virtual/run", hooks, new AbortController().signal)).rejects.toThrow("inspection-boundary");
    expect(calls.map(call => [call.key, call.parent, call.target])).toEqual([
      ["round-1", initial.reference.id, initial.reference.id], ["round-2", "first", "first"],
      ["productivity-control-0", initial.reference.id, initial.reference.id], ["productivity-candidate-0", "first", initial.reference.id],
      ["productivity-control-1", initial.reference.id, initial.reference.id], ["productivity-candidate-1", "first", initial.reference.id],
    ]);
    expect(calls.at(-1)!.feedback).toBe(calls.at(-2)!.feedback);
    expect(calls.every(call => !call.feedback.includes("private"))).toBe(true);
    expect(promote).not.toHaveBeenCalled();
    expect(p.initial).toBe(initial);
    expect(minimumExperimentRequests(p)).toBe(30);
  });

  it("does not promote a better executor when its descendants do not improve", async () => {
    const p = plan(); p.rounds = 1;
    const best = candidate("best"); const promote = vi.fn();
    const result = await runExperiment(p, "virtual/productivity", {
      solve: async (strategy, task) => score(task, strategy === initial ? 0 : 1),
      propose: async (_parent, _feedback, key) => ({ candidate: key === "round-1" ? best : candidate(key) }),
      reject: async () => {}, promote, progress() {},
    }, new AbortController().signal);
    expect(result.stopReason).toBe("productivity-unproven");
    expect(result.productivity?.accepted).toBe(false);
    expect(result.productivity?.controlChildren).toHaveLength(2);
    expect(result.productivity?.candidateChildren).toHaveLength(2);
    expect(result.strategy).toBe(initial);
    expect(promote).not.toHaveBeenCalled();
  });

  it("runs both descendant pairs in a full audit without relaxing either promotion gate", async () => {
    const p = plan(); p.rounds = 1;
    p.audit = { sourceExperiment: "previous", target: candidate("prior"), evidence: [{ kind: "historical-development", checks: [] }] };
    const allocation = allocateExperimentRequests(p, 60);
    expect(allocation.taskLimit).toBe(4);
    expect(Object.keys(allocation.phaseLimits).some(key => key.startsWith("baseline-"))).toBe(false);
    expect(Object.values(allocation.phaseLimits).reduce((sum, limit) => sum + limit, 0)).toBe(58);
    const solved: string[] = []; const proposals: string[] = []; const promote = vi.fn();
    const result = await runExperiment(p, "virtual/full-audit", {
      solve: async (_strategy, task, key) => { solved.push(key); expect(proposals).toHaveLength(5); return score(task, 1, 3); },
      propose: async (_parent, feedback, key, _signal, target) => {
        proposals.push(key); expect(feedback).toEqual(p.audit!.evidence);
        if (key === "round-1") expect(target).toBe(p.audit!.target);
        return { candidate: candidate(key) };
      }, reject: async () => {}, promote, progress() {},
    }, new AbortController().signal);
    expect(solved).toHaveLength(12);
    expect(solved.filter(key => key.startsWith("productivity-"))).toHaveLength(8);
    expect(result.productivity?.accepted).toBe(false);
    expect(result.promoted).toBe(false); expect(promote).not.toHaveBeenCalled();
  });

  it("reuses a frozen nomination while reserving identical task caps for all six programs", async () => {
    const p = plan(); p.rounds = 1;
    p.audit = { sourceExperiment: "prior", target: initial, nominee: candidate("nominee"), evidence: [{ evidence: true }], generationLimit: 1 };
    const allocation = allocateExperimentRequests(p, 52);
    expect(allocation.taskLimit).toBe(4);
    expect(allocation.phaseLimits["round-1-proposal"]).toBeUndefined();
    expect(Object.values(allocation.phaseLimits).reduce((a,b) => a+b,0)).toBe(52);
    const proposals: string[] = [];
    const outcome = await runExperiment(p, "virtual/frozen-nomination", {
      solve: async (_strategy, task) => score(task, 1, 3),
      propose: async (_parent, _feedback, key) => { proposals.push(key); return { candidate: candidate(key) }; },
      reject: async () => {}, promote: async () => { throw new Error("No measured gain"); }, progress() {},
    }, new AbortController().signal);
    expect(proposals).toHaveLength(4); expect(proposals).not.toContain("round-1");
    expect(outcome.productivity?.control).toHaveLength(4); expect(outcome.productivity?.candidate).toHaveLength(4);
    expect(outcome.promoted).toBe(false);
  });

  it("rechecks all frozen programs without regenerating them or restoring deployment authority", async () => {
    const p = plan(); p.rounds = 1;
    p.audit = { sourceExperiment: "prior", target: initial, nominee: candidate("nominee"), evidence: [{ evidence: true }],
      frozenChildren: [candidate("old-0"), candidate("new-0"), candidate("old-1"), candidate("new-1")] };
    const allocation = allocateExperimentRequests(p, 48);
    expect(allocation.taskLimit).toBe(4);
    expect(Object.keys(allocation.phaseLimits).some(key => key.endsWith("-proposal"))).toBe(false);
    const propose = vi.fn(); const promote = vi.fn(); const calls: string[] = [];
    const result = await runExperiment(p, "virtual/recheck", {
      solve: async (strategy, task) => { calls.push(strategy.reference.id); return score(task, 1,
        strategy.reference.id === "nominee" || strategy.reference.id.startsWith("new-") ? 3 : 4); },
      propose, promote, reject: async () => {}, progress() {},
    }, new AbortController().signal);
    expect(calls).toHaveLength(12); expect(new Set(calls).size).toBe(6);
    expect(propose).not.toHaveBeenCalled(); expect(promote).not.toHaveBeenCalled();
    expect(result).toMatchObject({ promoted: false, stopReason: "archive-verified", productivity: { accepted: true } });
    p.audit.frozenChildren!.pop();
    expect(() => allocateExperimentRequests(p, 48)).toThrow("Incomplete frozen");
  });

  it("regenerates balanced descendants for a reused nomination without granting deployment authority", async () => {
    const p = plan(); p.rounds = 1;
    p.audit = { sourceExperiment: "prior", target: initial, nominee: candidate("nominee"), evidence: [{ observed: true }], evaluationOnly: true };
    const allocation = allocateExperimentRequests(p, 56);
    expect(allocation.taskLimit).toBe(4);
    expect(Object.values(allocation.phaseLimits).reduce((a,b) => a+b,0)).toBe(56);
    const proposals: string[] = []; const promote = vi.fn();
    const result = await runExperiment(p, "virtual/reassess", {
      solve: async (strategy, t) => score(t, 1, strategy.reference.id === "nominee" || strategy.reference.id.startsWith("productivity-candidate-") ? 3 : 4),
      propose: async (_parent, feedback, key, _signal, target) => {
        proposals.push(key); expect(feedback).toEqual(p.audit!.evidence); expect(target).toBe(initial);
        return { candidate: candidate(key) };
      },
      promote, reject: async () => {}, progress() {},
    }, new AbortController().signal);
    expect(proposals).toEqual(["productivity-control-0", "productivity-candidate-0", "productivity-control-1", "productivity-candidate-1"]);
    expect(result).toMatchObject({ promoted: false, stopReason: "archive-verified", productivity: { accepted: true } });
    expect(promote).not.toHaveBeenCalled();
  });

  it("retains trial request accounting across reconstruction of the budget", async () => {
    const identity = { runId: "run", provider: "provider", model: "model", maxRequests: 24 };
    const first = new RequestBudget("virtual/budget", identity, { id: "trial", limit: 2 });
    await first.initialize();
    await first.reserve("provider", "model");
    const resumed = new RequestBudget("virtual/budget", identity, { id: "trial", limit: 2 });
    await resumed.initialize();
    expect((await resumed.status()).phaseUsed).toBe(1);
    await resumed.reserve("provider", "model");
    await expect(resumed.reserve("provider", "model")).rejects.toThrow("phase budget");
    expect((await resumed.status()).used).toBe(2);
  });

  it("reuses a completed project result without creating a new attempt", async () => {
    const options = { directory: "virtual/completed", task: task("search", "search"), context: context(),
      route: { provider: "provider", model: "model" },
      strategyDigest: improvementDigest("strategy"), instructionsDigest: improvementDigest("instructions"),
      previousRequests: 3, requestLimit: 6, budget: { phase: { limit: 6 } }, logicalWorkspace: "project", signal: new AbortController().signal } as Parameters<typeof runProjectSession>[0];
    const { task: t, route, context: c, strategyDigest, instructionsDigest } = options;
    const identity = improvementDigest({ protocol: 4, task: t, route, context: c, strategyDigest, instructionsDigest,
      logicalWorkspace: options.logicalWorkspace, requestLimit: options.requestLimit });
    const files = { "input.txt": "valid" };
    const result = { passed: 1, total: 1, requests: 3, sourceDigest: improvementDigest(files), results: [{ id: "output", passed: true }],
      publicFeedback: { completion: "completed" }, completion: { kind: "completed" }, sessionId: "finished" };
    records.set("virtual/completed/completed.json", JSON.stringify({ identity, resultDigest: improvementDigest(result), attempt: "attempt-retained", result }));
    records.set("virtual/completed/attempt-retained/output.json", JSON.stringify({ files }));
    expect(await runProjectSession(options)).toEqual(result);
    const failed = { ...result, passed: 0, publicFeedback: { completion: "error" },
      completion: { kind: "error", error: { code: "TRANSPORT", message: "fetch failed" } } };
    records.set("virtual/completed/completed.json", JSON.stringify({ identity, resultDigest: improvementDigest(failed), attempt: "attempt-retained", result: failed }));
    await expect(runProjectSession(options)).rejects.toThrow("fetch failed");
    records.set("virtual/completed/completed.json", JSON.stringify({ identity, resultDigest: improvementDigest(result), attempt: "attempt-retained", result }));
    options.strategyDigest = improvementDigest("different");
    await expect(runProjectSession(options)).rejects.toThrow("inputs changed");
    options.strategyDigest = strategyDigest;
    records.set("virtual/completed/attempt-retained/output.json", JSON.stringify({ files: { "input.txt": "corrupted" } }));
    await expect(runProjectSession(options)).rejects.toThrow("verification");
    expect(records.size).toBe(2);
  });
});

describe("failure replay and executable surfaces", () => {
  it.runIf(SANDBOXED)("preserves own data properties in actual isolated tool, guard and context invocations", async () => {
    const plugin = await SandboxedPlugin.inspect(fileURLToPath(new URL("./fixtures/input-fidelity.mjs", import.meta.url)), "input-fidelity", "1.0.0");
    const value = JSON.parse('{"__proto__":{"admin":true},"constructor":"literal"}');
    expect(await plugin.executeTool("learned_echo_input", { callId: "input-fidelity", arguments: value })).toEqual(value);
    expect(await plugin.evaluateGuard("check-input", { toolName: "learned_echo_input", arguments: value, successfulCalls: [] })).toBe("own data");
    expect(await plugin.renderContext("inspect-input", { workspace: "", prompt: "", ...value })).toBe("own data");
  });
  it.runIf(SANDBOXED)("preserves special own keys across the independent checker input boundary", async () => {
    const value = JSON.parse('{"__proto__":"kept","constructor":"value","nested":{"__proto__":{"admin":true}}}');
    const files = { "probe.mjs": "export function inspect(value) { return {keys:Object.keys(value).sort(),nested:Object.keys(value.nested),inherited:value.nested.admin??null}; }" };
    const result = await checkProject(files, [{ id: "input-fidelity", kind: "module", path: "probe.mjs", export: "inspect", arguments: [value],
      expected: { keys: ["__proto__", "constructor", "nested"], nested: ["__proto__"], inherited: null } }]);
    expect(result.passed).toBe(1);
  });
  it("captures actual failed output against the declared checks and preserves the pre-task input", async () => {
    const search = { ...task("search", "search"), capture: true };
    const pack = { schemaVersion: 1 as const, tasks: [search, task("private", "holdout")] };
    const workspace = "virtual/project";
    records.set(`${workspace}/.agents/rsi/tasks.json`, JSON.stringify(pack));
    records.set(`${workspace}/input.txt`, "before");
    const session = { id: source.sessionId, header: { cwd: workspace }, snapshotEvents: () => [{ type: "user/message", time: 0,
      data: { id: source.requestId, source: { kind: "user" }, content: [{ type: "text", text: "Perform the declared task." }] } }] };
    const replays = new FailureReplays("virtual/replays");
    await replays.begin({ session } as unknown as Agent);
    records.set(`${workspace}/input.txt`, "failed-output");
    expect(await replays.finish(session as unknown as Agent["session"])).toBe(1);
    const replayed = await replays.apply(workspace, pack);
    expect(replayed.tasks[0]!.files).toEqual({ "input.txt": "before" });
    expect(replayed.tasks[0]!.checks).toEqual(search.checks);
    expect(replayed.tasks[1]).toBe(pack.tasks[1]);
    expect(() => assertProjectTaskPack(replayed)).not.toThrow();
    const changed = structuredClone(pack); changed.tasks[0]!.checks[0]!.expected = "new-contract";
    expect(replayContract(changed.tasks[0]!)).not.toBe(replayContract(search));
    expect((await replays.apply(workspace, changed)).tasks[0]!.id).toBe("search");
  });

  it("never recycles independent holdout evidence or admits fabricated check identities", async () => {
    const t = task("private", "holdout");
    const result = await checkProject(t.files, t.checks);
    expect(failureReplay(t, t.files, result, source)).toBeUndefined();
    expect(() => failureReplay({ ...t, split: "search" }, t.files, { ...result, results: [{ id: "other", passed: false }] }, source)).toThrow();
    expect(() => assertProjectTaskPack({ schemaVersion: 1, tasks: [task("search", "search"), { ...t, capture: true }] })).toThrow("holdout");
    expect(() => assertTrialContext({ ...context(), entries: [{ id: "unapproved", body: "text", index: "x", inline: null }] })).toThrow("sources differ");
  });

  it("captures a failed declared file call even when it could not change the file", async () => {
    const search = { ...task("search", "search"), capture: true };
    const pack = { schemaVersion: 1 as const, tasks: [search, task("private", "holdout")] };
    const workspace = "virtual/failed-call";
    records.set(`${workspace}/.agents/rsi/tasks.json`, JSON.stringify(pack));
    records.set(`${workspace}/input.txt`, "before");
    const events: unknown[] = [{ type: "user/message", time: 0, data: { id: source.requestId,
      source: { kind: "user" }, content: [{ type: "text", text: "Perform the task." }] } }];
    const session = { id: source.sessionId, header: { cwd: workspace }, snapshotEvents: () => events } as unknown as Agent["session"];
    const replays = new FailureReplays("virtual/replays");
    await replays.begin({ session } as Agent);
    events.push({ type: "tool/call", data: { callId: "failed-write", name: "write", arguments: JSON.stringify({ file_path: "input.txt" }) } },
      { type: "tool/result", data: { message: { role: "tool", toolCallId: "failed-write", isError: true, content: [] } } });
    expect(await replays.finish(session)).toBe(1);
    expect((await replays.apply(workspace, pack)).tasks[0]!.files).toEqual({ "input.txt": "before" });
  });

  it.runIf(SANDBOXED)("executes every generated starter contract in the read-only verification process", async () => {
    const origin = proposalOrigin({ experimentId: "experiment", key: "round-1", baseline: initial, parent: initial, target: initial,
      workspace: "project", model: "model:provider/model", runtimeVersion: "0.1.5-rc.2" });
    const driver = `import plugin from './candidate.mjs';
export async function evaluate(kind, name, input, expected) {
  const definitions = { context: [], guard: [], tool: [] };
  await plugin.activate({ registerContext(d) { definitions.context.push(d); }, registerGuard(d) { definitions.guard.push(d); }, registerTool(d) { definitions.tool.push(d); } });
  const definition = definitions[kind === 'dispatch' ? 'tool' : kind].find(d => d.name === name);
  if (kind === 'dispatch') return definition.dispatch;
  if (kind === 'context') { const value = definition.render(input); return 'maxChars' in expected ? value.length <= expected.maxChars : value; }
  if (kind === 'guard') return definition.evaluate(input) ?? null;
  return definition.execute(input);
}`;
    const files = { "candidate.mjs": executionTemplate(origin.manifest), "driver.mjs": driver };
    const cases = executionContractFixtures(origin.manifest).cases;
    const checks: ProjectCheck[] = cases.map(item => ({ id: item.id, kind: "module" as const, path: "driver.mjs", export: "evaluate",
      arguments: [item.kind, item.name, item.input, item.expect] as unknown as JsonValue[], expected: item.kind === "guard" ? item.expect.decision : "equals" in item.expect ? item.expect.equals : "contains" in item.expect ? item.expect.contains : true }));
    checks.push({ id: "dispatch-declaration", kind: "module", path: "driver.mjs", export: "evaluate",
      arguments: ["dispatch", origin.manifest.provides.tools.find(name => name.startsWith("learned_execution_"))!, {}, {}],
      expected: (executionInterfaceContract().registerTool as JsonObject).dispatch! });
    const result = await checkProject(files, checks);
    expect(result.results).toEqual([...cases.map(item => ({ id: item.id, passed: true })), { id: "dispatch-declaration", passed: true }]);
  }, 15_000);
});
