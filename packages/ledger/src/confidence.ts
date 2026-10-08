/**
 * Confidence of an experience candidate. Pure functions, no I/O.
 *
 * The model is lifted from a continuous-learning extension written for a comparable harness, which got
 * several key judgements right; no need to reinvent them:
 *
 * - **Clamped to [0.1, 0.9]**: never certain, never zero. The floor lets a lesson that was
 *   contradicted all the way down still be rescued by later evidence; the ceiling stays
 *   below 1.0 because no number of confirmations proves a lesson holds forever.
 * - **Diminishing confirmation** (+0.05 for the first 3, +0.03 for 4-6, +0.01 from the 7th):
 *   easy-to-confirm entries get confirmed over and over; without the taper they would run
 *   to the top and crowd out the rare, important lessons.
 * - **Asymmetric contradiction, -0.15**: one contradiction cancels three confirmations. A
 *   lesson is valuable because "follow it and nothing goes wrong"; following it and still
 *   failing once says more than three uneventful runs.
 * - **Passive decay, -0.05/week**: an entry at 0.5 reaches the floor in about eight weeks.
 *   Lessons nobody touches retire on their own; no one has to clean them up.
 *
 * Where chopin differs is **where a "confirmation" comes from**. pi looks at turn
 * success (fuzzy). chopin asks: after this candidate was promoted into a gate or a tool,
 * did the original signal recur? The normalized key answers that mechanically, which is far
 * more objective. See {@link outcomeFromRecurrence}.
 *
 * @module @chopin/ledger/confidence
 */

/** Confidence floor. Entries that fall below it are flagged for removal, but the stored value never goes lower. */
const CLAMP_MIN = 0.1;
/** Confidence ceiling. No number of confirmations makes a lesson certain. */
const CLAMP_MAX = 0.9;

/** Initial confidence tiers by how many distinct sessions support the entry. Session count says more about recurrence than total count. */
const INITIAL_BY_SESSIONS: ReadonlyArray<readonly [number, number]> = [
  [2, 0.3],
  [5, 0.5],
  [10, 0.7],
];
const INITIAL_ABOVE = 0.85;

/** Confirmation increments taper with the number of confirmations so far. */
const CONFIRM_TIERS: ReadonlyArray<readonly [number, number]> = [
  [3, 0.05],
  [6, 0.03],
];
const CONFIRM_ABOVE = 0.01;

/** Decrement for one contradiction. Equals three first-tier confirmations; the asymmetry is deliberate. */
const DELTA_CONTRADICTED = -0.15;
/** Passive decay per week. */
const DECAY_PER_WEEK = 0.05;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * Outcome of one feedback pass.
 *
 * - `confirmed`: the signal has not reappeared since promotion; the discipline works.
 * - `contradicted`: still recurring since promotion; the fix was at the wrong layer. This
 *   is the mechanical version of the ledger's "recurring N times means the first N-1 fixes
 *   were at the wrong layer".
 * - `inactive`: no new sessions at all since promotion, nothing to judge by. Confidence unchanged.
 */
export type FeedbackOutcome = "confirmed" | "contradicted" | "inactive";

export interface ConfidenceResult {
  confidence: number;
  /** The raw value fell below the floor: flagged for removal. The stored value is still clamped to the floor. */
  flaggedForRemoval: boolean;
}

function toResult(raw: number): ConfidenceResult {
  return { confidence: Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, raw)), flaggedForRemoval: raw < CLAMP_MIN };
}

/**
 * Initial confidence of a new candidate.
 * @param sessions - Number of distinct sessions supporting it.
 * @returns The initial confidence.
 */
export function initialConfidence(sessions: number): number {
  for (const [upTo, value] of INITIAL_BY_SESSIONS) if (sessions <= upTo) return value;
  return INITIAL_ABOVE;
}

/**
 * How much one confirmation adds, tapering with the confirmations so far.
 * @param confirmedCount - Number of confirmations before this one.
 * @returns The increment for this confirmation.
 */
export function confirmationDelta(confirmedCount: number): number {
  for (const [upTo, value] of CONFIRM_TIERS) if (confirmedCount < upTo) return value;
  return CONFIRM_ABOVE;
}

/**
 * Adjust confidence by one feedback outcome.
 * @param current - Current confidence.
 * @param outcome - This pass's outcome.
 * @param confirmedCount - Number of confirmations so far, for the taper.
 * @returns The adjusted confidence and whether removal is advised.
 */
export function adjustConfidence(current: number, outcome: FeedbackOutcome, confirmedCount = 0): ConfidenceResult {
  if (outcome === "inactive") return toResult(current);
  const delta = outcome === "confirmed" ? confirmationDelta(confirmedCount) : DELTA_CONTRADICTED;
  return toResult(current + delta);
}

/**
 * Passive decay over time. Lessons nobody touches retire on their own.
 * @param confidence - Current confidence.
 * @param lastUpdatedIso - Time of the last update.
 * @param nowMs - The current time, injectable for tests.
 * @returns The decayed confidence.
 */
export function applyPassiveDecay(confidence: number, lastUpdatedIso: string, nowMs = Date.now()): ConfidenceResult {
  const updatedAt = new Date(lastUpdatedIso).getTime();
  if (Number.isNaN(updatedAt)) return toResult(confidence);
  // A future timestamp yields no negative decay: a clock set back must not hand out confidence.
  const weeks = Math.max(0, nowMs - updatedAt) / MS_PER_WEEK;
  return toResult(confidence - weeks * DECAY_PER_WEEK);
}

/**
 * Is this landing form supposed to make the signal stop appearing at all?
 *
 * This is the extra judgement chopin has to make beyond pi. Gates and declarative tools
 * are **preventive**: once installed, that failure should not come back, so "still
 * recurring" directly contradicts them. Ledger records and notes are **reference**: they
 * sharpen the next investigation but stop nothing. Using recurrence against a ledger record
 * is like declaring a notebook useless because mistakes still happen after taking notes.
 *
 * Reference-type landings only get passive decay on feedback, unless someone gives an explicit verdict.
 * @param proposal - The candidate's landing form.
 * @returns Whether it is preventive.
 */
export function preventsRecurrence(proposal: string): boolean {
  return proposal === "gate" || proposal === "toolset";
}

/**
 * Derive the feedback outcome from whether the signal recurred after promotion.
 *
 * This is the substantive difference between chopin and pi: pi can only look at turn
 * success, chopin can ask directly "is that original failure still there?". The normalized
 * key makes the question mechanically answerable.
 * @param input - `recurrencesAfter`: occurrences of the signal since promotion;
 *   `sessionsAfter`: total sessions run since promotion.
 * @returns The feedback outcome.
 */
export function outcomeFromRecurrence(input: { recurrencesAfter: number; sessionsAfter: number }): FeedbackOutcome {
  if (input.sessionsAfter === 0) return "inactive";
  return input.recurrencesAfter > 0 ? "contradicted" : "confirmed";
}
