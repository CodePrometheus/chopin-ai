import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentService, launchToken, listen } from "../../dist/index.js";
import { CALL_TIMEOUT_MS } from "../../dist/protocol.js";

const { COMPRESS_ABOVE } = await import(new URL("./link/part.js", import.meta.resolve("@earendil-works/chord")));
const directory = process.env.CHOPIN_PROTOCOL_FIXTURE_DIR;
if (!directory) throw new Error("CHOPIN_PROTOCOL_FIXTURE_DIR is required");
await mkdir(join(directory, "workspace"), { recursive: true });
const print = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const durableReview = process.env.CHOPIN_PROTOCOL_REVIEW === "durable";
const provider = fauxProvider(durableReview ? { models: [{ id: "worker" }, { id: "reviewer" }, { id: "replacement" }] } : {});
const models = createModels({ credentials: new InMemoryCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } });
models.setProvider(provider.provider);
const model = provider.getModel();
provider.setResponses([fauxAssistantMessage("Goal answer")]);
let reviewRelease;
const reviewHeld = new Promise((resolve) => { reviewRelease = resolve; });
let workerCalls = 0;
let reviewerCalls = 0;
let failReview = false;
if (durableReview) {
  const respond = async (request, _options, _state, selected) => {
    provider.appendResponses([respond]);
    if (selected.id === "worker") { workerCalls++; return fauxAssistantMessage("Goal answer"); }
    reviewerCalls++;
    if (failReview) { failReview = false; return fauxAssistantMessage("No decision yet"); }
    const result = request.messages.findLast((message) => message.role === "toolResult" && message.toolName === "goal_history");
    if (result === undefined) return fauxAssistantMessage(fauxToolCall("goal_history", { limit: 1 }, { id: "source" }), { stopReason: "toolUse" });
    const page = JSON.parse(result.content[0].text);
    const entry = page.entries[0];
    if (entry?.model?.[0]?.content?.[0]?.text !== "Goal answer") throw new Error("review source did not match");
    print({ event: "review-ready", workerCalls, reviewerCalls, entry: entry.id, model: selected.id });
    await reviewHeld;
    return fauxAssistantMessage(fauxToolCall("goal_decide", { kind: "complete", summary: "Original source checked", evidence: [{ kind: "assistant", criterion: 0, entryId: entry.id }] }, { id: "decision" }), { stopReason: "toolUse" });
  };
  provider.setResponses([respond]);
}
let goalWaiting = false;
const workspaces = {
  open: (owner) => ({
    owner, root: join(directory, "workspace"), state: async () => "running",
    start: async () => {}, pause: async () => {}, stop: async () => {}, destroy: async () => {},
    command: (argv, env = {}) => ({ argv: [...argv], env: { ...env } }),
  }),
  list: async () => [],
};
let calls = 0;
let release;
const held = new Promise((resolve) => { release = resolve; });
const large = "a".repeat(COMPRESS_ABOVE + 1);
let settings = { weeklyBudgetUsd: null, regularModel: null, strongModel: null, holdForReview: true };
const loop = {
  standing: async () => ({ version: 1, inUse: 0, archived: 0, kinds: 0, recurring: 0, shelved: 0, corrections: 0, held: 0, spentUsd: 0, weeklyBudgetUsd: null }),
  changes: async () => [{ id: "large", added: "2026-01-01", kind: "instruction", archived: false, text: large }],
  undo: async () => { calls++; print({ event: "method-started", calls }); await held; },
  corrections: async () => [], answer: async () => undefined,
  held: async () => [], decide: async () => undefined,
  settings: async () => settings,
  setSettings: async (patch) => (settings = { ...settings, ...patch }),
};
const service = new AgentService({ dataDir: join(directory, "data"), workspaces, models: () => models,
  goals: () => ({ allowDirectConversations: true, authorize: async () => ({ allowed: true }), settled: async () => {}, retryAfterMs: CALL_TIMEOUT_MS, report: (error) => process.stderr.write(String(error) + "\n"),
    review: durableReview ? { model: { provider: model.provider, modelId: process.env.CHOPIN_PROTOCOL_REVIEW_MODEL } } : async ({ entries }) => {
      if (goalWaiting) return { kind: "wait", reason: "Confirm the original answer" };
      const entry = (await entries(1)).items[0];
      if (entry?.model?.[0]?.content?.[0]?.text !== "Goal answer") throw new Error("fixture answer did not match");
      return { kind: "complete", summary: "Goal answer was checked", evidence: [{ kind: "assistant", criterion: 0, entryId: entry.id }] };
    },
  }),
  agent: { model: { provider: model.provider, modelId: model.id } } });
const server = await listen(service, { authenticate: launchToken("fixture-credential"), loop });
print({ url: `ws://127.0.0.1:${server.port}/`, credential: "fixture-credential", timeoutMs: CALL_TIMEOUT_MS, largeBytes: large.length });
const input = createInterface({ input: process.stdin });
try {
  for await (const line of input) {
    const command = JSON.parse(line);
    if (command.op === "release") { release(); print({ event: "released", calls }); }
    else if (command.op === "review-release") { print({ event: "review-released" }); reviewRelease(); }
    else if (command.op === "review-retry") { failReview = true; print({ event: "review-retry" }); }
    else if (command.op === "goal-wait") { goalWaiting = true; print({ event: "goal-wait" }); }
    else if (command.op === "goal-continue") { goalWaiting = false; provider.setResponses([fauxAssistantMessage("Goal answer")]); print({ event: "goal-continue" }); }
    else if (command.op === "history") {
      const conversation = await service.newConversation("local", BACKGROUND_CONTEXT);
      const ids = await conversation.commit(async (tx) => {
        const ids = [];
        for (const text of ["first", "second", "third"]) ids.push((await tx.appendEntry(conversation.id, { kind: "fixture.entry", data: { text } })).id);
        return ids;
      }, BACKGROUND_CONTEXT);
      print({ event: "history", conversation: conversation.id, entries: ids });
    }
    else if (command.op === "stop") break;
    else throw new Error("unknown fixture operation");
  }
} finally {
  input.close();
  release();
  reviewRelease();
  await server.close();
  await service.close(BACKGROUND_CONTEXT);
  process.stdin.destroy();
}
