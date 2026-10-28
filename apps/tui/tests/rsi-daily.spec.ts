import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { localDaemon } from "@earendil-works/pi-env";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { AdmissionLedger, LayerVersions, Rejections, type Layer } from "@chopin-ai/core";
import { AgentService, continueAt, layerExtension, stepText, transcriptMessages } from "@chopin-ai/harness-pi";
import { DirectoryWorkspaceProvider } from "@chopin-ai/workspace";
import { afterEach, describe, expect, it } from "vitest";
import { exportTranscripts } from "../src/rsi/export.js";
import { evolveUndoCommand } from "../src/rsi/evolve.js";
import { Evidence, harvest, sessionSources } from "../src/rsi/harvest.js";
import { HeldProposals } from "../src/rsi/held.js";
import { runRounds } from "../src/rsi/round.js";

const RULE = "List a directory before reading a file in it.";
const EMPTY: Layer = { instructions: undefined, skills: [], mcpServers: {}, gates: [] };

const previous = process.env.CHOPIN_HOME;
afterEach(() => {
  if (previous === undefined) delete process.env.CHOPIN_HOME;
  else process.env.CHOPIN_HOME = previous;
});

const textOf = (content: unknown) =>
  typeof content === "string" ? content : (content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("");

/**
 * The agent as a fake model: asked for the notes, it reads a file that is not there, unless its prompt carries the
 * rule; asked to list files, it lists them; told anything else, it answers. Every request it is given is kept.
 */
function agentModel() {
  const prompts: { asked: string; request: string }[] = [];
  const answer = (request: Context) => {
    const last = request.messages.at(-1);
    if (last?.role === "toolResult") return fauxAssistantMessage("Done.");
    const asked = textOf(last?.content);
    const seen = JSON.stringify(request);
    prompts.push({ asked, request: seen });
    const run = (command: string) => fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
    if (asked.includes("Show the notes.")) return run(seen.includes(RULE) ? "ls" : "cat notes.txt");
    if (asked.includes("List files.")) return run("ls");
    return fauxAssistantMessage("Ok.");
  };
  return { prompts, responses: Array.from({ length: 400 }, () => answer) };
}

/** The loop's models: one name for every failure, no corrections, the rule as the proposal, and plain judges. */
async function loopModel(prompt: string): Promise<string> {
  if (prompt.startsWith("An agent's session may have gone wrong")) return '{"cause":"wrong_command","behavior":"read","mechanism":"reads-unlisted-file"}';
  if (prompt.includes("Reply with only \"repeats\" or \"avoids\"")) {
    return prompt.split("A version of the agent took this next step instead:")[1]!.includes("cat notes.txt") ? "repeats" : "avoids";
  }
  if (prompt.includes("Reply with only \"as_good\" or \"worse\"")) {
    const [, original, step] = /The step that went right:\n([\s\S]*)\nAnother version of the agent took this step instead:\n([\s\S]*)\nIs it/.exec(prompt)!;
    return original === step ? "as_good" : "worse";
  }
  if (prompt.startsWith("You audit")) return '{"task_specific":false,"unsafe":false,"overlaps":null,"reasons":[]}';
  if (prompt.includes("one change")) return JSON.stringify({ kind: "instruction", text: RULE, scope: "global", revises: null, prediction: "ls before cat" });
  return "[]";
}

describe("the daily loop", () => {
  it("learns a rule from two failed sessions, gives it to new conversations only, and takes it back", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "chopin-daily-")));
    process.env.CHOPIN_HOME = home;
    const root = await mkdtemp(join(tmpdir(), "chopin-daily-project-"));
    const agent = agentModel();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    faux.setResponses(agent.responses);
    const versions = new LayerVersions(join(home, "rsi", "layer"));
    const service = new AgentService({
      dataDir: join(home, "projects", "p1", "data"), workspaces: new DirectoryWorkspaceProvider(root), daemon: localDaemon(),
      models: () => models, agent: { model: { provider: model.provider, modelId: model.id } },
      layerVersions: { global: versions, anyModel: true },
    });
    const say = async (conversation: Awaited<ReturnType<AgentService["newConversation"]>>, text: string) =>
      (await conversation.submit({ type: "input", content: text }, context)).wait(context);
    const requestFor = (asked: string) => agent.prompts.filter((prompt) => prompt.asked === asked).at(-1)?.request ?? "";
    try {
      const before = await service.newConversation("local", context);
      for (const asked of ["Show the notes.", "Show the notes.", "List files.", "List files."]) await say(await service.newConversation("local", context), asked);
      expect(await exportTranscripts(service, join(home, "projects", "p1", "rsi", "transcripts"))).toBe(4);

      const evidence = new Evidence(join(home, "rsi", "evidence"));
      const sources = await sessionSources(home, []);
      expect(await harvest(evidence, sources, loopModel, [])).toMatchObject({ read: 4, failures: 2 });
      const [outcome] = await runRounds({
        evidence, sources, versions, base: EMPTY, projectOf: () => undefined,
        ledger: new AdmissionLedger(join(home, "rsi", "ledger.jsonl")), rejections: new Rejections(join(home, "rsi", "rejections.jsonl")),
        certificates: join(home, "rsi", "certificates"), propose: loopModel, judge: loopModel, rules: "", model: `${model.provider}/${model.id}`, secrets: [],
        held: new HeldProposals(join(home, "rsi", "held.jsonl")),
        continueStep: async (layer, prefix) => stepText(await continueAt({
          messages: transcriptMessages(prefix, model), extensions: [CodingTools, layerExtension(layer, new Set())], model, models,
        })),
      });
      expect(outcome?.outcome).toBe("kept");

      await say(await service.newConversation("local", context), "After.");
      expect(requestFor("After.")).toContain(RULE);
      // A conversation made before the change keeps the layer it started with.
      await say(before, "Before.");
      expect(requestFor("Before.")).not.toContain(RULE);

      const [item] = await versions.items(await versions.current());
      const io = { out: () => {}, err: (text: string) => { throw new Error(text); } };
      expect(await evolveUndoCommand.run([item!.id.slice(0, 8)], io)).toBe(0);
      await say(await service.newConversation("local", context), "Undone.");
      expect(requestFor("Undone.")).not.toContain(RULE);
      // The failure is still there, so the loop takes it up again, told that this change was undone.
      expect(await evidence.answered()).not.toContain(item!.source.failure);
      expect(await new Rejections(join(home, "rsi", "rejections.jsonl")).for(item!.source.failure!)).toMatchObject([{ text: RULE, reason: expect.stringContaining("undid") }]);
    } finally {
      await service.close(context);
    }
  }, 30_000);
});
