/**
 * Pending area: experience candidates you have not approved yet, with their confidence.
 *
 * It sits on the other side of the admission line from the ledger: **the pending area is
 * written freely, the ledger needs approval**. The split is deliberate: an unattended
 * overnight run throws up dozens of things that "look like lessons", and if they could go
 * straight into the ledger, the ledger would no longer be "conclusions you signed off on"
 * and every later judgement built on it would be untrustworthy. So curate only writes here
 * (no approval, because this area is untrusted by design), and promotion goes through the
 * `ledger_write` ask.
 *
 * Admission alone is not enough: **once promoted, there has to be feedback on whether the
 * lesson actually works**. So every candidate carries a confidence, adjusted after promotion
 * by {@link PendingStore.feedback} on "did the original signal recur?": recurrence is a
 * contradiction, meaning the fix was at the wrong layer. Without that loop the pending area
 * is an ever-growing list, not memory. The confidence model is in `./confidence.js`.
 *
 * The directory is `pending/` under the ledger directory: same git repo, versioned
 * together; the ledger's `loadAll()` only reads top-level `*.yaml`, so the subdirectory
 * never pollutes it.
 *
 * @module @chopin/ledger/pending
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";

import { adjustConfidence, applyPassiveDecay, initialConfidence } from "./confidence.js";
import type { ConfidenceResult, FeedbackOutcome } from "./confidence.js";
import type { ConsolidationState } from "./consolidation.js";
import { normalizeErrorString } from "./normalize.js";
import { assertRecordId } from "./store.js";

/** Where a candidate went. `pending` is still in the pending area; the others each have a subdirectory. */
export type PendingState = "pending" | "promoted" | "rejected" | "merged";

/** One pending experience candidate. */
export interface PendingEntry {
  /** Slug identifier, also the file name. */
  id: string;
  /** Normalized merge key: the same thing in different words is still recognized. */
  key: string;
  /** What the lesson says. Written in behavioral terms: what happens if you don't. */
  lesson: string;
  /** Evidence behind it: raw signal, sessions, occurrence count. */
  evidence: string;
  /** Times observed, accumulated across sessions. */
  occurrences: number;
  /** Number of distinct sessions it appeared in. Says more about recurrence than the total count; initial confidence tiers on it. */
  sessions: number;
  /** Proposed landing form: a ledger record, a gate rule, a tool, or just a note. */
  proposal: "ledger" | "gate" | "toolset" | "note";
  /** Current confidence, clamped to [0.1, 0.9]. */
  confidence: number;
  /** Times confirmed since promotion (signal did not recur). Drives the confirmation taper. */
  confirmedCount: number;
  /** Times contradicted since promotion (signal kept recurring). */
  contradictedCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /**
   * The point in time passive decay has been settled up to.
   *
   * It means "settlement point", not "last touched": every decay computation must advance
   * it, or the next review deducts the same stretch again from the same old point, lower each time.
   */
  updatedAt: string;
  /** Promotion time. Feedback only looks at sessions after it; earlier recurrences do not count. */
  promotedAt?: string;
  /** Which entry absorbed this one. Only present on `merged` entries. */
  mergedInto?: string;
}

/** Result of {@link PendingStore.feedback}. */
export interface FeedbackResult {
  entry: PendingEntry;
  outcome: FeedbackOutcome;
  /** Confidence details after decay + adjustment, including whether removal is advised. */
  confidence: ConfidenceResult;
  /** Confidence before adjustment, for showing the delta. */
  previousConfidence: number;
}

/**
 * File-backed pending area. Lookup is likewise exact match on the normalized key, for the
 * same reason as the ledger: a false link is worse than none.
 */
export class PendingStore {
  constructor(private readonly dir: string) {}

  private dirFor(state: PendingState): string {
    return state === "pending" ? this.dir : join(this.dir, state);
  }

  private path(id: string, state: PendingState = "pending"): string {
    assertRecordId(id);
    return join(this.dirFor(state), `${id}.yaml`);
  }

  private async readDir(state: PendingState): Promise<PendingEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.dirFor(state));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const entries: PendingEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(".yaml")) continue;
      entries.push(parse(await readFile(join(this.dirFor(state), name), "utf8")) as PendingEntry);
    }
    return entries;
  }

  /** Unprocessed candidates in the pending area, sorted by session count so the recurring ones come first. */
  async list(): Promise<PendingEntry[]> {
    const entries = await this.readDir("pending");
    return entries.sort((a, b) => b.sessions - a.sessions || b.occurrences - a.occurrences);
  }

  /**
   * Find a pending candidate by normalized key.
   *
   * For `ledger_write`: when a candidate really is written into the ledger, that write
   * should stamp the promotion itself rather than rely on the model remembering to call
   * another tool. The write needs your approval, so a "promoted" state cannot appear out of nowhere.
   * @param rawSignal - Raw signal string, normalized internally.
   * @returns The matching candidate, or undefined.
   */
  async findByKey(rawSignal: string): Promise<PendingEntry | undefined> {
    const key = normalizeErrorString(rawSignal).key;
    return (await this.list()).find((entry) => entry.key === key);
  }

  /** Promoted candidates. Feedback applies only to them: something that never landed cannot be confirmed or contradicted. */
  async listPromoted(): Promise<PendingEntry[]> {
    const entries = await this.readDir("promoted");
    return entries.sort((a, b) => a.confidence - b.confidence);
  }

  /**
   * Record a candidate. If the same normalized key already exists, add to its counts and
   * refresh its timestamps instead of creating a new entry: merging near-duplicates is the
   * whole point here, or the list fills up with ten wordings of the same thing.
   *
   * On merge, if the entry **has not been through any feedback yet**, the initial confidence
   * is recomputed from the new session count: the tiers are a prior, and more observations
   * should sharpen it. Once it has been confirmed or contradicted, the prior yields to the
   * evidence and is no longer recomputed.
   * @param input - Candidate content; `key` is derived by normalizing `signal`.
   * @returns The persisted entry.
   */
  async record(input: {
    id: string;
    signal: string;
    lesson: string;
    evidence: string;
    proposal: PendingEntry["proposal"];
    occurrences?: number;
    sessions?: number;
  }): Promise<PendingEntry> {
    await mkdir(this.dir, { recursive: true });
    const key = normalizeErrorString(input.signal).key;
    const now = new Date().toISOString();
    const existing = (await this.list()).find((entry) => entry.key === key);

    const occurrences = (existing?.occurrences ?? 0) + (input.occurrences ?? 1);
    const sessions = Math.max(existing?.sessions ?? 0, input.sessions ?? 1);
    const confirmedCount = existing?.confirmedCount ?? 0;
    const contradictedCount = existing?.contradictedCount ?? 0;
    const untouched = confirmedCount === 0 && contradictedCount === 0;

    const merged: PendingEntry = {
      id: existing?.id ?? input.id,
      key,
      lesson: input.lesson,
      evidence: input.evidence,
      occurrences,
      sessions,
      proposal: input.proposal,
      confidence: untouched ? initialConfidence(sessions) : (existing?.confidence ?? initialConfidence(sessions)),
      confirmedCount,
      contradictedCount,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      updatedAt: now,
    };
    await writeFile(this.path(merged.id), stringify(merged), "utf8");
    return merged;
  }

  /**
   * Move a candidate out of the pending area.
   *
   * A move, not a judgement: promotion into the ledger belongs to `ledger_write` (which
   * needs your approval); this only takes an already-handled entry off the list so it is
   * not treated as new next time. Promotion stamps `promotedAt`, and feedback only looks
   * at sessions after it.
   * @param id - Candidate id.
   * @param outcome - `promoted` if it landed, `rejected` if it was seen and declined.
   */
  async settle(id: string, outcome: "promoted" | "rejected"): Promise<void> {
    const entry = parse(await readFile(this.path(id), "utf8")) as PendingEntry;
    if (outcome === "promoted") entry.promotedAt = new Date().toISOString();
    // Edit in place, then atomic rename: a crash midway leaves at most one stamped entry in
    // the pending area, overwritten by the next settle; never two copies or none.
    await writeFile(this.path(id), stringify(entry), "utf8");
    await mkdir(this.dirFor(outcome), { recursive: true });
    await rename(this.path(id), this.path(id, outcome));
  }

  /**
   * Merge `fromId` into `intoId`: the wording drifted too far for the normalized keys to
   * match, but they say the same thing.
   *
   * Which entries are the same thing is a judgement call, so the model decides; this only
   * guarantees the merge itself is safe and traceable: counts add up, time spans unite, and
   * the absorbed entry moves into `merged/` as a record rather than being deleted.
   * @param intoId - The entry to keep.
   * @param fromId - The entry being absorbed.
   * @returns The merged entry.
   */
  async merge(intoId: string, fromId: string): Promise<PendingEntry> {
    if (intoId === fromId) throw new Error(`cannot merge ${intoId} into itself`);
    const into = parse(await readFile(this.path(intoId), "utf8")) as PendingEntry;
    const from = parse(await readFile(this.path(fromId), "utf8")) as PendingEntry;

    const merged: PendingEntry = {
      ...into,
      occurrences: into.occurrences + from.occurrences,
      sessions: Math.max(into.sessions, from.sessions),
      confirmedCount: into.confirmedCount + from.confirmedCount,
      contradictedCount: into.contradictedCount + from.contradictedCount,
      firstSeenAt: into.firstSeenAt < from.firstSeenAt ? into.firstSeenAt : from.firstSeenAt,
      lastSeenAt: into.lastSeenAt > from.lastSeenAt ? into.lastSeenAt : from.lastSeenAt,
      updatedAt: new Date().toISOString(),
      evidence: `${into.evidence}\n---\n(merged from ${fromId}) ${from.evidence}`,
    };
    // More sessions, sharper prior: but only while the entry has not been through feedback.
    if (merged.confirmedCount === 0 && merged.contradictedCount === 0) {
      merged.confidence = initialConfidence(merged.sessions);
    }
    await writeFile(this.path(intoId), stringify(merged), "utf8");

    await writeFile(this.path(fromId), stringify({ ...from, mergedInto: intoId }), "utf8");
    await mkdir(this.dirFor("merged"), { recursive: true });
    await rename(this.path(fromId), this.path(fromId, "merged"));
    return merged;
  }

  /**
   * When the last consolidation ran. Kept in the `pending/state/` subdirectory: `list()`
   * only scans top-level `*.yaml`, so the state file is never read as a candidate.
   * @returns The consolidation state; an empty object if it never ran.
   */
  async consolidationState(): Promise<ConsolidationState> {
    try {
      return parse(await readFile(join(this.dir, "state", "consolidation.yaml"), "utf8")) as ConsolidationState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  /**
   * Record this consolidation.
   * @param sessionCount - Cumulative session count at this pass, for the next delta check.
   */
  async markConsolidated(sessionCount: number): Promise<void> {
    const state: ConsolidationState = { lastRunAt: new Date().toISOString(), lastRunSessionCount: sessionCount };
    await mkdir(join(this.dir, "state"), { recursive: true });
    await writeFile(join(this.dir, "state", "consolidation.yaml"), stringify(state), "utf8");
  }

  /**
   * Record one feedback pass for a promoted candidate.
   *
   * Passive decay first, then the adjustment for this outcome; the order matters: decay
   * stands for "nobody touched it in this stretch", while this outcome is proof someone
   * did, so decaying first keeps the new evidence from being discounted too.
   * @param id - Candidate id.
   * @param outcome - This pass's outcome, usually derived from recurrence by `outcomeFromRecurrence`.
   * @param options - `dryRun` computes without persisting, to preview what this review would set the confidence to.
   * @returns The confidence before and after, and the updated entry.
   */
  async feedback(id: string, outcome: FeedbackOutcome, options: { dryRun?: boolean } = {}): Promise<FeedbackResult> {
    const entry = parse(await readFile(this.path(id, "promoted"), "utf8")) as PendingEntry;
    const previousConfidence = entry.confidence;
    const decayed = applyPassiveDecay(entry.confidence, entry.updatedAt);
    const adjusted = adjustConfidence(decayed.confidence, outcome, entry.confirmedCount);
    // Each step clamps on its own, so the removal flags must be OR-ed: judged by the second step
    // alone, entries decayed to the floor by time read as "fine", and untouched lessons never retire.
    const flaggedForRemoval = decayed.flaggedForRemoval || adjusted.flaggedForRemoval;

    entry.confidence = adjusted.confidence;
    if (outcome === "confirmed") entry.confirmedCount += 1;
    if (outcome === "contradicted") entry.contradictedCount += 1;
    // Decay is settled up to now, so the timestamp must advance, inactive included. It means
    // "settled up to", not "last touched"; left behind, the next review deducts the same stretch again.
    entry.updatedAt = new Date().toISOString();

    if (options.dryRun !== true) await writeFile(this.path(id, "promoted"), stringify(entry), "utf8");
    return { entry, outcome, confidence: { confidence: adjusted.confidence, flaggedForRemoval }, previousConfidence };
  }
}
