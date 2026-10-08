import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Agents from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import Commands from "@deepseek-ai/dsh-commands";
import Llm, { createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ContextFormed, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import Sessions, { SessionId } from "@deepseek-ai/dsh-session";
import Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import Projection from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import * as integrity from "../src/integrity.js";
import * as instructions from "../src/instructions.js";
import * as context from "../src/context.js";
import * as tools from "../src/tools.js";
import * as commands from "../src/commands.js";
import * as authoring from "../../evolution-authoring/src/index.js";
import { ChopinEvolution } from "../src/index.js";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "projection-check": { kind: "projection-check" } & ContextFormed;
  }
}

class RequestCapture extends LlmAdapter {
  requests: GenerateOptions[] = [];
  nextCall?: { name: string; arguments: Record<string, unknown> };
  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const off = ReasoningEffortId("off");
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: off, name: "Off" }], defaultEffort: off } };
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    if (this.nextCall || !request.messages.some((message) => message.role === "tool")) {
      const call = this.nextCall ?? { name: "evolution_context_inspect", arguments: {} };
      this.nextCall = undefined;
      const id = ToolCallId(call.name === "evolution_context_inspect" ? "inspect-context" : `capture-${this.requests.length}`);
      const args = JSON.stringify(call.arguments);
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id, name: call.name, argumentsDelta: args };
      yield { type: "block-end", index: 0, block: { type: "tool-call", id, name: call.name, arguments: args } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "Local transport capture." } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

async function host(root: string, instructionFiles = [join(root, "rules.md")]) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(Sessions);
  await ctx.plugin(Tools);
  await ctx.plugin(Commands);
  await ctx.plugin(Llm);
  await ctx.plugin(Agents);
  await ctx.plugin(Projection);
  await ctx.plugin(Persistence, { root: join(root, "sessions") });
  await ctx.plugin(AgentLoop, { agents: [] });
  const evolution = new ChopinEvolution(ctx, {
    eventsFile: join(root, "events.jsonl"), artifactsDir: join(root, "artifacts"), receiptsDir: join(root, "receipts"),
    chopinVersion: "0.1.0", dshVersion: "0.1.3-alpha.2", processGeneration: "integrity-test", autonomous: true,
  });
  await ctx.plugin(integrity, { preset: "chopin", requiredTools: ["experience_read", "evolution_experience_record"] });
  const capture = new RequestCapture();
  ctx.llm.registerAdapter(["local-capture"], capture);
  const setup = async (scope: Context) => {
    await scope.plugin(instructions, { files: instructionFiles });
    await scope.plugin(context);
    await scope.plugin(tools);
    await scope.plugin(commands);
    await scope.plugin(authoring);
  };
  const turn = async (agent: Agent) => {
    const ended = new Promise<{ kind: string; error?: { message: string } }>((resolve) => {
      const release = ctx.on("session/event", (session, event) => {
        if (session.id !== agent.session.id || event.type !== "turn/end") return;
        release();
        resolve(event.data.reason);
      });
    });
    agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "Inspect the request." }] }));
    return ended;
  };
  return { ctx, setup, capture, turn, evolution };
}

function systemText(request: GenerateOptions): string {
  return request.messages.findLast((message) => message.role === "system")?.content
    .filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? "";
}

function experienceText(request: GenerateOptions): string {
  return request.messages.flatMap((message) => message.role === "user" && message.source?.kind === "runtime-context"
    && message.source.form === "snapshot" ? message.source.sections.filter((section) => section.name.startsWith("chopin:experience:")).map((section) => section.text) : []).join("\n");
}

describe("full capability across session resume", () => {
  it("real tools save seven experiences and reuse them immediately; an update withdraws the old body, projects are isolated, and a cold resume still auto-loads", async () => {
    const root = await mkdtemp(join(tmpdir(), "experience-lifecycle-"));
    await writeFile(join(root, "rules.md"), "Keep user rules {{literal}} intact.");
    const first = await host(root);
    let id!: SessionId;
    try {
      const handle = await first.ctx.agents.create({ sessionId: SessionId("experience-lifecycle"), meta: { cwd: root, agentPreset: "chopin" },
        agentOptions: { provider: "local-capture", model: "first" }, setup: first.setup });
      id = handle.agent.session.id;
      for (let index = 0; index < 7; index += 1) {
        first.capture.nextCall = { name: "evolution_correction_record", arguments: {
          slug: `method-${index}`, lesson: `METHOD_${index}: verify the input contract.`, when: "checking an input contract", scope: "global",
        } };
        expect(await first.turn(handle.agent)).toMatchObject({ kind: "completed" });
      }
      let text = experienceText(first.capture.requests.at(-1)!);
      for (let index = 0; index < 7; index += 1) expect(text).toContain(`METHOD_${index}:`);
      expect((await first.evolution.inspectContext(handle.agent)).selection?.applied.filter((item) => item.inline)).toHaveLength(7);
      expect(systemText(first.capture.requests.at(-1)!)).toContain(instructions.INSTRUCTION_POLICY);

      first.capture.nextCall = { name: "evolution_correction_record", arguments: {
        slug: "method-0", lesson: "UPDATED_METHOD: verify both input and output contracts.", when: "checking an input contract", scope: "global",
      } };
      expect(await first.turn(handle.agent)).toMatchObject({ kind: "completed" });
      text = experienceText(first.capture.requests.at(-1)!);
      expect(text).toContain("UPDATED_METHOD:");
      expect(text).not.toContain("METHOD_0:");
      expect(JSON.stringify(handle.agent.session.snapshotEvents())).toContain("METHOD_0:");

      first.capture.nextCall = { name: "evolution_correction_record", arguments: {
        slug: "local-method", lesson: "LOCAL_METHOD: inspect the workspace contract.", when: "checking this project", scope: "workspace",
      } };
      expect(await first.turn(handle.agent)).toMatchObject({ kind: "completed" });
      expect(experienceText(first.capture.requests.at(-1)!)).toContain("LOCAL_METHOD:");
      const local = (await first.evolution.events.fold()).artifacts.find((item) => item.manifest.summary.startsWith("LOCAL_METHOD:"))!;
      expect(local.manifest.trigger.repos).toEqual([root]);
      const before = (await first.evolution.events.readAll()).length;
      const view = await first.ctx.commands.execute(handle.agent, `/experience ${local.id}`, [], new AbortController().signal);
      expect(view?.result).toMatchObject({ kind: "success", text: expect.stringContaining("LOCAL_METHOD:") });
      expect((await first.evolution.events.readAll()).length).toBe(before);
      expect((await first.ctx.commands.execute(handle.agent, "/instructions", [], new AbortController().signal))?.result)
        .toMatchObject({ kind: "success", text: expect.stringContaining("carried in full") });
      await handle.dispose();
    } finally { await first.ctx.fiber.dispose(); }
    const second = await host(root);
    try {
      const restored = await second.ctx.agents.resume({ resumeSessionId: id, setup: second.setup,
        agentOptions: { provider: "local-capture", model: "first" } });
      const resumed = await second.turn(restored.agent);
      expect(resumed.error?.message).toBeUndefined();
      expect(resumed).toMatchObject({ kind: "completed" });
      expect(experienceText(second.capture.requests.at(-1)!)).toContain("UPDATED_METHOD:");
      expect(experienceText(second.capture.requests.at(-1)!)).toContain("LOCAL_METHOD:");
      await restored.dispose();
      const other = join(root, "other-workspace"); await mkdir(other);
      const unrelated = await second.ctx.agents.create({ sessionId: SessionId("unrelated-workspace"), meta: { cwd: other, agentPreset: "chopin" },
        agentOptions: { provider: "local-capture", model: "second" }, setup: second.setup });
      expect(await second.turn(unrelated.agent)).toMatchObject({ kind: "completed" });
      expect(experienceText(second.capture.requests.at(-1)!)).not.toContain("LOCAL_METHOD:");
      expect(experienceText(second.capture.requests.at(-1)!)).toContain("UPDATED_METHOD:");
      await unrelated.dispose();
    } finally { await second.ctx.fiber.dispose(); }
  }, 30_000);

  it("runs a full turn when the user has no personal rule files", async () => {
    const root = await mkdtemp(join(tmpdir(), "no-instructions-"));
    const runtime = await host(root, []);
    try {
      const handle = await runtime.ctx.agents.create({ sessionId: SessionId("no-instructions"), meta: { cwd: root, agentPreset: "chopin" },
        agentOptions: { provider: "local-capture", model: "first" }, setup: runtime.setup });
      const outcome = await runtime.turn(handle.agent);
      expect(outcome.error?.message).toBeUndefined();
      expect(outcome).toMatchObject({ kind: "completed" });
      const personal = runtime.capture.requests.at(-1)!.messages.filter((message) => message.role === "user"
        && message.source?.kind === instructions.name);
      expect(JSON.stringify(personal)).toContain("No personal instruction files are currently active.");
      await handle.dispose();
    } finally { await runtime.ctx.fiber.dispose(); }
  });

  it("blocks sending when the final request lacks the rules or their precedence; a successful registration cannot pose as carried in full", async () => {
    const root = await mkdtemp(join(tmpdir(), "instruction-boundary-"));
    await writeFile(join(root, "rules.md"), "Protected current rule.");
    const runtime = await host(root);
    try {
      let corrupt = "message";
      runtime.ctx.on("agent/pre-step", async (_event, next) => {
        const result = await next();
        if (result.kind === "enter" && corrupt === "message") return { ...result, messages: result.messages.filter((message) =>
          !(message.source?.kind === instructions.name)) };
        return result;
      });
      runtime.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
        const result = await next();
        if (corrupt === "policy") result.sections = result.sections.filter((section) => section.name !== "chopin-instruction-policy");
        return result;
      });
      const handle = await runtime.ctx.agents.create({ sessionId: SessionId("instruction-boundary"), meta: { cwd: root, agentPreset: "chopin" },
        agentOptions: { provider: "local-capture", model: "first" }, setup: runtime.setup });
      expect(await runtime.turn(handle.agent)).toMatchObject({ kind: "error" });
      expect(runtime.capture.requests).toHaveLength(0);
      corrupt = "policy";
      expect(await runtime.turn(handle.agent)).toMatchObject({ kind: "error" });
      expect(runtime.capture.requests).toHaveLength(0);
      corrupt = "none";
      expect(await runtime.turn(handle.agent)).toMatchObject({ kind: "completed" });
      expect(runtime.capture.requests.length).toBeGreaterThan(0);
      const previous = handle.agent.session.snapshotEvents().findLast((event) => event.type === "user/message"
        && event.data.source.kind === instructions.name)!;
      handle.agent.session.append("user/message", createUserMessage({
        source: { kind: "projection-check", form: "notice", summary: "Condensed prior context." },
        content: [{ type: "text", text: "Condensed prior context." }],
      }), { surfaceOp: { op: "replace", startSeq: previous.seq, endSeq: previous.seq }, sourceEventSeqs: [previous.seq] });
      expect(await runtime.turn(handle.agent)).toMatchObject({ kind: "completed" });
      const personal = runtime.capture.requests.at(-1)!.messages.filter((message) => message.role === "user"
        && message.source?.kind === instructions.name);
      expect(personal).toHaveLength(1);
      expect(JSON.stringify(personal)).toContain("Protected current rule.");
      await handle.dispose();
    } finally { await runtime.ctx.fiber.dispose(); }
  });

  it("resumes from real disk state; rejects before the request when config is missing, and keeps tools and current rules after a correct remount", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-integrity-"));
    const rules = join(root, "rules.md");
    await writeFile(rules, "Original user rule.");
    const id = SessionId("integrity-resume");
    const first = await host(root);
    try {
      const handle = await first.ctx.agents.create({ sessionId: id, meta: { cwd: root, agentPreset: "chopin" },
        agentOptions: { provider: "local-capture", model: "first" }, setup: first.setup });
      const outcome = await first.turn(handle.agent);
      expect(outcome.error?.message).toBeUndefined();
      expect(outcome).toMatchObject({ kind: "completed" });
      expect(first.ctx.chopinSessionIntegrity.missing(handle.agent)).toEqual([]);
      expect(first.capture.requests).toHaveLength(2);
      expect(handle.agent.session.snapshotEvents().some((event) => event.type === "tool/result"
        && event.data.message.toolCallId === "inspect-context" && !event.data.message.isError)).toBe(true);
      await handle.dispose();
    } finally { await first.ctx.fiber.dispose(); }

    await writeFile(rules, "Updated user rule.");
    const second = await host(root);
    try {
      const broken = await second.ctx.agents.resume({ resumeSessionId: id });
      expect(await second.turn(broken.agent)).toMatchObject({ kind: "error" });
      expect(second.capture.requests).toHaveLength(0);
      await broken.dispose();
      const restored = await second.ctx.agents.resume({ resumeSessionId: id,
        agentOptions: { provider: "local-capture", model: "second" }, setup: second.setup });
      expect(await second.turn(restored.agent)).toMatchObject({ kind: "completed" });
      const request = second.capture.requests.at(-1)!;
      expect(request.model).toBe("second");
      expect(request.tools?.some((tool) => tool.name === "experience_read")).toBe(true);
      const personal = request.messages.filter((message) => message.role === "user"
        && message.source?.kind === instructions.name);
      expect(personal).toHaveLength(1);
      expect(JSON.stringify(personal)).toContain("Updated user rule.");
      expect(JSON.stringify(personal)).not.toContain("Original user rule.");
      expect(JSON.stringify(restored.agent.session.snapshotEvents())).toContain("Original user rule.");
      const count = second.capture.requests.length;
      await rename(rules, join(root, "rules-preserved.md"));
      expect(await second.turn(restored.agent)).toMatchObject({ kind: "error" });
      expect(second.capture.requests).toHaveLength(count);
      await restored.dispose();
    } finally { await second.ctx.fiber.dispose(); }
  });
});
