/**
 * Score a promoted lesson: does it actually work?
 *
 * The judgement is pure and separate from reading logs: the `curation_review` tool only
 * loads the logs, while whether something counts as a contradiction, and how many times,
 * lives entirely here, so it is testable.
 *
 * @module @chopin/tool-session/review
 */

import { normalizeErrorString, outcomeFromRecurrence, preventsRecurrence } from "@chopin/ledger";
import type { FeedbackOutcome } from "@chopin/ledger";

import type { SessionLog } from "./read.js";
import { extractSignals } from "./signals.js";

/** The part of a candidate that scoring needs to know. */
export interface ScorableLesson {
  /** Normalized signal key. Recurrence is judged by comparing it. */
  key: string;
  /** Landing form. Decides whether recurrence counts as a contradiction. */
  proposal: string;
}

export interface LessonScore {
  outcome: FeedbackOutcome;
  /** How many times the signal reappeared after promotion. */
  recurrencesAfter: number;
  /** How many sessions ran after promotion. Zero means nothing to judge by. */
  sessionsAfter: number;
}

/**
 * Score a lesson by what happened after its promotion.
 *
 * Only preventive landings (gates, declarative tools) are judged by recurrence: they exist
 * to make a failure stop happening, so still happening means the fix was at the wrong
 * layer. Ledger records and notes stop nothing, recurrence is no contradiction for them,
 * so they are always `inactive` and only decay passively.
 * @param lesson - The candidate's key and landing form.
 * @param logsAfter - Session logs after promotion.
 * @returns The outcome and the counts behind it.
 */
export function scoreLesson(lesson: ScorableLesson, logsAfter: readonly SessionLog[]): LessonScore {
  if (!preventsRecurrence(lesson.proposal)) {
    return { outcome: "inactive", recurrencesAfter: 0, sessionsAfter: logsAfter.length };
  }
  let recurrencesAfter = 0;
  // minOccurrences is 1: the question here is "did it happen again", and once is enough.
  for (const signal of extractSignals(logsAfter, { minOccurrences: 1 })) {
    if (normalizeErrorString(signal.sample).key === lesson.key) recurrencesAfter += signal.occurrences;
  }
  return {
    outcome: outcomeFromRecurrence({ recurrencesAfter, sessionsAfter: logsAfter.length }),
    recurrencesAfter,
    sessionsAfter: logsAfter.length,
  };
}
