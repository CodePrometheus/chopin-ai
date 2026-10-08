import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { Context } from "@deepseek-ai/cordis";
import Commands from "@deepseek-ai/dsh-commands";
import Llm, { createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ContextFormed, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import Agents from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import Sessions, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt, { joinContextSections, renderContextSections } from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { artifactQuarantined } from "@chopin/evolution";
import { describe, expect, it } from "vitest";

import * as commands from "../src/commands.js";
import * as context from "../src/context.js";
import * as instructions from "../src/instructions.js";
import * as tools from "../src/tools.js";
import { experienceStatuses, readExperienceEvents } from "../src/status.js";
import { dataManifest, evolutionService, lifecycle, stageArtifact } from "./support.js";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "context-provider": { kind: "context-provider" } & ContextFormed;
  }
}

class ContextProbe extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
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

async function runtime() {
  const directory = await mkdtemp(join(tmpdir(), "experience-context-"));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(Sessions);
  await ctx.plugin(Tools);
  await ctx.plugin(Commands);
  const service = evolutionService(ctx, directory);
  const session = ctx.sessions.create(SessionId("context-session"), { meta: { cwd: directory } });
  const agent = { id: session.id, session, ctx } as Agent;
  session.append("user/message", createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "Check the implementation." }] }), { surfaceOp: "append" });
  return { directory, ctx, service, session, agent };
}

async function assemble(ctx: Context, agent: Agent) {
  return renderContextSections(await ctx.systemPrompt.assemble({ agent }));
}

describe("personal instructions", () => {
  it("reads the original and updates in full, dedupes duplicate files, and never silently truncates on over-budget or invalid encoding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "personal-rules-"));
    const path = join(directory, "rules.md");
    const alias = join(directory, "rules-alias.md");
    const original = "Ask one question per turn.\nThe {{unknown_variable}} in code must stay verbatim.\n";
    await writeFile(path, original);
    await symlink(path, alias);
    const config = { files: [path, alias], maxBytes: 512 };
    const before = await instructions.loadPersonalInstructions(config);
    expect(before.text).toContain(original);
    expect(before.files).toHaveLength(1);
    expect(before.text).toContain("More specific project instructions and direct user instructions take precedence");

    const updated = "Keep user files.\nDo not delete directories.\n";
    await writeFile(path, updated);
    const after = await instructions.loadPersonalInstructions(config);
    expect(after.text).toContain(updated);
    expect(after.text).not.toContain(original);
    expect(await readFile(path, "utf8")).toBe(updated);

    await writeFile(path, "r".repeat(600));
    await expect(instructions.loadPersonalInstructions(config)).rejects.toThrow(/exceed/);
    await writeFile(path, Buffer.from([0xff]));
    await expect(instructions.loadPersonalInstructions(config)).rejects.toThrow();
  });
});

describe("experience context and status", () => {
  it("the real execution loop receives the body on the first turn; a new task inherits no old leads, and reuse across turns is recorded even without a resent snapshot", async () => {
    const { ctx, service, directory } = await runtime();
    try {
      await ctx.plugin(Llm);
      await ctx.plugin(Agents);
      await ctx.plugin(SessionProjection);
      await ctx.plugin(AgentLoop, { agents: [] });
      const probe = new ContextProbe();
      ctx.llm.registerAdapter(["local-probe"], probe);
      const path = join(directory, "personal.md");
      await writeFile(path, "Personal rule {{literal_value}}.");
      await ctx.plugin(instructions, { files: [path] });
      const memory = await stageArtifact(directory, dataManifest("source-only", {
        trigger: { pathGlobs: ["src/*.ts"] },
      }), "Preserve the source contract {{field_name}}.");
      await service.events.appendMany(lifecycle(memory));
      await ctx.plugin(context);
      const agent = await ctx.agentLoop.create(SessionId("real-loop"), { provider: "local-probe", model: "local-probe" }, { cwd: directory });
      async function turn(text: string, target = agent) {
        const ended = new Promise<void>((resolve, reject) => {
          const dispose = ctx.on("session/event", (session, event) => {
            if (session.id !== target.session.id || event.type !== "turn/end") return;
            dispose();
            if (event.data.reason.kind === "completed") resolve();
            else reject(new Error(JSON.stringify(event.data)));
          });
        });
        target.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] }));
        await ended;
        await ctx.parallel("session/flush", target.session);
      }
      const latestSections = () => probe.requests.at(-1)?.messages.findLast((message) => message.role === "user"
        && message.source?.kind === "runtime-context")?.source;
      const personalMessages = () => probe.requests.at(-1)?.messages.filter((message) => message.role === "user"
        && message.source?.kind === instructions.name) ?? [];
      await turn("Inspect `src/entry.ts`.");
      expect(personalMessages()).toHaveLength(1);
      expect(JSON.stringify(personalMessages()[0])).toContain("Personal rule {{literal_value}}.");
      let source = latestSections();
      expect(source?.kind === "runtime-context" && source.form === "snapshot" && source.sections.some((section) => section.text.includes("Preserve the source contract {{field_name}}."))).toBe(true);
      expect(experienceStatuses(await service.events.readAll(), String(agent.session.id))[0]).toMatchObject({ loaded: 1, effect: "pending" });

      await turn("Inspect `docs/guide.md` instead.");
      source = latestSections();
      expect(source?.kind === "runtime-context" && source.form === "snapshot" && source.sections.some((section) => section.name.startsWith("chopin:experience:"))).not.toBe(true);
      await turn("Return to `src/entry.ts`.");
      const snapshots = () => agent.session.snapshotEvents().filter((event) => event.type === "user/message" && event.data.source.kind === "runtime-context" && event.data.source.form === "snapshot").length;
      const count = snapshots();
      await turn("Check `src/entry.ts` once more.");
      expect(snapshots()).toBe(count);
      expect(personalMessages()).toHaveLength(1);
      expect(experienceStatuses(await service.events.readAll(), String(agent.session.id))[0]).toMatchObject({ loaded: 3, read: 0, effect: "pending" });

      const another = await ctx.agentLoop.create(SessionId("another-session"), { provider: "local-probe", model: "local-probe" }, { cwd: directory });
      await turn("Inspect `src/entry.ts` in a new session.", another);
      source = latestSections();
      expect(source?.kind === "runtime-context" && source.form === "snapshot" && source.sections.some((section) => section.text.includes("Preserve the source contract {{field_name}}."))).toBe(true);
      expect(experienceStatuses(await service.events.readAll(), String(another.session.id))[0]).toMatchObject({ loaded: 1, effect: "pending" });
      expect(experienceStatuses(await service.events.readAll(), String(agent.session.id))[0]).toMatchObject({ loaded: 3 });

      await writeFile(path, "Updated personal rule.");
      await service.events.append(artifactQuarantined({ artifactId: "source-only:1.0.0" }, "withdrawn", ["check:source-only"]));
      await turn("Check `src/entry.ts` after withdrawal.");
      source = latestSections();
      expect(personalMessages()).toHaveLength(1);
      const instructionHistory = agent.session.snapshotEvents().filter((event) => event.type === "user/message"
        && event.data.source.kind === instructions.name);
      expect(instructionHistory).toHaveLength(2);
      expect(JSON.stringify(instructionHistory[0])).toContain("Personal rule {{literal_value}}.");
      expect(JSON.stringify(personalMessages())).not.toContain("Personal rule {{literal_value}}.");
      expect(JSON.stringify(personalMessages().at(-1))).toContain("Updated personal rule.");
      expect(source?.kind === "runtime-context" && source.form === "snapshot" && source.sections.some((section) => section.name.startsWith("chopin:experience:"))).toBe(false);
      expect(source?.kind === "runtime-context" && source.form === "snapshot" && source.sections.some((section) => section.text.includes("Previously loaded experiences are no longer effective: source-only:1.0.0"))).toBe(true);
    } finally {
      await ctx.fiber.dispose();
    }
  }, 15_000);

  it("preparing is not loading; a real submission counts once, skills read on demand, disabling withdraws, and the command views read-only across processes", async () => {
    const { ctx, service, agent, session, directory } = await runtime();
    try {
      const body = "Read the source contract before changing {{field_name}}.";
      const memory = await stageArtifact(directory, dataManifest("source-contract", { trigger: { repos: [directory] } }), body);
      const skill = await stageArtifact(directory, dataManifest("procedure", { kind: "skill", trigger: { repos: [directory] } }), "A complete procedure.\n".repeat(120));
      const other = await stageArtifact(directory, dataManifest("other-workspace", { trigger: { repos: ["elsewhere"] } }), "Not for this workspace.");
      await service.events.appendMany([...lifecycle(memory), ...lifecycle(skill), ...lifecycle(other)]);
      await ctx.plugin(context);
      await ctx.plugin(tools);
      await ctx.plugin(commands);

      const sections = await assemble(ctx, agent);
      const inline = sections.filter((section) => section.name.startsWith("chopin:experience:"));
      expect(inline).toHaveLength(1);
      expect(inline[0]?.text).toContain(body);
      expect(inline.reduce((sum, section) => sum + section.text.length, 0)).toBeLessThanOrEqual(2_000);
      expect(joinContextSections(sections)).not.toContain("Not for this workspace.");
      expect(joinContextSections(sections)).not.toContain("A complete procedure.");
      expect(experienceStatuses(await service.events.readAll()).every((item) => item.loaded === 0 && item.read === 0)).toBe(true);

      const foreign = session.append("user/message", createUserMessage({
        source: { kind: "context-provider", form: "snapshot", sections },
        content: [{ type: "text", text: joinContextSections(sections) }],
      }), { surfaceOp: "append" });
      await service.recordContextSnapshot(session, foreign);
      expect(experienceStatuses(await service.events.readAll()).every((item) => item.loaded === 0)).toBe(true);
      const missingBody = session.append("user/message", createUserMessage({
        source: { kind: "runtime-context", form: "snapshot", sections },
        content: [{ type: "text", text: "The prepared content was not delivered." }],
      }), { surfaceOp: "append" });
      await service.recordContextSnapshot(session, missingBody);
      expect(experienceStatuses(await service.events.readAll()).every((item) => item.loaded === 0)).toBe(true);
      const committed = session.append("user/message", createUserMessage({
        source: { kind: "runtime-context", form: "snapshot", sections },
        content: [{ type: "text", text: joinContextSections(sections) }],
      }), { surfaceOp: "append" });
      await service.recordContextSnapshot(session, committed);
      await service.recordContextSnapshot(session, committed);
      await context.publishExperienceNotice(ctx, session);
      let status = experienceStatuses(await service.events.readAll(), String(session.id));
      expect(status.find((item) => item.id === "source-contract:1.0.0")).toMatchObject({ loaded: 1, read: 0, effect: "pending" });
      const firstNotices = session.snapshotEvents().filter((event) => event.type === "user/message" && event.data.source.kind === "chopin-experience" && event.data.source.form === "notice");
      expect(firstNotices).toHaveLength(1);
      expect(JSON.stringify(firstNotices)).not.toContain("Capability other-workspace");
      await context.publishExperienceNotice(ctx, session);
      expect(session.snapshotEvents().filter((event) => event.type === "user/message" && event.data.source.kind === "chopin-experience" && event.data.source.form === "notice")).toHaveLength(1);

      const read = await ctx.tools.execute({ name: "experience_read", callId: ToolCallId("read-procedure"), arguments: { artifactId: "procedure:1.0.0" }, agent, signal: new AbortController().signal });
      expect(read.isError).toBe(false);
      expect(read.content.filter((item) => item.type === "text").map((item) => item.text).join("")).toContain("A complete procedure.\n".repeat(119));
      status = experienceStatuses(await service.events.readAll(), String(session.id));
      expect(status.find((item) => item.id === "procedure:1.0.0")).toMatchObject({ read: 1, loaded: 0, effect: "pending" });
      expect(await service.readExperience(agent, "read-exposed-name" as never, "source-contract"))
        .toMatchObject({ artifactId: "source-contract:1.0.0", body });
      await expect(service.readExperience(agent, "read-foreign" as never, "other-workspace:1.0.0")).rejects.toThrow(/scope/);
      const command = await ctx.commands.execute(agent, "/experience", [], new AbortController().signal);
      expect(command?.result.kind).toBe("success");
      expect(command?.result.text).toContain("effect unverified");
      expect(command?.result.text).toContain("read 1");

      await service.events.append(artifactQuarantined({ artifactId: "source-contract:1.0.0" }, "withdrawn after a verified failure", ["check:source-contract"]));
      const withdrawn = await assemble(ctx, agent);
      expect(withdrawn.some((section) => section.name === "chopin:experience:source-contract:1.0.0")).toBe(false);
      expect(joinContextSections(withdrawn)).toContain("Previously loaded experiences are no longer effective: source-contract:1.0.0");
      await context.publishExperienceNotice(ctx, session);
      expect(session.snapshotEvents().filter((event) => event.type === "user/message" && event.data.source.kind === "chopin-experience" && event.data.source.form === "notice")).toHaveLength(2);

      const before = await readFile(service.events.path, "utf8");
      const entries = await readdir(directory);
      const { stdout } = await promisify(execFile)(process.execPath, [resolve("apps/cli/dist/main.js"), "experience", "--json"], {
        env: { ...process.env, CHOPIN_EVOLUTION_EVENTS: service.events.path }, timeout: 10_000,
      });
      expect(JSON.parse(stdout).find((item: { id: string }) => item.id === "procedure:1.0.0")).toMatchObject({ enabled: true, read: 1, effect: "pending" });
      expect(await readFile(service.events.path, "utf8")).toBe(before);
      expect(await readdir(directory)).toEqual(entries);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("a missing experience store stays missing; neither read nor prepare fakes effectiveness or benefit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "experience-empty-"));
    const events = await readExperienceEvents(join(directory, "absent", "events.jsonl"));
    expect(experienceStatuses(events)).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
    const invalid = join(directory, "invalid.jsonl");
    await writeFile(invalid, '{"type":"artifact.active"}\n');
    await expect(readExperienceEvents(invalid)).rejects.toThrow(/invalid evolution event/);
  });
});
