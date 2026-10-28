import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Layer, TranscriptEntry } from "@chopin-ai/core";
import { describe, expect, it } from "vitest";
import { LoopFault } from "@chopin-ai/core";
import type { Message } from "@earendil-works/pi-ai";
import { continueAt, conversationProblems, layerExtension, stepText, transcriptMessages } from "../src/index.js";

const at = "2026-10-27T00:00:00.000Z";
const update = (value: object): TranscriptEntry => ({ at, notification: { sessionId: "s1", update: value as never } });
const layer = (instructions: string): Layer => ({ instructions, skills: [], mcpServers: {}, gates: [] });

// A session that failed at its second step: the user asked, the agent ran npm, the install failed.
const prefix: TranscriptEntry[] = [
  update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Install the dependencies." } }),
  update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", rawInput: { command: "npm install" } }),
  update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed",
    content: [{ type: "content", content: { type: "text", text: "npm ERR! this repository uses pnpm-lock.yaml" } }] }),
];

describe("transcriptMessages", () => {
  it("keeps each result right after its call, leaving out a result without its call and a call without its result", () => {
    const text = (sessionUpdate: string, words: string) => update({ sessionUpdate, content: { type: "text", text: words } });
    const model = fauxProvider().getModel();
    const messages = transcriptMessages([
      update({ sessionUpdate: "tool_call_update", toolCallId: "before", status: "completed", content: [] }),
      text("user_message_chunk", "Go."),
      update({ sessionUpdate: "tool_call", toolCallId: "a", title: "bash", rawInput: { command: "ls" } }),
      text("user_message_chunk", "Remember the lockfile."),
      update({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed", content: [] }),
      update({ sessionUpdate: "tool_call", toolCallId: "b", title: "bash", rawInput: { command: "sleep 99" } }),
      text("user_message_chunk", "Stop."),
    ], model);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
    expect(messages[1]).toMatchObject({ content: [{ type: "toolCall", id: "a" }], stopReason: "toolUse" });
    expect(messages[2]).toMatchObject({ toolCallId: "a" });
    expect(messages[3]).toMatchObject({ content: "Remember the lockfile.\nStop." });
  });
});

describe("conversationProblems", () => {
  const model = fauxProvider().getModel();
  const user: Message = { role: "user", content: "Go.", timestamp: 0 };
  const calling = (...ids: string[]): Message => ({
    role: "assistant", content: ids.map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} })), api: model.api, provider: model.provider,
    model: model.id, stopReason: "toolUse", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const result = (id: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "" }], isError: false, timestamp: 0 });

  it("finds what a provider refuses, and nothing in a conversation it takes", () => {
    expect(conversationProblems([user, calling("a", "b"), result("a"), result("b")])).toEqual([]);
    expect(conversationProblems([calling("a"), result("a")])).toEqual(["it does not open with the user"]);
    expect(conversationProblems([user, calling("a"), result("a"), calling("b")])).toEqual(["it ends with the agent", "a call in message 3 has no result right after it"]);
    expect(conversationProblems([user, calling("a"), user, result("a")])).toEqual([
      "a call in message 1 has no result right after it", "a result after message 2 answers no call in it",
    ]);
  });

  it("refuses to send such a conversation, before the model is asked", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const asked = { count: 0 };
    faux.setResponses([() => ((asked.count += 1), fauxAssistantMessage("never"))]);
    const call = continueAt({ messages: [calling("a"), result("a")], extensions: [CodingTools], model: faux.getModel(), models });
    await expect(call).rejects.toBeInstanceOf(LoopFault);
    expect(asked.count).toBe(0);
  });
});

describe("continueAt", () => {
  it("asks for the step after the last word of the user or a tool, leaving out text the agent began it with", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    let sent = "";
    let last = "";
    faux.setResponses([(context) => ((sent = JSON.stringify(context.messages)), (last = context.messages.at(-1)?.role ?? ""), fauxAssistantMessage("ok"))]);
    const begun = [...prefix, update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Let me try pnpm." } })];
    await continueAt({ messages: transcriptMessages(begun, model), extensions: [CodingTools, layerExtension(layer("Be brief."), new Set())], model, models });
    expect(last).toBe("toolResult");
    expect(sent).not.toContain("Let me try pnpm.");
  });

  it("asks for the next step with the session so far and the given layer, running nothing", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const sent: string[] = [];
    const reply = fauxAssistantMessage(fauxToolCall("bash", { command: "pnpm install" }), { stopReason: "toolUse" });
    faux.setResponses([(context) => (sent.push(JSON.stringify(context)), reply), (context) => (sent.push(JSON.stringify(context)), reply)]);
    const messages = transcriptMessages(prefix, model);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);

    const before = await continueAt({ messages, extensions: [CodingTools, layerExtension(layer("Keep changes small."), new Set())], model, models });
    const after = await continueAt({
      messages, extensions: [CodingTools, layerExtension(layer("Keep changes small.\n\nUse the package manager the lockfile names."), new Set())],
      model, models,
    });

    expect(sent[0]).toContain("Keep changes small.");
    expect(sent[0]).not.toContain("lockfile names");
    expect(sent[1]).toContain("Use the package manager the lockfile names.");
    for (const request of sent) {
      expect(request).toContain("npm ERR! this repository uses pnpm-lock.yaml");
      expect(request).toContain('"bash"');
    }
    expect(stepText(after)).toBe(JSON.stringify([{ call: "bash", arguments: { command: "pnpm install" } }]));
    expect(before.stopReason).toBe("toolUse");
  });
});
