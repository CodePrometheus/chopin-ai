import type { InvestigationRequest } from "./types.js";

let seq = 0;

export function newRequestId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

/** Wrap a hand-typed error string or symptom into an investigation request. */
export function manualRequest(input: { error?: string; symptom?: string }): InvestigationRequest {
  const symptom = input.symptom ?? input.error ?? "";
  if (!symptom) throw new Error("manual request needs an error string or a symptom");
  return {
    id: newRequestId("manual"),
    source: { kind: "manual", ref: "cli" },
    errorString: input.error,
    symptom,
    evidencePointers: [],
    createdAt: new Date().toISOString(),
  };
}
