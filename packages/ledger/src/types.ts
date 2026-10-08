/**
 * Defect ledger schema.
 *
 * One record = one structural defect, never one issue. Several issues, Loki clusters and
 * Sentry alerts attach to the same record as signals.
 * A record is written only after the user has approved the root cause.
 */

export type DefectStatus =
  /** Structurally fixed, and production signals verified at zero. */
  | "root-fixed"
  /** Recurred after at least one fix. */
  | "recurring"
  /** Symptom suppressed only; root cause untouched. */
  | "mitigated"
  /** Root cause approved, fix not yet shipped. */
  | "open";

export type SignalKind = "github-issue" | "loki" | "sentry" | "manual";

export interface DefectSignal {
  kind: SignalKind;
  /** Issue number, Loki cluster id, Sentry issue id or a free-form reference. */
  ref: string;
  date: string;
  note?: string;
}

export interface DefectFix {
  pr: string;
  /** Which layer the fix landed at: the load-bearing field for recurrence analysis. */
  layer: string;
  date: string;
  /** Why this fix did not reach the root; filled in when the defect recurs afterwards. */
  missedBecause?: string;
}

export interface DefectRecord {
  /** Slug identifier, also the file name. */
  id: string;
  /** Normalized error string key (see normalize.ts), the primary match key. */
  errorKey: string;
  /** Raw error strings observed under this defect. */
  observedErrors: string[];
  rootCause: {
    /** Structural description: what turns the trigger into user-visible damage. */
    description: string;
    /** The release tag the analysis was anchored at. */
    anchoredTag: string;
  };
  status: DefectStatus;
  signals: DefectSignal[];
  fixes: DefectFix[];
  createdAt: string;
  updatedAt: string;
}
