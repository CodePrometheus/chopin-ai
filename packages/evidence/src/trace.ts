import { readFile } from "node:fs/promises";

/**
 * Session trace parser for the Pi harness.
 *
 * Works for any agent product running on Pi: the trace is the harness's format, not the product's.
 *
 * The trace is JSONL; the record types that matter:
 * - full_run: one conversation turn. .messages holds only the messages added in this run
 *   (the first one is the user prompt that triggered it); .contextCount is the number of
 *   history entries before the run started. History is rebuilt by chaining the earlier
 *   full_run records of the same file in runId order. The oldest format still inlines
 *   .context.messages.
 * - system_prompt: one per file (deduplicated by hash); the old format inlines it in full_run.
 * - The same runId also has message_end and similar lines (without .messages); parsing must
 *   filter by type, or picking the wrong line fails to parse.
 *
 * Truncation trap (zips written by <=1.1.4): user/toolResult text over 300 characters in the
 * run is cut to 300+... with an originalLength. That cut happened when the trace was written;
 * the model saw the full text, so never read it as "the model only got half". The parsed
 * result flags such fields explicitly.
 */

export interface TraceRunSummary {
  runId: string;
  /** Number of messages added in this run. */
  messageCount: number;
  /** Number of history entries before this run started. */
  contextCount: number;
  /** Text of the user prompt that triggered this run (cut to 200 characters). */
  firstUserText: string;
}

interface TraceMessage {
  role?: string;
  content?: unknown;
  /** Trace-side truncation marker in <=1.1.4 zips; the model actually received the full text. */
  originalLength?: number;
}

interface FullRunRecord {
  type: string;
  runId?: string;
  messages?: TraceMessage[];
  contextCount?: number;
  context?: { messages?: TraceMessage[] };
  systemPrompt?: string;
  content?: string;
}

async function readRecords(tracePath: string): Promise<FullRunRecord[]> {
  const text = await readFile(tracePath, "utf8");
  const records: FullRunRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as FullRunRecord);
    } catch {
      // Tolerate bad lines: a truncated last line must not make the whole file unreadable
    }
  }
  return records;
}

function messageText(msg: TraceMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => (typeof c === "object" && c !== null && "text" in c ? String((c as { text: unknown }).text) : ""))
      .join(" ");
  }
  return "";
}

/** List every full_run in file order (which is time order). */
export async function listRuns(tracePath: string): Promise<TraceRunSummary[]> {
  const records = await readRecords(tracePath);
  const runs: TraceRunSummary[] = [];
  for (const rec of records) {
    if (rec.type !== "full_run" || !rec.messages) continue;
    const firstUser = rec.messages.find((m) => m.role === "user");
    runs.push({
      runId: rec.runId ?? "(unknown)",
      messageCount: rec.messages.length,
      contextCount: rec.contextCount ?? rec.context?.messages?.length ?? 0,
      firstUserText: firstUser ? messageText(firstUser).slice(0, 200) : "",
    });
  }
  return runs;
}

export interface RunDetail {
  runId: string;
  messages: Array<{
    role: string;
    text: string;
    /** Trace-side truncation marker: true means the text was cut in the trace; the model received it in full. */
    traceTruncated: boolean;
  }>;
}

/** Get the full messages of one run (the part added in that run). */
export async function getRun(tracePath: string, runId: string): Promise<RunDetail | undefined> {
  const records = await readRecords(tracePath);
  const rec = records.find((r) => r.type === "full_run" && r.runId === runId && r.messages);
  if (!rec?.messages) return undefined;
  return {
    runId,
    messages: rec.messages.map((m) => ({
      role: m.role ?? "(unknown)",
      text: messageText(m),
      traceTruncated: m.originalLength !== undefined,
    })),
  };
}

/**
 * Rebuild the full history the model saw when a run started:
 * chain the added messages of every earlier full_run in file order,
 * with the oldest format's inline .context.messages as the head of the chain.
 */
export async function reconstructHistory(tracePath: string, runId: string): Promise<RunDetail["messages"]> {
  const records = await readRecords(tracePath);
  const history: RunDetail["messages"] = [];
  for (const rec of records) {
    if (rec.type !== "full_run" || !rec.messages) continue;
    if (rec.context?.messages && history.length === 0) {
      for (const m of rec.context.messages) {
        history.push({ role: m.role ?? "(unknown)", text: messageText(m), traceTruncated: m.originalLength !== undefined });
      }
    }
    if (rec.runId === runId) return history;
    for (const m of rec.messages) {
      history.push({ role: m.role ?? "(unknown)", text: messageText(m), traceTruncated: m.originalLength !== undefined });
    }
  }
  return history;
}

/** Get the system prompt: prefer the file-level system_prompt record; the old format falls back to the one inlined in full_run. */
export async function getSystemPrompt(tracePath: string): Promise<string | undefined> {
  const records = await readRecords(tracePath);
  const dedicated = records.filter((r) => r.type === "system_prompt" && typeof r.content === "string").at(-1);
  if (dedicated?.content) return dedicated.content;
  const inlined = records.find((r) => r.type === "full_run" && typeof r.systemPrompt === "string");
  return inlined?.systemPrompt;
}
