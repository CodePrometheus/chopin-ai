import {
  baselineImprovementPlan, baselineImprover, improvementDigest, assertImprovementPlan,
} from "@chopin/evolution";
import type {
  ImprovementInput, ImprovementPlan, ImprovementRecord, ImprovementWork, ImproverReference, EvolutionProjection,
} from "@chopin/evolution";
import { scrub } from "@chopin/ledger";

import { evolutionQueue } from "./queue.js";

export type ImproverRunner = (input: ImprovementInput, signal?: AbortSignal) => Promise<unknown>;
export interface RegisteredImprover { reference: ImproverReference; run: ImproverRunner }

export function improvementInput(
  projection: EvolutionProjection, objective: string, strategy = baselineImprover(), includeSelf = false,
): ImprovementInput {
  const work: ImprovementWork[] = evolutionQueue(projection).slice(0, 49).map((item) => ({
    key: `work-${improvementDigest(item).slice(7, 39)}`, action: item.action, targetId: item.id,
    detail: scrub(item.detail).slice(0, 1_000),
    evidenceUnits: projection.candidates.find((candidate) => candidate.id === item.id)?.trustedIndependentUnits ?? 0,
  }));
  if (includeSelf) work.unshift({ key: "self", action: "improve-strategy", targetId: strategy.id,
    detail: "Improve the strategy that proposes future capability changes, using actual outcomes and keeping the host constraints fixed.", evidenceUnits: 0 });
  return {
    schemaVersion: 1, objective: scrub(objective).slice(0, 4_000) || "Improve the current capability system.",
    strategy, budget: { maxActions: 1 }, work,
    history: [...projection.artifacts].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)).slice(-30).map((artifact) => {
      const feedback = artifact.feedbackWindows.at(-1);
      return { artifactId: artifact.id, state: artifact.state, summary: scrub(artifact.manifest.summary).slice(0, 500),
        outcome: feedback === undefined ? null : { windowId: feedback.windowId, eligible: feedback.eligible,
          activated: feedback.activated, taskPass: feedback.taskPass, taskFail: feedback.taskFail,
          recurrence: feedback.recurrence, falseBlock: feedback.falseBlock } };
    }),
  };
}

export async function runImprover(input: ImprovementInput, runner?: ImproverRunner, signal?: AbortSignal): Promise<ImprovementPlan> {
  const raw = runner === undefined ? baselineImprovementPlan(input) : await runner(input, signal);
  assertImprovementPlan(raw, input);
  const plan: ImprovementPlan = { schemaVersion: 1, actions: raw.actions.map((action) => ({
    key: action.key, reason: scrub(action.reason), instructions: scrub(action.instructions),
  })) };
  assertImprovementPlan(plan, input);
  return plan;
}

export function renderImprovement(record: ImprovementRecord): string {
  const header = `[IMPROVEMENT PLAN ${record.id}; source=${record.input.strategy.id}]`;
  const text = [
    header,
    "Advisory plan only; host rules, budgets and evaluators remain authoritative. Planning does not prove benefit.",
    ...record.plan.actions.flatMap((action) => {
      const work = record.input.work.find((item) => item.key === action.key)!;
      return [`Action: ${work.action}; target: ${work.targetId}`, `Reason: ${action.reason}`, action.instructions];
    }),
  ].join("\n");
  return text.length <= 1_600 ? text : `${header}\nPlan exceeds the automatic context budget. Use evolution_improver_plan to read it when relevant; host constraints still apply.`;
}
