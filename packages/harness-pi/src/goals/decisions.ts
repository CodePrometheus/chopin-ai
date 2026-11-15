import { arr, int, lit, obj, opt, str, union, type Static } from "@earendil-works/chord";
import { compile } from "@earendil-works/pi-schema";
import { GoalEvidenceSchema } from "./contracts.js";

/** A review proposes a result; execution independently verifies its source evidence. */
export const GoalDecisionSchema = union([
  obj({ kind: lit("complete"), summary: str({ min: 1 }), evidence: arr(GoalEvidenceSchema), criteria: opt(arr(str({ min: 1 }), { min: 1 })) }),
  obj({ kind: lit("continue"), instruction: str({ min: 1 }), criteria: opt(arr(str({ min: 1 }), { min: 1 })) }),
  obj({ kind: lit("wait"), reason: str({ min: 1 }), until: opt(int({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER })) }),
]);
export type GoalDecision = Static<typeof GoalDecisionSchema>;
export const Decision = compile(GoalDecisionSchema);
