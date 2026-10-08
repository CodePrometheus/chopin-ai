import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Llm, { LlmAdapter, ReasoningEffortId, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import Sessions, { SessionId } from "@deepseek-ai/dsh-session";
import Agents from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import Projection from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import Commands from "@deepseek-ai/dsh-commands";
import { afterEach, describe, expect, it } from "vitest";
import { assertContextSelectionPlan, baselineContextSelection, CONTEXT_SELECTOR_TOOL,
  artifactDeploymentRequested, artifactQuarantined, artifactRetired, artifactRolledBack } from "@chopin/evolution";
import type { CapabilityManifest, ContextSelectionInput } from "@chopin/evolution";
import { HotActivationManager } from "../../plugin-adapter/src/index.js";
import { deploymentReceipt, deploymentRequest } from "../../evolution/tests/receipt-fixtures.js";
import { ChopinEvolution, artifactReferenceOf } from "../src/index.js";
import { contextSelectorTemplate } from "../src/context-selector-template.js";
import { contextCandidates } from "../src/context-selection.js";
import { normalizeTriggerFacts } from "../src/selection.js";
import * as contextPlugin from "../src/context.js";
import * as instructions from "../src/instructions.js";
import * as commands from "../src/commands.js";
import { cleanupTemporaryDirectories, dataManifest, lifecycle, stageArtifact, temporaryDirectory } from "./support.js";

afterEach(cleanupTemporaryDirectories);

class LocalTransport extends LlmAdapter {
  requests: GenerateOptions[] = [];
  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const off = ReasoningEffortId("off");
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: off, name: "Off" }], defaultEffort: off } };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "Local transport probe." } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

describe("bounded context selection", () => {
  it("short experiences load whole within the body budget, explicit scope comes first, and loaded bodies are not relisted in the index", () => {
    const input: ContextSelectionInput = {
      schemaVersion: 1, objective: "Inspect the current request.",
      budget: { indexChars: 1000, indexItems: 10, inlineChars: 210, inlineItems: 200, indexHeaderChars: 0 },
      candidates: Array.from({ length: 7 }, (_, index) => ({
        id: `lesson-${index}`, contentDigest: `sha256:${"a".repeat(64)}`, kind: "memory" as const,
        summary: "Task-dependent guidance.", when: "Only for the matching task.",
        indexChars: 10, inlineChars: 30, matchedSelectors: ["when"],
      })),
    };
    const result = baselineContextSelection(input);
    expect(result.items).toHaveLength(7);
    expect(result.items.every((item) => item.mode === "inline")).toBe(true);
    expect(() => assertContextSelectionPlan(result, input)).not.toThrow();
    input.budget.inlineChars = 60;
    input.candidates[6]!.matchedSelectors = ["when", "pathGlobs", "tools"];
    const scoped = baselineContextSelection(input);
    expect(scoped.items[0]).toMatchObject({ id: "lesson-6", mode: "inline" });
    expect(scoped.items.filter((item) => item.mode !== "index")).toHaveLength(2);
    expect(scoped.items.filter((item) => item.mode === "index")).toHaveLength(5);
    const reordered = baselineContextSelection({ ...input, candidates: [...input.candidates].reverse() });
    expect(reordered).toEqual(scoped);
    input.candidates[0]!.inlineChars = 61;
    expect(baselineContextSelection(input).items.find((item) => item.id === "lesson-0")?.mode).toBe("index");
  });
  const input: ContextSelectionInput = { schemaVersion: 1, objective: "Select evidence.",
    budget: { indexChars: 100, indexHeaderChars: 10, indexItems: 1, inlineChars: 300, inlineItems: 1 },
    candidates: [{ id: "memory", contentDigest: `sha256:${"a".repeat(64)}`, kind: "memory", summary: "Memory", when: "testing",
      indexChars: 40, inlineChars: 250, matchedSelectors: ["when"] },
    { id: "skill", contentDigest: `sha256:${"b".repeat(64)}`, kind: "skill", summary: "Skill", when: "testing",
      indexChars: 40, inlineChars: null, matchedSelectors: ["when"] }] };

  it("budget is computed from host-measured lengths; rejects overreach, duplicates, inflation, skill bodies and rewritten content", () => {
    expect(() => assertContextSelectionPlan(baselineContextSelection(input), input)).not.toThrow();
    const choice = { id: "memory", mode: "both", reason: "Fits." };
    for (const plan of [
      { schemaVersion: 1, items: [{ ...choice, id: "unapproved" }] },
      { schemaVersion: 1, items: [choice, choice] },
      { schemaVersion: 1, items: [{ ...choice, id: "skill", mode: "inline" }] },
      { schemaVersion: 1, items: [{ ...choice, body: "replacement" }] },
      { schemaVersion: 1, items: [], budget: { inlineChars: 100_000 } },
      { schemaVersion: 1, items: [choice, { ...choice, id: "skill", mode: "index" }] },
    ]) expect(() => assertContextSelectionPlan(plan, input)).toThrow();
    expect(() => assertContextSelectionPlan({ schemaVersion: 1, items: [choice] }, { ...input, budget: { ...input.budget, inlineChars: 249 } })).toThrow(/budget/);
  });

  it("the candidate pool is not cut short by the output count, and unapproved or out-of-scope entries never reach the strategy", async () => {
    const root = await temporaryDirectory();
    const ctx = new Context();
    try {
      const service = new ChopinEvolution(ctx, { eventsFile: join(root, "events.jsonl"), artifactsDir: join(root, "artifacts"),
        receiptsDir: join(root, "receipts"), chopinVersion: "0.1.0", dshVersion: "0.1.3-alpha.1", processGeneration: "pool", autonomous: false });
      for (const id of ["a", "b", "c", "foreign", "unapproved"]) {
        const staged = await stageArtifact(root, dataManifest(id, { trigger: { taskKinds: [id === "foreign" ? "other" : "checking"] } }), `BODY_${id}`);
        await service.events.appendMany(id === "unapproved" ? lifecycle(staged).slice(0, 2) : lifecycle(staged));
      }
      const prepared = await contextCandidates({ projection: await service.events.fold(), artifacts: service.artifacts,
        facts: normalizeTriggerFacts({ taskKinds: ["checking"] }), objective: "Select evidence.", maxBodyChars: 16_000,
        budget: { indexChars: 1_000, indexItems: 1, inlineChars: 2_000, inlineItems: 1, indexHeaderChars: 0 } });
      expect(prepared.input.candidates.map((item) => item.id)).toEqual(["a:1.0.0", "b:1.0.0", "c:1.0.0"]);
      expect(() => assertContextSelectionPlan({ schemaVersion: 1, items: [{ id: "c:1.0.0", mode: "inline", reason: "Select the later eligible entry." }] }, prepared.input)).not.toThrow();
    } finally { await ctx.fiber.dispose(); }
  });

  // Executable strategies run only inside the macOS OS sandbox.
  it.runIf(process.platform === "darwin")("the real execution loop and isolated code switch, roll back and fall back from a bad strategy within one session; the audit trusts only the actual body", async () => {
    const root = await temporaryDirectory();
    const ctx = new Context();
    let manager: HotActivationManager | undefined;
    try {
      await ctx.plugin(SystemPrompt, {}); await ctx.plugin(Sessions); await ctx.plugin(Tools); await ctx.plugin(Commands);
      await ctx.plugin(Llm); await ctx.plugin(Agents); await ctx.plugin(Projection); await ctx.plugin(AgentLoop, { agents: [] });
      const service = new ChopinEvolution(ctx, { eventsFile: join(root, "events.jsonl"), artifactsDir: join(root, "artifacts"),
        receiptsDir: join(root, "receipts"), chopinVersion: "0.1.0", dshVersion: "0.1.3-alpha.1", processGeneration: "context-generation", autonomous: false, maxIndexItems: 1 });
      let taskKind = "checking";
      service.registerFactProvider(() => ({ taskKinds: [taskKind] }));
      const transport = new LocalTransport(); ctx.llm.registerAdapter(["local-transport"], transport);
      let foreignContext = "FOREIGN_CONTEXT_ONE";
      ctx.systemPrompt.context({ name: "chopin:experience:1.0.0:external-note", order: 1, text: () => foreignContext });
      const rules = join(root, "rules.md"); await writeFile(rules, "PROTECTED_RULE {{literal}} must stay verbatim.");
      let mutateContext = false;
      ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
        const result = await next();
        if (mutateContext) result.contexts = result.contexts.map((item) => item.name === "chopin:experience:beta:1.0.0" ? { ...item, text: "ALTERED_CONTEXT" } : item);
        return result;
      });
      await ctx.plugin(instructions, { files: [rules] }); await ctx.plugin(contextPlugin); await ctx.plugin(commands);
      for (const id of ["alpha", "beta"]) {
        const staged = await stageArtifact(root, dataManifest(id, { trigger: { taskKinds: ["checking"] } }), `BODY_${id} {{literal}}`);
        await service.events.appendMany(lifecycle(staged));
      }
      async function install(version: string, chosen: string, mode: string) {
        const manifest: CapabilityManifest = { ...dataManifest("learned-context-selector"), version, kind: "tool", runtime: "dsh-plugin", entry: "index.mjs",
          trigger: { taskKinds: ["checking"] }, permissions: ["tools:register"], requires: { chopinPluginApi: "^1.0.0", dsh: "0.1.3-alpha.1" },
          provides: { contexts: [], skills: [], tools: [CONTEXT_SELECTOR_TOOL], guards: [], services: [], workflows: [] } };
        const source = join(root, `selector-${version}`); await mkdir(source);
        await writeFile(join(source, "capability.json"), JSON.stringify(manifest));
        await writeFile(join(source, "index.mjs"), contextSelectorTemplate(manifest).replace("return baselineContextSelection(input);",
          `return {schemaVersion:1,items:[{id:${JSON.stringify(chosen)},mode:${JSON.stringify(mode)},reason:'Fixture selection.'}]};`));
        const staged = await service.artifacts.stage(source);
        await service.events.appendMany(lifecycle(staged));
        return staged;
      }
      const first = await install("1.0.0", "alpha:1.0.0", "index");
      manager = new HotActivationManager(ctx, { watchChanges: false }); await manager.start();
      const detach = service.registerContextSelector({ kind: "artifact", id: "learned-context-selector:1.0.0", contentDigest: first.contentDigest },
        async () => { throw new Error("disposed registration must not execute"); });
      detach();
      const agent = await ctx.agentLoop.create(SessionId("context-selection-session"), { provider: "local-transport", model: "local-transport" }, { cwd: root });
      async function turn() {
        const ended = new Promise<void>((resolve, reject) => {
          const dispose = ctx.on("session/event", (session, event) => {
            if (session.id !== agent.session.id || event.type !== "turn/end") return;
            dispose(); event.data.reason.kind === "completed" ? resolve() : reject(new Error(JSON.stringify(event.data)));
          });
        });
        agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "Inspect the eligible experience." }] }));
        await ended; await ctx.parallel("session/flush", agent.session);
        return service.inspectContext(agent);
      }
      let inspected = await turn();
      expect(inspected.selection?.strategy.id).toBe("learned-context-selector:1.0.0");
      expect(inspected.selection?.applied).toMatchObject([{ id: "alpha:1.0.0", index: true, inline: false }]);
      expect(JSON.stringify(transport.requests.at(-1))).not.toContain("BODY_alpha");
      expect(transport.requests.at(-1)?.tools?.some((tool) => tool.name === CONTEXT_SELECTOR_TOOL)).not.toBe(true);
      const second = await install("2.0.0", "beta:1.0.0", "inline");
      foreignContext = "FOREIGN_CONTEXT_TWO";
      inspected = await turn();
      expect(inspected.selection?.strategy.id).toBe("learned-context-selector:2.0.0");
      expect(inspected.selection?.applied).toMatchObject([{ id: "beta:1.0.0", index: false, inline: true }]);
      expect(JSON.stringify(transport.requests.at(-1))).toContain("BODY_beta {{literal}}");
      expect(JSON.stringify(transport.requests.at(-1))).toContain("FOREIGN_CONTEXT_ONE");
      expect(JSON.stringify(transport.requests.at(-1))).toContain("FOREIGN_CONTEXT_TWO");

      mutateContext = true;
      const requestCount = transport.requests.length;
      await expect(turn()).rejects.toThrow(/assembled experience differs/);
      expect(transport.requests).toHaveLength(requestCount);
      mutateContext = false;

      await service.events.append(artifactRetired({ artifactId: "learned-context-selector:1.0.0" }, "replaced"));
      await service.events.append(artifactQuarantined({ artifactId: "learned-context-selector:2.0.0" }, "rollback fixture", ["fixture:rollback"]));
      const projection = await service.events.fold();
      const current = projection.artifacts.find((item) => item.id === "learned-context-selector:2.0.0")!;
      const target = projection.artifacts.find((item) => item.id === "learned-context-selector:1.0.0")!;
      const binding = { artifactId: current.id, ...second };
      const rollbackTarget = artifactReferenceOf(target);
      await service.events.appendMany([artifactDeploymentRequested({ artifactId: current.id }, { ...deploymentRequest(binding, "rollback"), rollbackTarget }),
        artifactRolledBack({ artifactId: current.id }, { ...deploymentReceipt(binding, "rollback"), rollbackTarget, loadedSurfaceDigest: first.surfaceDigest })]);
      inspected = await turn();
      expect(inspected.selection?.strategy.id).toBe("learned-context-selector:1.0.0");
      expect(inspected.selection?.applied[0]?.id).toBe("alpha:1.0.0");
      expect(JSON.stringify(transport.requests.at(-1))).not.toContain("BODY_beta");
      expect(JSON.stringify(agent.session.snapshotEvents())).toContain("BODY_beta");

      const controller = new AbortController();
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      const detachWaiting = service.registerContextSelector({ kind: "artifact", id: target.id, contentDigest: target.contentDigest },
        async (_input, signal) => new Promise((_resolve, reject) => {
          expect(signal).toBe(controller.signal);
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
          entered();
        }));
      const interrupted = service.prepareExperienceContext(agent, controller.signal);
      await waiting; controller.abort();
      await expect(interrupted).rejects.toThrow();
      detachWaiting();
      expect((await service.events.fold()).artifacts.find((item) => item.id === target.id)?.enabled).toBe(true);

      taskKind = "other"; inspected = await turn();
      expect(inspected.selection?.strategy.kind).toBe("builtin");
      expect(inspected.selection?.applied).toEqual([]);
      expect((await service.events.fold()).artifacts.find((item) => item.id === "learned-context-selector:1.0.0")?.state).toBe("retired");
      taskKind = "checking";

      await install("3.0.0", "unapproved:1.0.0", "inline"); inspected = await turn();
      expect(inspected.selection?.strategy.kind).toBe("builtin");
      expect(inspected.selection?.fallback?.strategy.id).toBe("learned-context-selector:3.0.0");
      expect((await service.events.fold()).artifacts.find((item) => item.id === "learned-context-selector:3.0.0")?.state).toBe("quarantined");
      expect(inspected.usage).toBeNull();
      for (const request of transport.requests) expect(JSON.stringify(request)).toContain("PROTECTED_RULE {{literal}}");
      expect(new Set((await service.events.fold()).contextSelections?.map((record) => record.sessionId)).size).toBe(1);
      const command = await ctx.commands.execute(agent, "/experience context", [], new AbortController().signal);
      expect(command?.result.text).toContain("Fell back");
    } finally { manager?.stop(); await ctx.fiber.dispose(); }
  }, 20_000);
});
