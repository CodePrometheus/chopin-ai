import { defineDocFamily } from "@earendil-works/pi-durable";

/** Required post-run outcomes, separate from the model's successfully returned answer. */
export const RunAudit = defineDocFamily<{ checked: boolean; passed: boolean; tasks: number[] }, null>({
  kind: "chopin.goal-run-audit", version: 1, scope: "session", family: true,
  initial: () => ({ checked: false, passed: false, tasks: [] }), checkpointWhen: () => true,
});
