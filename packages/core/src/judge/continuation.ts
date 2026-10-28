import type { Complete, FailureSignature } from "../evidence/classify.js";
import type { TranscriptEntry } from "../transcript.js";

/** How many lines before the decision point a judge is shown, and how much of each. */
const WINDOW = 30;
const ENTRY_CHARS = 1500;

/** Whether a continued step makes the same kind of failure again. */
export type RepeatVerdict = "repeats" | "avoids";

/** Whether a continued step is as good as the step that went right there. */
export type EquivalenceVerdict = "as_good" | "worse";

/** The context a judge sees: the lines just before the decision point. */
export function judgeContext(entries: readonly TranscriptEntry[], line: number): string {
  return entries.slice(Math.max(0, line - WINDOW), line).map((entry) => {
    const text = JSON.stringify(entry);
    return text.length <= ENTRY_CHARS ? text : `${text.slice(0, ENTRY_CHARS)}…`;
  }).join("\n");
}

/**
 * Judges whether `step`, continued at a decision point, makes the failure `failure` describes again. A failure the
 * user named by correcting the agent is judged by that `correction`: a step repeats it when it would draw the same
 * correction, since what the user wanted is said only after the step.
 */
export async function judgeRepeat(
  context: string,
  step: string,
  failure: FailureSignature,
  complete: Complete,
  correction?: string,
): Promise<RepeatVerdict | undefined> {
  const reply = await complete([
    "An agent once failed at this point of a session. The failure, as cause, behavior and mechanism:",
    JSON.stringify(failure),
    ...(correction === undefined ? [] : [`Right after the step it took then, the user corrected it: ${correction}`]),
    "The session up to that point, one ACP entry per line:",
    context,
    "A version of the agent took this next step instead:",
    step,
    correction === undefined
      ? 'Does this step make the same kind of failure again? Reply with only "repeats" or "avoids".'
      : 'Would the user have to make the same correction after this step? Reply with only "repeats" or "avoids".',
  ].join("\n"));
  return verdict<RepeatVerdict>(reply, ["repeats", "avoids"]);
}

/** Judges whether `step`, continued where `original` went right, is as good as it. */
export async function judgeEquivalent(
  context: string,
  original: string,
  step: string,
  complete: Complete,
): Promise<EquivalenceVerdict | undefined> {
  const reply = await complete([
    "At this point of a session the agent took a step that went right. The session up to that point, one ACP entry per line:",
    context,
    "The step that went right:",
    original,
    "Another version of the agent took this step instead:",
    step,
    'Is it as good a step here: as correct, as safe and as useful? Reply with only "as_good" or "worse".',
  ].join("\n"));
  return verdict<EquivalenceVerdict>(reply, ["as_good", "worse"]);
}

function verdict<T extends string>(reply: string, allowed: readonly T[]): T | undefined {
  const word = reply.replace(/^[\s"'`*]+|[\s"'`*.!]+$/g, "").toLowerCase();
  return allowed.find((value) => value === word);
}
