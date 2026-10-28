import { chopinMeta } from "../meta.js";
import type { TranscriptEntry } from "../transcript.js";

/** A failure at the line where it happened: one the transcript records, or a correction the user confirmed. */
export type Signal =
  | { kind: "tool_failed"; line: number; tool: string; toolCallId: string; blocked: boolean }
  | { kind: "interrupted"; line: number }
  | { kind: "turn_failed"; line: number; error: string }
  | { kind: "corrected"; line: number; summary: string };

/**
 * Failed tool calls, turns the user cut off, and turns that ended without an answer. A call the user declined is no
 * failure of the agent's; what the user says next is a correction to confirm.
 */
export function signals(entries: readonly TranscriptEntry[]): Signal[] {
  const tools = new Map<string, string>();
  return entries.flatMap((entry, line): Signal[] => {
    if ("turnEnd" in entry) {
      if (entry.turnEnd.stopReason === "cancelled") return [{ kind: "interrupted", line }];
      const error = chopinMeta(entry.turnEnd)?.error;
      return error === undefined ? [] : [{ kind: "turn_failed", line, error }];
    }
    const update = entry.notification.update;
    if (update.sessionUpdate === "tool_call") tools.set(update.toolCallId, update.title);
    if (update.sessionUpdate !== "tool_call_update" || update.status !== "failed") return [];
    const diagnostics = chopinMeta(update)?.diagnostics ?? [];
    if (diagnostics.includes("rejected")) return [];
    const tool = tools.get(update.toolCallId) ?? update.title ?? "";
    const blocked = diagnostics.includes("blocked");
    return [{ kind: "tool_failed", line, tool, toolCallId: update.toolCallId, blocked }];
  });
}
