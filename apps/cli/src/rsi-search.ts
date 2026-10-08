import type { StrategyCandidate, TrialScore } from "./rsi-engine.js";
import { improvementDigest } from "@chopin/evolution";

export interface SearchRecord { strategy: StrategyCandidate; scores: TrialScore[]; parentId?: string; expansions?: number }

function quality(record: SearchRecord): number {
  return record.scores.length ? record.scores.reduce((sum, score) => sum + score.passed / score.total, 0) / record.scores.length : 0;
}

/** Search value covers descendant gains and unexplored space; formal succession is still decided by holdout acceptance. */
export function selectSearchParent(archive: readonly SearchRecord[]): SearchRecord {
  if (!archive.length) throw new Error("No valid search parent is available");
  const explored = archive.reduce((sum, record) => sum + (record.expansions ?? 0), 0);
  const value = (record: SearchRecord) => {
    const descendants = archive.filter(item => item.parentId === record.strategy.reference.id);
    const productivity = descendants.length ? descendants.reduce((sum, item) => sum + quality(item), 0) / descendants.length : quality(record);
    return (quality(record) + productivity) / 2 + Math.sqrt(2 * Math.log(2 + explored) / (1 + (record.expansions ?? 0)));
  };
  return [...archive].sort((a, b) => value(b) - value(a) || quality(b) - quality(a)
    || a.strategy.reference.id.localeCompare(b.strategy.reference.id))[0]!;
}

function coverage(scores: readonly TrialScore[]): Set<string> {
  return new Set(scores.flatMap((score, trial) => score.results.filter(result => result.passed)
    .map(result => `${trial}:${score.taskDigest}:${result.id}`)));
}

function outcomes(scores: readonly TrialScore[]) {
  return scores.map(score => {
    const evidence = score.publicFeedback as Record<string, unknown> | null;
    const activity = evidence?.activity as { tools?: string[]; changedFiles?: string[] } | undefined;
    const toolCounts = Object.entries((activity?.tools ?? []).reduce<Record<string, number>>((counts, name) => {
      counts[name] = (counts[name] ?? 0) + 1; return counts;
    }, {})).sort(([left], [right]) => left.localeCompare(right));
    return { taskId: score.taskId, taskDigest: score.taskDigest, sourceDigest: score.sourceDigest,
      completed: score.completed, checks: score.results, requests: score.requests,
      tools: toolCounts, changedFiles: activity?.changedFiles ?? [],
      failures: Array.isArray(evidence?.failures) ? evidence.failures.slice(-3) : [],
      ...(evidence?.project === undefined ? {} : { project: evidence.project }),
      ...(evidence?.executionEvidence === undefined ? {} : { executionEvidence: evidence.executionEvidence }),
      ...(typeof evidence?.terminal === "string" ? { terminal: evidence.terminal } : {}),
      ...(typeof evidence?.policyError === "string" ? { policyError: evidence.policyError } : {}) };
  });
}

function boundedOutcomes(scores: readonly TrialScore[], limit: number) {
  const detailed = outcomes(scores);
  const selected: unknown[] = detailed.map(outcome => ({ taskId: outcome.taskId, taskDigest: outcome.taskDigest, sourceDigest: outcome.sourceDigest,
      completed: outcome.completed, requests: outcome.requests, passed: outcome.checks.filter(check => check.passed).length,
      total: outcome.checks.length, evidenceDigest: improvementDigest(outcome), detailsOmitted: "evidence budget" }));
  if (JSON.stringify(selected).length > limit) throw new Error("Search evidence identities exceed their budget");
  detailed.forEach((outcome, index) => {
    const previous = selected[index]; selected[index] = outcome;
    if (JSON.stringify(selected).length > limit) selected[index] = previous;
  });
  return selected;
}

/** Pick only complementary sources from the search set; load whole evidence units, never truncated into uninterpretable fragments. */
export function searchFeedback(current: SearchRecord, archive: readonly SearchRecord[]): unknown[] {
  const covered = coverage(current.scores);
  const choices = archive.filter(record => record.strategy.source !== current.strategy.source)
    .map(record => ({ record, coverage: coverage(record.scores), calls: record.scores.reduce((sum, score) => sum + score.requests, 0) }))
    .sort((left, right) => {
      const novelty = (set: Set<string>) => [...set].filter(key => !covered.has(key)).length;
      return novelty(right.coverage) - novelty(left.coverage) || right.coverage.size - left.coverage.size
        || left.calls - right.calls || left.record.strategy.reference.id.localeCompare(right.record.strategy.reference.id);
    }).slice(0, 2);
  const feedback: unknown[] = [{ kind: "current-search", strategy: current.strategy.reference, outcomes: boundedOutcomes(current.scores, 12_000) }];
  for (const { record, coverage: prior } of choices) {
    const contrast = { kind: "search-contrast", strategy: record.strategy.reference,
      evidenceScope: "Observed on this archived strategy only; transfer to the current version requires revalidation.",
      complementaryPasses: [...prior].filter(key => !covered.has(key)),
      currentOnlyPasses: [...covered].filter(key => !prior.has(key)), outcomes: outcomes(record.scores) };
    const withSource = { ...contrast, source: record.strategy.source };
    const entry = JSON.stringify([...feedback, withSource]).length <= 24_000
      ? withSource : { ...contrast, sourceOmitted: "source exceeds the evidence budget" };
    if (JSON.stringify([...feedback, entry]).length <= 24_000) feedback.push(entry);
  }
  return feedback;
}
