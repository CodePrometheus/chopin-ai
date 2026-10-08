/**
 * Conclusion ledger service (`ctx.chopinLedger`).
 *
 * The ledger is a process-level, cross-session resource, so it lives in the host layer,
 * not in a preset: the recurrence history one mission finds must be visible to another,
 * or "remembering" degrades into every task type keeping its own notes.
 *
 * Lookup is exact match on the normalized key only. Deliberately no vector or semantic
 * search: a false recurrence link skews the root-cause judgement, which is worse than
 * having no memory.
 *
 * Writes carry no side effects here: `save()` is an explicit action, to be called only
 * after the user has approved the conclusion.
 *
 * @module @chopin/ledger
 */

import { join } from "node:path";

import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { PendingStore } from "./pending.js";
import { LedgerStore } from "./store.js";
import type { DefectRecord } from "./types.js";

export type { DefectRecord, DefectFix, DefectSignal, DefectStatus, SignalKind } from "./types.js";
export { NORMALIZER_VERSION, buildSignalKey, correctionSignalKey, normalizeErrorString } from "./normalize.js";
export type { NormalizedError, SignalKeyInput } from "./normalize.js";
export { scrub } from "./scrub.js";
export { LedgerStore } from "./store.js";
export { PendingStore } from "./pending.js";
export type { PendingEntry, PendingState, FeedbackResult } from "./pending.js";
export {
  adjustConfidence,
  applyPassiveDecay,
  confirmationDelta,
  initialConfidence,
  outcomeFromRecurrence,
  preventsRecurrence,
} from "./confidence.js";
export type { ConfidenceResult, FeedbackOutcome } from "./confidence.js";
export { consolidationDue, DEFAULT_INTERVAL_DAYS, DEFAULT_MIN_SESSIONS } from "./consolidation.js";
export type { ConsolidationState, ConsolidationVerdict } from "./consolidation.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    chopinLedger: ChopinLedger;
  }
}

export interface Config {
  /** Ledger directory; one YAML per record, versioned by git. */
  dir: string;
}

export const Config: z<Config> = z.object({
  dir: z.string().required(),
});

export class ChopinLedger extends Service {
  private readonly store: LedgerStore;
  /**
   * Pending area: experience candidates not yet approved. Lives in `pending/` under the
   * ledger directory, versioned in the same git repo; the ledger's `loadAll()` only reads
   * top-level `*.yaml`, so it never picks these up.
   */
  readonly pending: PendingStore;

  constructor(ctx: Context, config: Config) {
    super(ctx, "chopinLedger");
    this.store = new LedgerStore(config.dir);
    this.pending = new PendingStore(join(config.dir, "pending"));
  }

  /** Look up recurrence history by raw error string; normalization happens inside, callers pass what they have. */
  search(rawError: string): Promise<DefectRecord[]> {
    return this.store.findByError(rawError);
  }

  load(id: string): Promise<DefectRecord | undefined> {
    return this.store.load(id);
  }

  list(): Promise<DefectRecord[]> {
    return this.store.loadAll();
  }

  /** Persist one record. Call only after the user has approved the conclusion: an explicit action, not a side effect. */
  save(record: DefectRecord): Promise<void> {
    return this.store.save(record);
  }
}

// The cordis loader resolves Service-class plugins by default export; this one is the framework contract.
export default ChopinLedger;
