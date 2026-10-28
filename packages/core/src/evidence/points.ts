import { chopinMeta } from "../meta.js";
import type { TranscriptEntry } from "../transcript.js";
import type { Signal } from "./signals.js";

/** Whether the entry is something the user wrote, not text the harness added in the user's role. */
export function isUserWritten(entry: TranscriptEntry): boolean {
  if (!("notification" in entry)) return false;
  const update = entry.notification.update;
  return update.sessionUpdate === "user_message_chunk" && chopinMeta(update)?.injected !== true;
}

/**
 * A place to continue a session from: the agent step at `line`, with every line before it as the context. Continuing
 * there shows what another version of the agent would have done instead.
 */
export interface DecisionPoint {
  session: string;
  line: number;
}

/**
 * The session before `line` to continue from: the last `size` lines or so, begun at a message in the user's role,
 * as a conversation must be; one is looked for up to `size` lines further back, and without one there is none.
 */
export function continuationPrefix(entries: readonly TranscriptEntry[], line: number, size: number): TranscriptEntry[] | undefined {
  const cut = Math.max(0, line - size);
  const userTurn = (at: number) => {
    const entry = entries[at]!;
    return "notification" in entry && entry.notification.update.sessionUpdate === "user_message_chunk";
  };
  for (let start = cut; start < line; start += 1) if (userTurn(start)) return entries.slice(start, line);
  for (let start = cut - 1; start >= Math.max(0, cut - size); start -= 1) if (userTurn(start)) return entries.slice(start, line);
  return undefined;
}

/** The agent step a failure goes back to: the failed call itself, or the last step before the user stepped in. */
export function failureStep(entries: readonly TranscriptEntry[], signal: Signal): number | undefined {
  if (signal.kind === "tool_failed") {
    return entries.findIndex((entry) => "notification" in entry && entry.notification.update.sessionUpdate === "tool_call" &&
      entry.notification.update.toolCallId === signal.toolCallId);
  }
  return lastAgentStep(entries, signal.line);
}

/** The agent step a user's correction answers: the last one before the user spoke. */
export function correctedStep(entries: readonly TranscriptEntry[], line: number): number | undefined {
  return lastAgentStep(entries, line);
}

/**
 * Agent steps that went right: tool calls that completed, in turns where nothing went wrong afterwards before the user
 * spoke again. `wrong` holds the lines of the session's signals and corrections.
 */
export function goodSteps(entries: readonly TranscriptEntry[], wrong: readonly number[]): number[] {
  const completed = new Set(entries.flatMap((entry) =>
    "notification" in entry && entry.notification.update.sessionUpdate === "tool_call_update" &&
      entry.notification.update.status === "completed" ? [entry.notification.update.toolCallId] : []));
  return entries.flatMap((entry, line) => {
    if (!("notification" in entry)) return [];
    const update = entry.notification.update;
    if (update.sessionUpdate !== "tool_call" || !completed.has(update.toolCallId)) return [];
    const end = nextUserLine(entries, line);
    return wrong.some((bad) => bad > line && bad <= end) ? [] : [line];
  });
}

function isAgentStep(entry: TranscriptEntry): boolean {
  if (!("notification" in entry)) return false;
  const kind = entry.notification.update.sessionUpdate;
  return kind === "tool_call" || kind === "agent_message_chunk";
}

function lastAgentStep(entries: readonly TranscriptEntry[], before: number): number | undefined {
  for (let line = before - 1; line >= 0; line -= 1) if (isAgentStep(entries[line]!)) return line;
  return undefined;
}

function nextUserLine(entries: readonly TranscriptEntry[], after: number): number {
  const next = entries.findIndex((entry, line) => line > after && isUserWritten(entry));
  return next === -1 ? entries.length : next;
}
