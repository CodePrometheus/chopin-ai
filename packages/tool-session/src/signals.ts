/**
 * Mechanically extract "might be a lesson" signals from session logs.
 *
 * This layer calls no model, on the same principle as triage: the deterministic part is
 * done in code, judgement is left to the mission. It only answers "what keeps going wrong",
 * not "does this count as a lesson"; the latter needs the ledger and a check on whether it
 * is already a rule, which the curate mission does with its gates.
 *
 * Three things are borrowed from a continuous-learning extension written for a comparable harness; they decide whether the output is useful:
 *
 * 1. **Scrubbing**: logs carry command lines and raw errors with tokens and keys mixed in.
 *    Wipe them before handing anything to the model, or a secret enters the context once more.
 * 2. **Merging near-duplicates**: the same failure is worded differently across sessions
 *    (paths, timestamps, pids). Merge on the ledger's normalization as the key, or the list
 *    drowns in ten spellings of one thing.
 * 3. **Keeping only what recurs**: occurrence count is the only mechanically decidable
 *    "worth attention". A one-off failure is noise, not a lesson.
 *
 * "Drop general knowledge" is not here: what "the model should know anyway" means takes
 * judgement, and hard-coding it only yields a keyword list that is never right. That
 * constraint lives in curate's persona and output schema.
 *
 * @module @chopin/tool-session/signals
 */

import { parseGateDenial } from "@chopin/gate";
import { buildSignalKey, scrub } from "@chopin/ledger";

import type { SessionEventRecord, SessionLog } from "./read.js";

export { scrub } from "@chopin/ledger";

/** Signal kinds. All are things a machine can recognize and that are worth a look once they recur. */
export type SignalKind =
  /** A submission stopped by a gate. Being stopped by the same gate repeatedly points to a gap in the process or the tools. */
  | "gate-rejection"
  /** A failed tool call. The same tool failing the same way repeatedly is usually an environment or usage problem. */
  | "tool-failure";

export interface Signal {
  kind: SignalKind;
  /** Normalized merge key. */
  key: string;
  /** Name of the tool involved. */
  tool: string;
  /** Unmet rule ids on a gate rejection; empty for a plain tool failure. */
  gates: string[];
  /** One representative raw text (scrubbed and truncated). */
  sample: string;
  /** Occurrences, accumulated across sessions. */
  occurrences: number;
  /** Number of distinct sessions it appeared in; says more about recurrence than the total count. */
  sessions: number;
  /** Workspaces involved. */
  workspaces: string[];
  /** Time of the last occurrence. */
  lastSeenMs: number;
}

function textOfToolResult(event: SessionEventRecord): { callId: string; isError: boolean; text: string } | undefined {
  const message = (event.data as { message?: { content?: unknown[] } } | undefined)?.message;
  const block = message?.content?.[0] as
    | { toolCallId?: string; isError?: boolean; content?: { type?: string; text?: string }[] }
    | undefined;
  if (block?.toolCallId === undefined) return undefined;
  const text = (block.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
  return { callId: block.toolCallId, isError: block.isError === true, text };
}

/** Mutable form of a signal while it is being collected. */
interface Draft extends Omit<Signal, "workspaces"> {
  workspaces: Set<string>;
  sessionIds: Set<string>;
}

/**
 * Extract signals from a set of sessions.
 * @param logs - Session logs.
 * @param options - `minOccurrences` is how many occurrences count (default 2; a one-off is not a lesson).
 * @returns Signals in descending order of occurrence.
 */
export function extractSignals(logs: readonly SessionLog[], options: { minOccurrences?: number } = {}): Signal[] {
  const minOccurrences = options.minOccurrences ?? 2;
  const drafts = new Map<string, Draft>();

  const record = (kind: SignalKind, tool: string, gates: string[], raw: string, log: SessionLog): void => {
    const sample = scrub(raw).replace(/\s+/g, " ").trim().slice(0, 400);
    if (sample === "") return;
    const key = buildSignalKey({ kind, tool, gate: gates.join("+"), error: sample });
    const draft = drafts.get(key) ?? {
      kind,
      key,
      tool,
      gates,
      sample,
      occurrences: 0,
      sessions: 0,
      workspaces: new Set<string>(),
      sessionIds: new Set<string>(),
      lastSeenMs: 0,
    };
    draft.occurrences += 1;
    draft.workspaces.add(log.workspace);
    draft.sessionIds.add(log.id);
    draft.lastSeenMs = Math.max(draft.lastSeenMs, log.modifiedAt);
    drafts.set(key, draft);
  };

  for (const log of logs) {
    // Build the callId -> tool name map first: result events carry only the callId, not the name.
    const toolByCall = new Map<string, string>();
    for (const event of log.events) {
      if (event.type !== "tool/call") continue;
      const data = event.data as { callId?: string; name?: string } | undefined;
      if (data?.callId !== undefined && data.name !== undefined) toolByCall.set(data.callId, data.name);
    }
    for (const event of log.events) {
      if (event.type !== "tool/result") continue;
      const result = textOfToolResult(event);
      if (result === undefined || !result.isError) continue;
      const tool = toolByCall.get(result.callId) ?? "unknown";
      const denial = parseGateDenial(result.text);
      record(denial === undefined ? "tool-failure" : "gate-rejection", tool, denial?.unmet ?? [], result.text, log);
    }
  }

  return [...drafts.values()]
    .map((draft) => ({
      kind: draft.kind,
      key: draft.key,
      tool: draft.tool,
      gates: draft.gates,
      sample: draft.sample,
      occurrences: draft.occurrences,
      sessions: draft.sessionIds.size,
      workspaces: [...draft.workspaces].sort(),
      lastSeenMs: draft.lastSeenMs,
    }))
    .filter((signal) => signal.occurrences >= minOccurrences)
    .sort((a, b) => b.sessions - a.sessions || b.occurrences - a.occurrences);
}
