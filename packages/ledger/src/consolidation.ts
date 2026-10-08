/**
 * When a consolidation pass (merge near-duplicates, prune the stale) is due.
 *
 * The double gate is lifted from the same continuous-learning extension as the confidence model: **long enough since the last
 * pass AND enough sessions run since**, both required. Time alone would spin once in a
 * week nobody used it; session count alone would consolidate repeatedly on one busy day.
 * A pass costs model money, so an idle spin is a real expense.
 *
 * @module @chopin/ledger/consolidation
 */

/** Minimum days since the last consolidation. */
export const DEFAULT_INTERVAL_DAYS = 7;
/** Minimum new sessions since the last consolidation. */
export const DEFAULT_MIN_SESSIONS = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ConsolidationState {
  /** Time of the last consolidation. Absent if never run. */
  lastRunAt?: string;
  /** Cumulative session count at the last consolidation. */
  lastRunSessionCount?: number;
}

export interface ConsolidationVerdict {
  due: boolean;
  /** A one-line reason fit to show a person. */
  reason: string;
}

/**
 * Decide whether consolidation is due now.
 * @param input - Current state, cumulative session count, optional thresholds and current time.
 * @returns Whether it is due, and why.
 */
export function consolidationDue(input: {
  state: ConsolidationState;
  sessionCount: number;
  intervalDays?: number;
  minSessions?: number;
  nowMs?: number;
}): ConsolidationVerdict {
  const intervalDays = input.intervalDays ?? DEFAULT_INTERVAL_DAYS;
  const minSessions = input.minSessions ?? DEFAULT_MIN_SESSIONS;
  const now = input.nowMs ?? Date.now();

  if (input.state.lastRunAt === undefined) {
    return input.sessionCount >= minSessions
      ? { due: true, reason: `never consolidated and ${input.sessionCount} session(s) recorded` }
      : { due: false, reason: `never consolidated, but only ${input.sessionCount}/${minSessions} session(s) so far` };
  }

  const lastRun = new Date(input.state.lastRunAt).getTime();
  const days = Number.isNaN(lastRun) ? Number.POSITIVE_INFINITY : (now - lastRun) / MS_PER_DAY;
  const newSessions = input.sessionCount - (input.state.lastRunSessionCount ?? 0);

  if (days < intervalDays) {
    return { due: false, reason: `last consolidation was ${days.toFixed(1)} day(s) ago; ${intervalDays} required` };
  }
  if (newSessions < minSessions) {
    return { due: false, reason: `only ${newSessions} new session(s) since the last consolidation; ${minSessions} required` };
  }
  return { due: true, reason: `${days.toFixed(1)} day(s) and ${newSessions} new session(s) since the last consolidation` };
}
