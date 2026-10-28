import type { TranscriptEntry } from "../transcript.js";
import type { Complete } from "./classify.js";
import { correctedStep, isUserWritten } from "./points.js";

/** How much of each message the model is shown, and how much one request carries, so a long session stays cheap. */
const USER_CHARS = 1200;
const AGENT_CHARS = 600;
const BATCH_CHARS = 60_000;

/** A user message that may correct the agent; it counts as a failure only once the user confirms it. */
export interface CorrectionCandidate {
  /** The transcript line of the user's message. */
  line: number;
  /** What the user corrected, in a few words. */
  summary: string;
}

/**
 * Lines from `from` on where the user pushed back on what the agent did. A model proposes them, since no event marks
 * a correction; a long session is asked about in batches, and lines the user did not write are dropped.
 */
export async function proposeCorrections(entries: readonly TranscriptEntry[], complete: Complete, from = 0): Promise<CorrectionCandidate[]> {
  const users = entries.flatMap((entry, line) => (line >= from && isUserWritten(entry) ? [line] : []));
  const found: CorrectionCandidate[] = [];
  for (const batch of batches(users.map((line) => excerpt(entries, line)))) {
    const reply = await complete([
      "Below are the user's messages from an agent session, each with the agent step just before it. Find the user",
      "messages that correct the agent: rejecting what it did, pointing out a mistake, or restating a rule it broke.",
      "Questions and new requests are not corrections, nor are praise, agreement, or frustration that names nothing to",
      "do differently. Summarize each as what the agent should do instead, in a few words. Reply with only a JSON",
      'array such as [{"line":12,"summary":"use pnpm, not npm"}], or [] for none.',
      ...batch,
    ].join("\n"));
    found.push(...parseCandidates(reply, users));
  }
  return found;
}

function excerpt(entries: readonly TranscriptEntry[], line: number): string {
  const before = correctedStep(entries, line);
  const agent = before === undefined ? "" : `agent before ${line}: ${clip(JSON.stringify(entries[before]), AGENT_CHARS)}\n`;
  return `${agent}user ${line}: ${clip(JSON.stringify(entries[line]), USER_CHARS)}`;
}

function batches(excerpts: readonly string[]): string[][] {
  const all: string[][] = [];
  let size = Infinity;
  for (const text of excerpts) {
    if (size + text.length > BATCH_CHARS) {
      all.push([]);
      size = 0;
    }
    all.at(-1)!.push(text);
    size += text.length;
  }
  return all;
}

function parseCandidates(reply: string, users: readonly number[]): CorrectionCandidate[] {
  let found: unknown;
  try {
    found = JSON.parse(reply.slice(reply.indexOf("["), reply.lastIndexOf("]") + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(found)) return [];
  return found.flatMap((item: { line?: unknown; summary?: unknown }) =>
    typeof item.line === "number" && users.includes(item.line) && typeof item.summary === "string" && item.summary !== ""
      ? [{ line: item.line, summary: item.summary }]
      : []);
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
