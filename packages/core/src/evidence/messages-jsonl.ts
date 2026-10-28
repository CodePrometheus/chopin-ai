import type { SessionUpdate, ToolKind } from "@agentclientprotocol/sdk";
import { withChopinMeta } from "../meta.js";
import type { TranscriptEntry } from "../transcript.js";

/**
 * Tool names other agents use, as the tools chopin has. A call with no counterpart keeps its own name, and a
 * continuation skips the steps it cannot offer.
 */
const TOOLS: Readonly<Record<string, string>> = { Read: "read", Write: "write", Edit: "edit", MultiEdit: "edit", Bash: "bash" };

const INTERRUPTED = "[Request interrupted by user";
/** How these logs record a tool call the user declined to let run. */
const REJECTED = "User rejected tool use";

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: string | { type: string; text?: string }[]; is_error?: boolean }
  | { type: string };

type Line = {
  type?: string;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  /** `typed` for what the user wrote; reminders, command output and notifications carry other values or none. */
  promptSource?: string;
  toolUseResult?: unknown;
  message?: { role?: string; model?: string; stop_reason?: string; content?: string | Block[] };
};

/**
 * A transcript from session logs written one JSON object per line, each a user or assistant message whose content is
 * text, thinking, tool-use and tool-result blocks. Side threads and bookkeeping lines are left out; user-role text the
 * user did not write stays in, since the model saw it, marked as injected.
 */
export function fromMessagesJsonl(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const kinds = new Map<string, ToolKind>();
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    const message = line.message;
    if ((line.type !== "user" && line.type !== "assistant") || line.isSidechain === true || message === undefined) continue;
    const sessionId = line.sessionId ?? "";
    const at = line.timestamp ?? "";
    const blocks: Block[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
    if (message.role === "user") {
      for (const block of blocks) {
        if (block.type === "text" && "text" in block && block.text.startsWith(INTERRUPTED)) {
          entries.push({ at, sessionId, turnEnd: { stopReason: "cancelled" } });
        } else {
          const update = userUpdate(block, kinds, line.toolUseResult === REJECTED);
          const injected = update?.sessionUpdate === "user_message_chunk" && line.promptSource !== "typed";
          if (update !== undefined) {
            entries.push({ at, notification: { sessionId, update: injected ? withChopinMeta(update, { injected }) : update } });
          }
        }
      }
      continue;
    }
    for (const block of blocks) {
      const update = assistantUpdate(block, kinds);
      if (update !== undefined) entries.push({ at, notification: { sessionId, update } });
    }
    if (message.stop_reason === "end_turn") {
      const model = message.model === undefined ? {} : { model: { provider: "", id: message.model } };
      entries.push({ at, sessionId, turnEnd: withChopinMeta({ stopReason: "end_turn" }, model) });
    }
  }
  return entries;
}

function userUpdate(block: Block, kinds: Map<string, ToolKind>, rejected: boolean): SessionUpdate | undefined {
  if (block.type === "text" && "text" in block) return { sessionUpdate: "user_message_chunk", content: { type: "text", text: block.text } };
  if (block.type !== "tool_result" || !("tool_use_id" in block)) return undefined;
  const text = typeof block.content === "string"
    ? block.content
    : (block.content ?? []).flatMap((item) => (item.type === "text" && item.text !== undefined ? [item.text] : [])).join("\n");
  const update: SessionUpdate = {
    sessionUpdate: "tool_call_update", toolCallId: block.tool_use_id, status: block.is_error === true ? "failed" : "completed",
    kind: kinds.get(block.tool_use_id) ?? "other", content: [{ type: "content", content: { type: "text", text } }],
  };
  return rejected ? withChopinMeta(update, { diagnostics: ["rejected"] }) : update;
}

function assistantUpdate(block: Block, kinds: Map<string, ToolKind>): SessionUpdate | undefined {
  if (block.type === "text" && "text" in block) return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } };
  if (block.type === "thinking" && "thinking" in block) {
    return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } };
  }
  if (block.type !== "tool_use" || !("id" in block)) return undefined;
  const title = TOOLS[block.name] ?? block.name;
  const kind = toolKind(title);
  kinds.set(block.id, kind);
  return { sessionUpdate: "tool_call", toolCallId: block.id, title, kind, status: "pending", rawInput: block.input };
}

function toolKind(name: string): ToolKind {
  if (name === "read") return "read";
  if (name === "write" || name === "edit") return "edit";
  if (name === "bash") return "execute";
  return "other";
}
