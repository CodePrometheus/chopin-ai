import type { SignalKind } from "@chopin/ledger/types";

/**
 * The investigation request every source adapter produces.
 * The source only decides where the initial evidence is; everything downstream
 * (toolset, gates, report) is source-agnostic.
 */
export interface InvestigationRequest {
  id: string;
  source: {
    kind: SignalKind;
    /** Issue number, Loki cluster id or a free-form reference. */
    ref: string;
  };
  /** Raw error string known at intake, if any. */
  errorString?: string;
  /** Human-readable symptom (issue title/body excerpt, the user's own words). */
  symptom: string;
  /** Where the initial evidence is: bundle URL, Loki query, file path. */
  evidencePointers: string[];
  /** Time window of the incident, if known, as ISO timestamps. */
  timeWindow?: { from: string; to: string };
  createdAt: string;
}
