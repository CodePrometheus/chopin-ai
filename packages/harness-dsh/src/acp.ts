import type { SessionUpdate, StopReason, ToolKind } from "@agentclientprotocol/sdk";
import type { SessionEvent, TurnEndReason } from "@deepseek-ai/dsh-session";

type Block = { type: string; text?: string; id?: string; name?: string; arguments?: string };

/** What one session event says, in ACP. Events the model never sees say nothing. */
export function eventUpdates(event: SessionEvent): SessionUpdate[] {
  switch (event.type) {
    case "user/message":
      // Context the harness injects as user-role messages is not what the user said.
      if (event.data.source.kind !== "user") return [];
      return texts(event.data.content).map((text) => ({ sessionUpdate: "user_message_chunk", content: { type: "text", text } }));
    case "assistant/message":
      return (event.data.message.content as readonly Block[]).flatMap((block): SessionUpdate[] => {
        if (block.type === "text") return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text ?? "" } }];
        if (block.type === "reasoning") return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.text ?? "" } }];
        if (block.type !== "tool-call") return [];
        return [{
          sessionUpdate: "tool_call", toolCallId: block.id ?? "", title: block.name ?? "", kind: toolKind(block.name ?? ""),
          status: "pending", rawInput: parsed(block.arguments),
        }];
      });
    case "tool/result":
      return [{
        sessionUpdate: "tool_call_update", toolCallId: event.data.message.toolCallId,
        status: event.data.message.isError === true ? "failed" : "completed",
        content: texts(event.data.message.content).map((text) => ({ type: "content", content: { type: "text", text } })),
      }];
    default:
      return [];
  }
}

export function stopReason(reason: TurnEndReason): StopReason {
  if (reason.kind === "aborted") return "cancelled";
  if (reason.kind === "max-tokens") return "max_tokens";
  if (reason.kind === "blocked") return "refusal";
  return "end_turn";
}

function texts(content: readonly unknown[]): string[] {
  return (content as readonly Block[]).flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []));
}

/** ACP's kind of each built-in tool, a hint clients use to present the call. */
const KINDS: Readonly<Record<string, ToolKind>> = {
  read: "read", read_image: "read", skill: "read",
  glob: "search", grep: "search",
  write: "edit", edit: "edit", str_replace_editor: "edit",
  bash: "execute",
};

function toolKind(name: string): ToolKind {
  return Object.hasOwn(KINDS, name) ? (KINDS[name] as ToolKind) : "other";
}

/** Tool arguments travel as the model's JSON text; text that does not parse is kept as it is. */
function parsed(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
