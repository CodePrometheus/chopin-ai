import { LoopFault, type TranscriptEntry } from "@chopin-ai/core";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, AssistantMessage, Message, Model, Models, Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationId, DocumentReader, Extension, PromptInput } from "@earendil-works/pi-durable";

/** A decision point to continue from: what came before it, and what the request carries. */
export interface ContinuationInput {
  /** The session before the decision point, as model messages. */
  messages: readonly Message[];
  /** The extensions whose sections and tools the request carries, the layer's among them, in install order. */
  extensions: readonly Extension[];
  model: Model<Api>;
  models: Models;
  signal?: AbortSignal;
}

/**
 * The agent's next step at a decision point, from one request: the system prompt rendered from `extensions` as a
 * session's would be, the tools they offer, and the session so far. Nothing it asks for is run. Two versions of a
 * layer continued this way differ only in the layer.
 */
export async function continueAt(input: ContinuationInput): Promise<AssistantMessage> {
  const systemPrompt = await renderSections(input);
  const tools: Tool[] = input.extensions.flatMap((extension) => (extension.tools ?? []).map((tool) =>
    ({ name: tool.name, description: tool.description, parameters: tool.parameters })));
  // The step is asked for after the last word of the user or a tool; text the agent had begun it with is part of it.
  const messages = [...input.messages];
  while (messages.at(-1)?.role === "assistant") messages.pop();
  const problems = conversationProblems(messages);
  if (problems.length > 0) throw new LoopFault(`a provider would refuse this continuation: ${problems.join("; ")}`);
  return input.models.completeSimple(input.model, { systemPrompt, messages, tools }, {
    ...(input.signal && { signal: input.signal }),
  });
}

/**
 * What a provider would refuse in a conversation continued at a step: it must open with the user, give every call its
 * result right after it and no result without its call, and end with the user's or a tool's last word.
 */
export function conversationProblems(messages: readonly Message[]): string[] {
  const problems: string[] = [];
  if (messages[0]?.role !== "user") problems.push("it does not open with the user");
  const last = messages.at(-1)?.role;
  if (last !== "user" && last !== "toolResult") problems.push("it ends with the agent");
  messages.forEach((message, at) => {
    if (message.role === "toolResult") return;
    const calls = message.role === "assistant" ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])) : [];
    const results: string[] = [];
    for (let next = at + 1; messages[next]?.role === "toolResult"; next += 1) results.push((messages[next] as ToolResultMessage).toolCallId);
    if (calls.some((id) => !results.includes(id))) problems.push(`a call in message ${at} has no result right after it`);
    if (results.some((id) => !calls.includes(id))) problems.push(`a result after message ${at} answers no call in it`);
  });
  return problems;
}

/** The step as a judge reads it: what it said and the calls it asked for. */
export function stepText(step: AssistantMessage): string {
  return JSON.stringify(step.content.flatMap((block): object[] => {
    if (block.type === "text") return [{ text: block.text }];
    if (block.type === "toolCall") return [{ call: block.name, arguments: block.arguments }];
    return [];
  }));
}

/**
 * The model messages of an ACP transcript: the user's text, the agent's text and calls, and the calls' results.
 * Thoughts are left out, as no provider takes back another's. Assistant turns carry `model`'s identity, so the
 * provider reads them as its own. A provider takes a result only right after its call, so a result whose call is not
 * here is left out, as is a call that never got one, and what the user said while calls were running follows their
 * results.
 */
export function transcriptMessages(entries: readonly TranscriptEntry[], model: Model<Api>): Message[] {
  const messages: Message[] = [];
  const names = new Map<string, string>();
  const waiting = new Set<string>();
  let held: string[] = [];
  const assistant = (): AssistantMessage => {
    const last = messages.at(-1);
    if (last?.role === "assistant") return last;
    const made: AssistantMessage = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: 0,
    };
    messages.push(made);
    return made;
  };
  const say = (text: string) => {
    const last = messages.at(-1);
    if (last?.role === "user" && typeof last.content === "string") last.content = `${last.content}\n${text}`;
    else messages.push({ role: "user", content: text, timestamp: 0 });
  };
  const flush = () => {
    for (const text of held) say(text);
    held = [];
  };
  // Calls still waiting when the agent moves on never got a result.
  const settle = () => {
    if (waiting.size > 0) {
      for (let at = messages.length - 1; at >= 0; at -= 1) {
        const message = messages[at]!;
        if (message.role !== "assistant") continue;
        message.content = message.content.filter((block) => block.type !== "toolCall" || !waiting.has(block.id));
        if (message.content.length === 0) messages.splice(at, 1);
        else if (!message.content.some((block) => block.type === "toolCall")) message.stopReason = "stop";
      }
      waiting.clear();
    }
    flush();
  };
  for (const entry of entries) {
    if (!("notification" in entry)) continue;
    const update = entry.notification.update;
    if (update.sessionUpdate === "user_message_chunk" && update.content.type === "text") {
      if (waiting.size > 0) held.push(update.content.text);
      else say(update.content.text);
    } else if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      settle();
      assistant().content.push({ type: "text", text: update.content.text });
    } else if (update.sessionUpdate === "tool_call") {
      if (messages.at(-1)?.role !== "assistant") settle();
      names.set(update.toolCallId, update.title);
      const call: ToolCall = { type: "toolCall", id: update.toolCallId, name: update.title, arguments: (update.rawInput ?? {}) as ToolCall["arguments"] };
      const turn = assistant();
      turn.content.push(call);
      turn.stopReason = "toolUse";
      waiting.add(update.toolCallId);
    } else if (update.sessionUpdate === "tool_call_update" && (update.status === "completed" || update.status === "failed")) {
      if (!waiting.delete(update.toolCallId)) continue;
      const text = (update.content ?? []).flatMap((item) => (item.type === "content" && item.content.type === "text" ? [item.content.text] : [])).join("\n");
      messages.push({
        role: "toolResult", toolCallId: update.toolCallId, toolName: names.get(update.toolCallId) ?? update.title ?? "",
        content: [{ type: "text", text }], isError: update.status === "failed", timestamp: 0,
      });
      if (waiting.size === 0) flush();
    }
  }
  settle();
  return messages;
}

const NO_DOCUMENTS = { snapshot: async () => undefined, snapshotAsOf: async () => undefined } as unknown as DocumentReader;

async function renderSections(input: ContinuationInput): Promise<string> {
  const sections = input.extensions.flatMap((extension) => extension.sections ?? []);
  const prompt: PromptInput = {
    conversationId: 0 as ConversationId,
    agent: {
      model: { provider: input.model.provider, modelId: input.model.id }, thinkingLevel: "off", extensions: input.extensions,
      tools: input.extensions.flatMap((extension) => extension.tools ?? []), callable: [], deferred: [], sections,
    },
    env: undefined,
    shown: {},
    read: NO_DOCUMENTS,
  };
  const rendered: string[] = [];
  for (const section of sections) {
    const text = await section.render(prompt, BACKGROUND_CONTEXT);
    if (text === undefined || text === "") continue;
    rendered.push(section.tag === false ? text : `<${section.key}>\n${text}\n</${section.key}>`);
  }
  return rendered.join("\n\n");
}
