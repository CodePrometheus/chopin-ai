import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { LayerVersions, type Layer, type LayerItem } from "@chopin-ai/core";
import { describe, expect, it } from "vitest";
import { AgentService, layerExtension, pinLayerVersions } from "../src/index.js";

const tool = (name: string, isError = false) =>
  defineTool({ name, description: name, parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text", text: `${name} ran` }], isError }) });

const call = (name: string, args: Record<string, string> = {}) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function conversation(layer: Layer, responses: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([...responses, fauxAssistantMessage("Finished.")]);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "project", tools: [tool("run_tests"), tool("broken", true), tool("deliver")] }));
  registry.install(layerExtension(layer, new Set(["run_tests", "broken", "deliver", "skill"])));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  const model = faux.getModel();
  const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  await (await root.submit({ type: "input", content: "Go." }, context)).wait(context);
  const { entries, messages } = await root.context(context);
  const results = entries.flatMap((entry) => entry.kind === "pi.tool-result"
    ? (entry.model ?? []).map((message) => message as { isError: boolean; content: { text?: string }[] })
    : []);
  return {
    results: results.map((result) => ({ isError: result.isError, text: result.content.map((c) => c.text ?? "").join("") })),
    system: messages.filter((message) => message.role === "system").map((message) => JSON.stringify(message)).join(""),
  };
}

const empty: Layer = { instructions: undefined, skills: [], mcpServers: {}, gates: [] };
const gate = { tool: "deliver", requires: ["run_tests"], reason: "Run the tests before delivering." };

describe("layerExtension", () => {
  it("refuses a gated call until the required tool has succeeded", async () => {
    const { results } = await conversation({ ...empty, gates: [gate] }, [call("deliver"), call("run_tests"), call("deliver")]);
    expect(results).toEqual([
      { isError: true, text: expect.stringContaining("Run the tests before delivering.") },
      { isError: false, text: "run_tests ran" },
      { isError: false, text: "deliver ran" },
    ]);
  });

  it("does not count a failed call as satisfying a gate", async () => {
    const layer = { ...empty, gates: [{ ...gate, requires: ["broken"] }] };
    const { results } = await conversation(layer, [call("broken"), call("deliver")]);
    expect(results.map((result) => result.isError)).toEqual([true, true]);
  });

  it("puts the instructions and the skill index in the prompt and serves skills from outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "chopin-skill-"));
    await mkdir(join(root, "review-diff"));
    await writeFile(join(root, "review-diff", "SKILL.md"), "---\nname: review-diff\ndescription: Review a diff.\n---\nCheck every hunk.\n");
    await writeFile(join(root, "secret.txt"), "outside");
    const layer = {
      ...empty,
      instructions: "Prefer small diffs.",
      skills: [{ name: "review-diff", description: "Review a diff.", directory: join(root, "review-diff") }],
    };
    const { results, system } = await conversation(layer, [
      call("skill", { name: "review-diff" }),
      call("skill", { name: "review-diff", file: "../secret.txt" }),
      call("skill", { name: "review-diff", file: "./SKILL.md" }),
    ]);
    expect(system).toContain("Prefer small diffs.");
    expect(system).toContain("- review-diff: Review a diff.");
    // The model reads a skill as the plugin harness serves it: without its frontmatter, however it names the file.
    expect(results[0]).toEqual({ isError: false, text: "Check every hunk.\n" });
    expect(results[1]).toEqual({ isError: true, text: expect.stringContaining("outside the skill") });
    expect(results[2]).toEqual({ isError: false, text: "Check every hunk.\n" });
  });
});

describe("AgentService", () => {
  it("refuses gate rules that no tool could ever satisfy", () => {
    const workspaces = { open: () => { throw new Error("unused"); }, list: async () => [] };
    const options = { dataDir: tmpdir(), workspaces, models: () => createModels() };
    expect(() => new AgentService({ ...options, layer: { ...empty, gates: [{ ...gate, tool: "bash" }] } }))
      .toThrow("requires run_tests, which no tool provides");
    expect(() => new AgentService({ ...options, layer: { ...empty, gates: [{ ...gate, tool: "bash", requires: ["read"] }] } }))
      .not.toThrow();
  });
});

describe("layer versions", () => {
  const item = (id: string, text: string, models: string[]): LayerItem => ({
    id, kind: "instruction", text, validated: { models, harnesses: ["pi"] }, source: {}, pinned: false, archived: false,
    added: "2026-10-27T00:00:00.000Z",
  });

  it("keeps each conversation on the versions in use when it was made, filtered to its model", async () => {
    const versions = new LayerVersions(join(await mkdtemp(join(tmpdir(), "chopin-pinned-")), "layer"));
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("One."), fauxAssistantMessage("Two."), fauxAssistantMessage("Three.")]);
    const model = faux.getModel();
    const mine = `${model.provider}/${model.id}`;
    await versions.commit(() => [item("a", "Rule from version one.", [mine]), item("b", "Rule for another model.", ["other/model"])]);
    const source = { global: versions };
    const registry = createRegistry();
    registry.install(layerExtension(empty, new Set(["skill"]), source));
    const harness = await Harness.open(new MemoryStorage(), { models, registry, conversationCreated: pinLayerVersions(source) }, context);
    const agent = { model: { provider: model.provider, modelId: model.id } };
    const prompt = async (conversation: Awaited<ReturnType<typeof harness.createConversation>>) => {
      await (await conversation.submit({ type: "input", content: "Go." }, context)).wait(context);
      const { messages } = await conversation.context(context);
      return messages.filter((message) => message.role === "system").map((message) => JSON.stringify(message)).join("");
    };

    const early = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
    const first = await prompt(early);
    expect(first).toContain("Rule from version one.");
    expect(first).not.toContain("Rule for another model.");

    await versions.commit(() => [item("a", "Rule from version two.", [mine])]);
    const later = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
    expect(await prompt(later)).toContain("Rule from version two.");
    const again = await prompt(early);
    expect(again).toContain("Rule from version one.");
    expect(again).not.toContain("Rule from version two.");
  });
});
