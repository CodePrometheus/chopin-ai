import type { ContentBlock, StopReason, ToolCallContent, ToolKind, SessionUpdate, Usage as AcpUsage } from "@agentclientprotocol/sdk";
import type { AssistantMessage, ImageContent, Message, TextContent, Usage } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";

/** A tool call's input as clients show it: its JSON, or nothing when it has none or no JSON says it. */
export function inputText(rawInput: unknown): string {
  const text = rawInput === undefined ? undefined : JSON.stringify(rawInput);
  return text === undefined || text === "{}" ? "" : text;
}

/** Text with its direction overrides and isolates marked, so a client shows it in the order it was written. */
export function inWrittenOrder(text: string): string {
  return text.replace(/[\u202a-\u202e\u2066-\u2069]/g, "\ufffd");
}

/** What a committed entry says, in ACP. Entries without a model-facing message say nothing. */
export function entryUpdates(entry: EntryRecord): SessionUpdate[] {
  return (entry.model ?? []).flatMap(messageUpdates);
}

/** What the agent is generating right now, in ACP; nothing between generations. */
export function liveUpdates(view: ConversationView): SessionUpdate[] {
  const partial = (view.docs["pi.live"]?.generation as { message?: Message } | undefined)?.message;
  return partial === undefined ? [] : messageUpdates(partial);
}

/** Whether the conversation has a run in progress. */
export function isRunning(view: ConversationView): boolean {
  return view.docs["pi.live"]?.run !== undefined;
}

/** The submissions the run in progress serves, none between runs. */
export function runInputs(view: ConversationView): number[] {
  return (view.docs["pi.live"]?.run as { inputs?: number[] } | undefined)?.inputs ?? [];
}

/** The text a tool returned. */
export function toolText(content: readonly ToolCallContent[]): string {
  return content.flatMap((item) => (item.type === "content" && item.content.type === "text" ? [item.content.text] : [])).join("\n");
}

function messageUpdates(message: Message): SessionUpdate[] {
  switch (message.role) {
    case "user": {
      const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
      return blocks.map((block) => ({ sessionUpdate: "user_message_chunk", content: content(block) }));
    }
    case "assistant":
      return message.content.map((block): SessionUpdate => {
        if (block.type === "text") return { sessionUpdate: "agent_message_chunk", content: content(block) };
        if (block.type === "thinking") return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } };
        return {
          sessionUpdate: "tool_call", toolCallId: block.id, title: block.name, kind: toolKind(block.name),
          status: "pending", rawInput: block.arguments,
        };
      });
    case "toolResult":
      return [{
        sessionUpdate: "tool_call_update", toolCallId: message.toolCallId, status: message.isError ? "failed" : "completed",
        content: message.content.map((block) => ({ type: "content", content: content(block) })),
      }];
    default:
      return [];
  }
}

function content(block: TextContent | ImageContent): ContentBlock {
  return block.type === "text" ? { type: "text", text: block.text } : { type: "image", data: block.data, mimeType: block.mimeType };
}

function toolKind(name: string): ToolKind {
  if (name === "read" || name === "skill") return "read";
  if (name === "write" || name === "edit") return "edit";
  if (name === "bash") return "execute";
  return "other";
}

export function stopReason(message: AssistantMessage | undefined): StopReason {
  if (message?.stopReason === "aborted") return "cancelled";
  if (message?.stopReason === "length") return "max_tokens";
  return "end_turn";
}

/** Token totals over the given assistant messages, in ACP's usage shape. */
export function totalUsage(messages: readonly AssistantMessage[]): { usage: AcpUsage; cost: number } {
  const sum = (pick: (usage: Usage) => number | undefined) => messages.reduce((total, m) => total + (pick(m.usage) ?? 0), 0);
  const cacheRead = sum((u) => u.cacheRead);
  const cacheWrite = sum((u) => u.cacheWrite);
  return {
    usage: {
      totalTokens: sum((u) => u.totalTokens),
      inputTokens: sum((u) => u.input) + cacheRead + cacheWrite,
      outputTokens: sum((u) => u.output),
      thoughtTokens: sum((u) => u.reasoning),
      cachedReadTokens: cacheRead,
      cachedWriteTokens: cacheWrite,
    },
    cost: sum((u) => u.cost.total),
  };
}

/** Why a submission got no answer, with the harness's detail, such as the provider's own message, when it gave one. */
export function unansweredText(settled: { reason: string; detail?: unknown }): string {
  const detail = detailText(settled.detail);
  return detail === undefined ? settled.reason : `${settled.reason}: ${detail}`;
}

/** The detail the harness gave with an unanswered submission, as text. */
export function detailText(detail: unknown): string | undefined {
  return detail === undefined ? undefined : typeof detail === "string" ? detail : JSON.stringify(detail);
}
