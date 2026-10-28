import type { FailureClass } from "../evidence/failures.js";
import { goodSteps } from "../evidence/points.js";
import { redactTranscript } from "../evidence/sanitize.js";
import type { TranscriptEntry } from "../transcript.js";
import type { Rejection } from "./rejections.js";

/** How many lines around a failure, and how many contrasting steps that went right, the proposer is shown. */
const BEFORE = 20;
const AFTER = 5;
const CONTRASTS = 3;
const ENTRY_CHARS = 2000;

/** A session the failure came from, with the lines where it happened in it. */
export interface FailureSession {
  session: string;
  entries: readonly TranscriptEntry[];
  lines: readonly number[];
}

export interface BriefInput {
  failure: FailureClass;
  /** Every session the failure came from; the change is tested at each of these failures. */
  sessions: readonly FailureSession[];
  /** What the user said to correct a step, by `session:line`. */
  corrections: ReadonlyMap<string, string>;
  /** Secret values to mask, besides the common secret formats. */
  secrets: readonly string[];
  rejections: readonly Rejection[];
  /** The layer's items as they read now, by id. */
  existing: readonly { id: string; text: string }[];
}

/**
 * What a proposer works from: the kind of failure and every time it happened, each with the step to change marked
 * and the user's correction of it, steps that went right for contrast, what was tried before and refused, and the
 * layer as it is; one session alone does not show what they have in common. Everything from the sessions is
 * redacted again here, whoever redacted it before.
 */
export function proposalBrief(input: BriefInput): string {
  const sessions = input.sessions.map((session) => ({ ...session, entries: redactTranscript(session.entries, input.secrets) }));
  const clip = (entry: TranscriptEntry | undefined) => {
    const text = JSON.stringify(entry);
    return text.length <= ENTRY_CHARS ? text : `${text.slice(0, ENTRY_CHARS)}…`;
  };
  const excerpt = (entries: readonly TranscriptEntry[], line: number, before: number, after: number) =>
    entries.slice(Math.max(0, line - before), line + after + 1).map((entry, i) => {
      const at = Math.max(0, line - before) + i;
      return `${at === line ? ">>> " : ""}${at}: ${clip(entry)}`;
    });
  const times = sessions.flatMap((session, n) => session.lines.map((line) => {
    const correction = input.corrections.get(`${session.session}:${line}`);
    return [
      `### Session ${n + 1}, line ${line}`,
      ...(correction === undefined ? [] : [`The user corrected this step: ${correction}`]),
      ...excerpt(session.entries, line, BEFORE, AFTER),
    ];
  }));
  const good = sessions.flatMap((session, n) => {
    const line = goodSteps(session.entries, session.lines).filter((at) => !session.lines.includes(at)).at(-1);
    return line === undefined ? [] : [[`### Session ${n + 1}, line ${line}`, ...excerpt(session.entries, line, 3, 1)]];
  }).slice(0, CONTRASTS).flat();
  return [
    "## The failure",
    JSON.stringify(input.failure.signature),
    `Seen ${times.length} times in ${sessions.length} sessions, every one below; your change is tested at each.`,
    "## Each time it happened",
    "The step marked >>> is the one your change must alter. What follows it, such as the user's correction, had not "
      + "happened when the agent took that step, so the condition your change names must be visible before it.",
    ...times.flat(),
    "## Steps that went right",
    ...(good.length === 0 ? ["(none)"] : good),
    "## Tried before and refused",
    ...(input.rejections.length === 0 ? ["(nothing yet)"] : input.rejections.map((rejection) =>
      `- ${JSON.stringify(rejection.text)}: ${rejection.reason}${rejection.prediction === undefined ? "" : ` (it predicted: ${rejection.prediction})`}`)),
    "## The layer now",
    ...(input.existing.length === 0 ? ["(empty)"] : input.existing.map((item) => `- ${item.id}: ${JSON.stringify(item.text)}`)),
  ].join("\n");
}
