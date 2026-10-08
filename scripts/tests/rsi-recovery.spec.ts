import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Llm, { LlmAdapter, LlmError, ReasoningEffortId, ToolCallId } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import { improvementDigest } from "@chopin/evolution";
import { loadPersonalInstructions } from "@chopin/evolution-runtime/instructions";
import { RequestBudget } from "@chopin/evolution-runtime/request-budget";
import { runProjectSession, readProjectCheckpoint } from "../../apps/cli/src/rsi-session.js";
import { improvementVerdict } from "../../apps/cli/src/rsi-engine.js";
import { historicalOutcome } from "../../apps/cli/src/rsi-history.js";
import type { TrialScore } from "../../apps/cli/src/rsi-engine.js";
import type { ProjectTask } from "../../apps/cli/src/rsi-project.js";

class RecoveryProtocol extends LlmAdapter {
  calls = 0;
  resumedMessages = "";
  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const off = ReasoningEffortId("off");
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: off, name: "Off" }], defaultEffort: off } };
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++;
    if (this.calls === 3) throw new LlmError("Simulated connection interruption", "TRANSPORT");
    if (this.calls > 5) throw new Error("Unexpected repeated operation");
    if (this.calls === 4) this.resumedMessages = JSON.stringify(request.messages);
    const name = this.calls === 1 ? "read" : this.calls === 2 ? "write" : this.calls === 4 ? "edit" : "project_check";
    const args = this.calls === 1 ? { file_path: "state.txt" } : this.calls === 2 ? { file_path: "state.txt", content: "retained" }
      : this.calls === 4 ? { file_path: "state.txt", old_string: "retained", new_string: "finished" } : { finish: true };
    const id = ToolCallId(`protocol-${this.calls}`);
    const value = JSON.stringify(args);
    yield { type: "block-start", index: 0, blockType: "tool-call" };
    yield { type: "tool-call-delta", index: 0, id, name, argumentsDelta: value };
    yield { type: "block-end", index: 0, block: { type: "tool-call", id, name, arguments: value } };
    yield { type: "finish", reason: { kind: "tool-calls" } };
  }
}

describe("interrupted project execution", () => {
  it("resumes actual file operations and native session history without resetting cost or establishing a gain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chopin-recovery-protocol-"));
    const task: ProjectTask = { id: "retained-state", family: "retained-state", split: "holdout", objective: "Write retained to state.txt and submit.",
      files: { "state.txt": "original" }, writable: ["state.txt"],
      publicChecks: [{ id: "state", kind: "text", path: "state.txt", expected: "finished" }],
      checks: [{ id: "state", kind: "text", path: "state.txt", expected: "finished" }] };
    const budget = new RequestBudget(join(directory, "budget"), { runId: "recovery-protocol", provider: "recovery-protocol", model: "protocol", maxRequests: 5 },
      { id: "trial", limit: 5 });
    await budget.initialize();
    const host = new Context(); const transport = new RecoveryProtocol();
    await host.plugin(Llm); host.llm.registerAdapter(["recovery-protocol"], transport);
    const options: Parameters<typeof runProjectSession>[0] = { host, directory: join(directory, "trial"), task,
      context: { input: { schemaVersion: 1, objective: "Select context", budget: { indexChars: 0, indexItems: 0, inlineChars: 0, inlineItems: 0, indexHeaderChars: 0 }, candidates: [] }, entries: [] },
      strategyDigest: improvementDigest("protocol"), previousRequests: 0, requestLimit: 5, logicalWorkspace: directory,
      route: { provider: "recovery-protocol", model: "protocol" }, budget, instructionFiles: [],
      instructionsDigest: improvementDigest((await loadPersonalInstructions({ files: [] })).text), signal: new AbortController().signal };
    try {
      await expect(runProjectSession(options)).rejects.toThrow("Simulated connection interruption");
      expect((await budget.status()).phaseUsed).toBe(3);
      const saved = JSON.parse(await readFile(join(options.directory, "checkpoint-3.json"), "utf8"));
      expect(await readFile(join(options.directory, saved.value.attempt, "workspace", "state.txt"), "utf8")).toBe("retained");
      await expect(readProjectCheckpoint(options.directory, "changed", 3, task)).rejects.toThrow("identity or content changed");
      await expect(readProjectCheckpoint(options.directory, saved.value.identity, 4, task)).rejects.toThrow("no verified checkpoint");
      const result = await runProjectSession({ ...options, previousRequests: 3 });
      expect(result).toMatchObject({ passed: 1, total: 1, requests: 5, sessionId: saved.value.sessionId, infrastructureFailures: 1, completion: { kind: "completed" } });
      expect(transport.calls).toBe(5);
      expect(transport.resumedMessages).toContain("protocol-2");
      expect(transport.resumedMessages).toContain("retained");
      const events = JSON.parse(await readFile(join(options.directory, saved.value.attempt, "session.json"), "utf8"));
      expect(events.filter((event: { type: string; data: { name?: string } }) => event.type === "tool/call").map((event: { data: { name: string } }) => event.data.name))
        .toEqual(["read", "write", "edit", "project_check"]);
      expect((await readdir(options.directory)).filter(name => name.startsWith("attempt-"))).toHaveLength(1);
      const measured: TrialScore = { ...result, taskId: task.id, taskDigest: improvementDigest(task), completed: true };
      expect(historicalOutcome(measured)).toBe("infrastructure");
      const clean = { ...measured, infrastructureFailures: undefined, requests: 4 };
      expect(improvementVerdict([clean], [{ ...measured, requests: 1 }])).toMatchObject({ accepted: false, reason: expect.stringContaining("Infrastructure") });
      expect(improvementVerdict([{ ...measured, passed: 0, completed: false, results: [{ id: "state", passed: false }] }], [clean]).accepted).toBe(false);
      expect(await runProjectSession({ ...options, previousRequests: 5 })).toEqual(result);
      expect(transport.calls).toBe(5);
    } finally { await host.fiber.dispose(); }
  });
});
