import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, improvementDigest } from "@chopin/evolution";
import type { CapabilityManifest, ImproverReference } from "@chopin/evolution";
import { assertProjectTaskPack } from "./rsi-project.js";
import type { ProjectTask } from "./rsi-project.js";
import { writeTrialRecord } from "./rsi-trial.js";
import type { TrialContextSnapshot } from "./rsi-context.js";
import { assertTrialContext } from "./rsi-context.js";
import { searchFeedback, selectSearchParent } from "./rsi-search.js";
import type { SearchRecord } from "./rsi-search.js";

export interface StrategyCandidate {
  reference: ImproverReference;
  source: string;
  directory?: string;
  manifest?: CapabilityManifest;
  candidateId?: string;
  proposalId?: string;
  validationError?: string;
}

export interface TrialScore {
  taskId: string;
  taskDigest: string;
  sourceDigest: string;
  passed: number;
  total: number;
  requests: number;
  completed: boolean;
  infrastructureFailures?: number;
  results: Array<{ id: string; passed: boolean }>;
  publicFeedback: unknown;
}

export interface ExperimentRound {
  round: number;
  parent: ImproverReference;
  candidate?: StrategyCandidate;
  scores: TrialScore[];
  searchAccepted: boolean;
  reason: string;
}

export interface ExperimentPlan {
  schemaVersion: 3;
  id: string;
  objective: string;
  initial: StrategyCandidate;
  tasks: ProjectTask[];
  contexts: Record<string, TrialContextSnapshot>;
  replaySources?: Record<string, ProjectTask>;
  repetitions: number;
  rounds: number;
  diagnostic?: true;
  audit?: { sourceExperiment: string; target: StrategyCandidate; evidence: unknown[];
    nominee?: StrategyCandidate; generationLimit?: number; resumedFrom?: string; frozenChildren?: Array<StrategyCandidate | null>; evaluationOnly?: true };
}

export interface ExperimentHooks {
  selectParent?(archive: readonly SearchRecord[], current: StrategyCandidate, preferred: StrategyCandidate, key: string, signal: AbortSignal): Promise<string>;
  solve(strategy: StrategyCandidate, task: ProjectTask, key: string, signal: AbortSignal): Promise<TrialScore>;
  propose(parent: StrategyCandidate, feedback: readonly unknown[], key: string, signal: AbortSignal, target?: StrategyCandidate): Promise<{ candidate: StrategyCandidate | null; reason?: string; generationFailure?: string }>;
  reject(candidate: StrategyCandidate, reason: string): Promise<void>;
  promote(candidate: StrategyCandidate, baseline: StrategyCandidate, signal: AbortSignal): Promise<void>;
  progress(message: string): void;
}

export interface ProductivityEvidence {
  target: ImproverReference;
  controlParent: ImproverReference;
  candidateParent: ImproverReference;
  controlChildren: ImproverReference[];
  candidateChildren: ImproverReference[];
  control: TrialScore[];
  candidate: TrialScore[];
  accepted: boolean;
  reason: string;
  generationFailures?: Array<{ parent: "control" | "candidate"; sample: number; artifactId?: string; reason: string }>;
}

export const PRODUCTIVITY_PAIRS = 2;
export const GENERATION_REQUEST_LIMIT = 2;

export function generationRequestLimit(plan: Pick<ExperimentPlan, "audit">): number {
  const limit = plan.audit?.generationLimit ?? GENERATION_REQUEST_LIMIT;
  if (limit !== 1 && limit !== 2) throw new Error("Invalid generation request allowance");
  return limit;
}

function generationRequests(plan: Pick<ExperimentPlan, "audit" | "rounds" | "diagnostic">): number {
  if (plan.audit?.frozenChildren) {
    if (!plan.audit.nominee || plan.audit.frozenChildren.length !== 2 * PRODUCTIVITY_PAIRS
      || plan.audit.frozenChildren.some(child => child ? child.reference.kind !== "artifact" || (!plan.diagnostic && child.validationError) : !plan.diagnostic)) {
      throw new Error("Incomplete frozen productivity comparison");
    }
    return 0;
  }
  return ((plan.audit ? plan.audit.nominee ? 0 : 1 : plan.rounds) + 2 * PRODUCTIVITY_PAIRS) * generationRequestLimit(plan);
}

export function minimumExperimentRequests(plan: Pick<ExperimentPlan, "tasks" | "rounds" | "repetitions" | "audit" | "diagnostic">): number {
  return (plan.audit ? 0 : (plan.rounds + 1) * plan.repetitions * plan.tasks.filter(task => task.split === "search").length)
    + (2 + 2 * PRODUCTIVITY_PAIRS) * plan.repetitions * plan.tasks.filter(task => task.split === "holdout").length
    + generationRequests(plan);
}

/** Pre-allocate the same per-task limit; the generation phase keeps budget for one correction or an explicit resume. */
export function allocateExperimentRequests(plan: Pick<ExperimentPlan, "tasks" | "rounds" | "repetitions" | "audit" | "diagnostic">, limit: number): {
  taskLimit: number; phaseLimits: Record<string, number>; confirmationReserve: number;
} {
  const generations = generationRequests(plan);
  const trials = minimumExperimentRequests(plan) - generations;
  if (!Number.isSafeInteger(limit) || limit < trials + generations || limit > 120 || trials < 1) {
    throw new Error(`This sealed protocol needs at least ${trials + generations} requests and permits at most 120`);
  }
  const taskLimit = Math.min(12, Math.floor((limit - generations) / trials));
  const phaseLimits: Record<string, number> = {};
  const tasks = (prefix: string, split: ProjectTask["split"]) => {
    for (let repeat = 0; repeat < plan.repetitions; repeat++) {
      plan.tasks.filter(task => task.split === split).forEach((_, index) => {
        phaseLimits[`${prefix}-task-${index}-repeat-${repeat}`] = taskLimit;
      });
    }
  };
  if (!plan.audit) tasks("baseline", "search");
  for (let round = 1; round <= (plan.audit ? 1 : plan.rounds); round++) {
    if (!plan.audit?.nominee) phaseLimits[`round-${round}-proposal`] = generationRequestLimit(plan);
    if (!plan.audit) tasks(`round-${round}`, "search");
  }
  tasks("holdout-control", "holdout"); tasks("holdout-candidate", "holdout");
  for (let sample = 0; sample < PRODUCTIVITY_PAIRS; sample++) {
    for (const label of ["control", "candidate"]) {
      if (!plan.audit?.frozenChildren) phaseLimits[`productivity-${label}-${sample}-proposal`] = generationRequestLimit(plan);
      tasks(`productivity-${label}-${sample}`, "holdout");
    }
  }
  const confirmationReserve = Object.entries(phaseLimits).filter(([key]) => key.startsWith("holdout-") || key.startsWith("productivity-"))
    .reduce((sum, [, count]) => sum + count, 0);
  return { taskLimit, phaseLimits, confirmationReserve };
}

export function diagnosticGenerationLimit(plan: Pick<ExperimentPlan, "tasks" | "rounds" | "repetitions" | "audit" | "diagnostic">, limit: number): number {
  if (!plan.audit || plan.audit.generationLimit !== undefined || plan.audit.frozenChildren) return generationRequestLimit(plan);
  const single = { ...plan, audit: { ...plan.audit, generationLimit: 1 } };
  const reserved = allocateExperimentRequests(single, limit);
  if (limit < minimumExperimentRequests(plan)) return 1;
  return allocateExperimentRequests(plan, limit).taskLimit === reserved.taskLimit ? GENERATION_REQUEST_LIMIT : 1;
}

export interface ExperimentResult {
  strategy: StrategyCandidate;
  rounds: ExperimentRound[];
  promoted: boolean;
  productivity?: ProductivityEvidence;
  stopReason?: "baseline-ceiling" | "holdout-regression" | "productivity-unproven" | "archive-verified" | "diagnostic-only";
}

/**
 * No task may regress in quality; at equal quality, requests may not rise on any task and must drop
 * at least 20% in total. An improvement must clear the baseline's own noise: on some task the
 * candidate's worst repetition beats the baseline's best one.
 */
export function improvementVerdict(baseline: readonly TrialScore[], candidate: readonly TrialScore[]): { accepted: boolean; reason: string } {
  if (baseline.length === 0 || baseline.length !== candidate.length) throw new Error("comparison trials are incomplete");
  for (const score of [...baseline, ...candidate]) {
    if (score.infrastructureFailures !== undefined && (!Number.isSafeInteger(score.infrastructureFailures) || score.infrastructureFailures < 1)) {
      throw new Error("invalid infrastructure failure count");
    }
  }
  let improved = false;
  let beforeRequests = 0; let afterRequests = 0; let costRegression = false;
  for (let index = 0; index < baseline.length; index += 1) {
    const before = baseline[index]!;
    const after = candidate[index]!;
    if (before.taskId !== after.taskId || before.taskDigest !== after.taskDigest || before.total !== after.total || before.total < 1) {
      throw new Error("comparison task contracts differ");
    }
    for (const score of [before, after]) {
      if (!Number.isSafeInteger(score.total) || !Number.isSafeInteger(score.passed) || score.passed < 0 || score.passed > score.total
        || !Number.isSafeInteger(score.requests) || score.requests < 0 || score.requests > 12 || (score.requests === 0 && score.passed !== 0)
        || !/^sha256:[a-f0-9]{64}$/.test(score.sourceDigest)) throw new Error("invalid measured trial score");
      if (typeof score.completed !== "boolean" || !Array.isArray(score.results) || score.results.length !== score.total
        || new Set(score.results.map(result => result.id)).size !== score.total
        || score.results.some(result => typeof result.id !== "string" || !result.id || typeof result.passed !== "boolean")
        || score.passed !== (score.completed ? score.results.filter(result => result.passed).length : 0)) {
        throw new Error("invalid measured check outcomes");
      }
    }
    const outcomes = new Map(after.results.map(result => [result.id, result.passed]));
    if (before.results.some(result => !outcomes.has(result.id))) throw new Error("comparison check contracts differ");
    if (before.infrastructureFailures || after.infrastructureFailures) continue;
    if (before.results.some(result => result.passed && !outcomes.get(result.id)) || (before.completed && !after.completed)) {
      return { accepted: false, reason: "A previously passed check regressed; retain the parent strategy." };
    }
    if (after.passed < before.passed) return { accepted: false, reason: "Independent task regression; retain the parent strategy." };
    beforeRequests += before.requests; afterRequests += after.requests;
    costRegression ||= after.requests > before.requests;
  }
  if ([...baseline, ...candidate].some(score => score.infrastructureFailures)) {
    return { accepted: false, reason: "Infrastructure-affected trials cannot establish a comparative improvement." };
  }
  const byTask = (scores: readonly TrialScore[]) => {
    const groups = new Map<string, number[]>();
    for (const score of scores) groups.set(score.taskId, [...(groups.get(score.taskId) ?? []), score.passed]);
    return groups;
  };
  const baselineBest = new Map([...byTask(baseline)].map(([task, passed]) => [task, Math.max(...passed)]));
  for (const [task, passed] of byTask(candidate)) {
    if (Math.min(...passed) > baselineBest.get(task)!) improved = true;
  }
  if (improved) return { accepted: true, reason: "Measured tasks improved within the same per-task request cap." };
  if (baseline.every(score => score.passed === score.total) && beforeRequests > 0 && !costRegression
    && afterRequests < beforeRequests && afterRequests <= beforeRequests * 0.8) return { accepted: true, reason: "Quality was preserved with at least 20% fewer requests and no per-trial request increase." };
  return { accepted: false, reason: "No independent quality or material request-efficiency gain; retain the parent strategy." };
}

async function optionalRecord<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Completed phases are reused as is; an interrupted paid phase must be resumed explicitly by the user. */
export async function runExperiment(plan: ExperimentPlan, directory: string, hooks: ExperimentHooks, signal: AbortSignal,
  resume = false): Promise<ExperimentResult> {
  if (plan.schemaVersion !== 3) throw new Error("Experiment protocol changed; start a new experiment without modifying old records");
  assertProjectTaskPack({ schemaVersion: 1, tasks: plan.tasks });
  for (const task of plan.tasks) assertTrialContext(plan.contexts?.[task.id]!);
  if (!Number.isSafeInteger(plan.rounds) || plan.rounds < 1 || plan.rounds > 3
    || !Number.isSafeInteger(plan.repetitions) || plan.repetitions < (plan.diagnostic ? 1 : 2) || plan.repetitions > 3
    || plan.tasks.length < 2 || new Set(plan.tasks.map((task) => task.id)).size !== plan.tasks.length) {
    throw new Error("experiment requires distinct tasks, repeated controls and bounded rounds");
  }
  const digest = improvementDigest(plan);
  const original = await optionalRecord<{ digest: string }>(join(directory, "plan.json"));
  if (original && original.digest !== digest) throw new Error("sealed experiment changed");
  if (!original) await writeTrialRecord(join(directory, "plan.json"), { digest, plan });
  const phase = async <T>(key: string, input: unknown, action: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    const inputDigest = improvementDigest(input);
    const path = join(directory, `${key}.result.json`);
    const previous = await optionalRecord<{ inputDigest: string; valueDigest: string; value: T }>(path);
    if (previous) {
      if (previous.inputDigest !== inputDigest) throw new Error("completed phase input changed");
      if (previous.valueDigest !== improvementDigest(previous.value)) throw new Error("completed phase result changed");
      return previous.value;
    }
    const attempt = join(directory, `${key}.started.json`);
    const started = await optionalRecord<{ inputDigest: string }>(attempt);
    if (started && (started.inputDigest !== inputDigest || !resume)) throw new Error("interrupted phase requires explicit resume with its original inputs");
    if (!started) await writeTrialRecord(attempt, { inputDigest, startedAt: new Date().toISOString() });
    hooks.progress(key);
    const value = await action();
    signal.throwIfAborted();
    await writeTrialRecord(path, { inputDigest, valueDigest: improvementDigest(value), value });
    return value;
  };
  const evaluate = async (strategy: StrategyCandidate, tasks: ProjectTask[], prefix: string) => {
    const scores: TrialScore[] = [];
    for (let repetition = 0; repetition < plan.repetitions; repetition += 1) {
      for (let index = 0; index < tasks.length; index += 1) {
        const task = tasks[index]!;
        const key = `${prefix}-task-${index}-repeat-${repetition}`;
        const score = await phase(key, { strategy, task, context: plan.contexts[task.id] }, () => hooks.solve(strategy, task, key, signal));
        if (score.taskId !== task.id || score.taskDigest !== improvementDigest(task) || score.total !== task.checks.length
          || canonicalJson(score.results?.map(result => result.id).sort()) !== canonicalJson(task.checks.map(check => check.id).sort())) {
          throw new Error("trial does not match the sealed task");
        }
        improvementVerdict([score], [score]);
        if (score.infrastructureFailures) throw new Error("An infrastructure-affected trial cannot enter search or independent comparison; its output and cost remain recorded");
        scores.push(score);
      }
    }
    return scores;
  };
  const search = plan.tasks.filter(task => task.split === "search");
  const holdout = plan.tasks.filter(task => task.split === "holdout");
  let best = plan.initial;
  let scores = plan.audit ? [] : await evaluate(best, search, "baseline");
  const baseline = scores;
  const archive: SearchRecord[] = [{ strategy: best, scores }];
  const rounds: ExperimentRound[] = [];
  if (scores.length) improvementVerdict(scores, scores);
  if (scores.length && scores.every((score) => score.passed === score.total && score.requests === 1)) {
    hooks.progress("baseline-saturated");
    return { strategy: best, rounds, promoted: false, stopReason: "baseline-ceiling" };
  }
  if (plan.audit) {
    if (plan.rounds !== 1 || !plan.audit.evidence.length || JSON.stringify(plan.audit.evidence).length > 28_000) throw new Error("Invalid complete-audit evidence");
    const proposed = plan.audit.nominee ? { candidate: plan.audit.nominee } : await phase("round-1-proposal",
      { parent: plan.initial, target: plan.audit.target, feedback: plan.audit.evidence },
      () => hooks.propose(plan.initial, plan.audit!.evidence, "round-1", signal, plan.audit!.target));
    const candidate = proposed.candidate;
    if (!candidate || candidate.validationError) {
      if (candidate) await hooks.reject(candidate, candidate.validationError!);
      return { strategy: plan.initial, rounds: [{ round: 1, parent: plan.initial.reference, ...(candidate ? { candidate } : {}),
        scores: [], searchAccepted: false, reason: candidate?.validationError ?? proposed.reason ?? "No candidate was nominated." }], promoted: false };
    }
    if (candidate.reference.kind !== "artifact" || candidate.source === plan.initial.source) throw new Error("Audit nomination is not a distinct strategy");
    best = candidate;
    rounds.push({ round: 1, parent: plan.initial.reference, candidate, scores: [], searchAccepted: false,
      reason: "Nominated from earlier development evidence; no search quality claim." });
  }
  for (let round = 1; !plan.audit && round <= plan.rounds; round += 1) {
    const key = `round-${round}`;
    const preferred = selectSearchParent(archive);
    const selectedId = hooks.selectParent ? await hooks.selectParent(archive, best, preferred.strategy, key, signal) : preferred.strategy.reference.id;
    const parentRecord = archive.find(record => record.strategy.reference.id === selectedId);
    if (!parentRecord) throw new Error("Search policy selected an unobserved parent");
    const parent = parentRecord.strategy;
    const feedback = searchFeedback(parentRecord, archive);
    for (const record of rounds.filter(record => record.candidate?.validationError).slice(-2)) {
      feedback.push({ invalidStrategy: record.candidate!.reference, contractFailure: record.candidate!.validationError!.slice(0, 1_000) });
    }
    const proposed = await phase(`${key}-proposal`, { parent, feedback }, () => hooks.propose(parent, feedback, key, signal));
    parentRecord.expansions = (parentRecord.expansions ?? 0) + 1;
    const candidate = proposed.candidate;
    if (candidate && (candidate.reference.kind !== "artifact" || candidate.source === parent.source)) throw new Error("proposal did not produce a distinct strategy");
    const measured = !candidate || candidate.validationError ? [] : await evaluate(candidate, search, key);
    if (candidate && measured.length && !archive.some(record => record.strategy.source === candidate.source)) {
      archive.push({ strategy: candidate, scores: measured, parentId: parent.reference.id });
    }
    const verdict = !candidate ? { accepted: false, reason: proposed.reason ?? "The parent improver did not produce another proposal." }
      : candidate.validationError ? { accepted: false, reason: candidate.validationError } : improvementVerdict(scores, measured);
    const record: ExperimentRound = { round, parent: parent.reference, ...(candidate ? { candidate } : {}),
      scores: measured, searchAccepted: verdict.accepted, reason: verdict.reason };
    rounds.push(record);
    const recorded = await optionalRecord<ExperimentRound>(join(directory, `${key}.decision.json`));
    if (recorded && canonicalJson(recorded) !== canonicalJson(record)) throw new Error("experiment decision changed");
    if (!recorded) await writeTrialRecord(join(directory, `${key}.decision.json`), record);
    if (verdict.accepted) {
      best = candidate!; scores = measured;
    }
    else if (candidate?.validationError) await hooks.reject(candidate, verdict.reason);
  }
  for (const record of archive) if (record.strategy !== plan.initial && record.strategy !== best) {
    await hooks.reject(record.strategy, "Search archive retained; this variant was not selected for independent acceptance.");
  }
  if (best === plan.initial) return { strategy: best, rounds, promoted: false };
  // Both improvers modify the same target and see only the same search feedback.
  const feedback = plan.audit?.evidence ?? searchFeedback({ strategy: plan.initial, scores: baseline }, []);
  const target = plan.initial;
  const children: Array<StrategyCandidate | null> = [];
  for (let sample = 0; sample < PRODUCTIVITY_PAIRS; sample++) {
    for (const [label, parent] of [["control", plan.initial], ["candidate", best]] as const) {
      const key = `productivity-${label}-${sample}`;
      const frozen = plan.audit?.frozenChildren?.[children.length];
      const proposed = plan.audit?.frozenChildren ? { candidate: frozen ?? null } : await phase(`${key}-proposal`, { parent, target, feedback },
        () => hooks.propose(parent, feedback, key, signal, target));
      children.push(proposed.candidate);
    }
  }
  const generationFailures = children.flatMap((child, index) => !child || child.validationError ? [{
    parent: index % 2 === 0 ? "control" as const : "candidate" as const, sample: Math.floor(index / 2),
    ...(child ? { artifactId: child.reference.id } : {}), reason: child?.validationError ?? "No descendant was produced",
  }] : []);
  if (generationFailures.length && !plan.diagnostic) {
    for (const child of children) if (child) await hooks.reject(child, child.validationError ?? "Productivity comparison was incomplete.");
    await hooks.reject(best, "The improver did not produce a valid comparable descendant.");
    return { strategy: plan.initial, rounds, promoted: false, stopReason: "productivity-unproven" };
  }
  // Once holdout acceptance starts, no candidate is generated or revised.
  const control = await evaluate(plan.initial, holdout, "holdout-control");
  const measured = await evaluate(best, holdout, "holdout-candidate");
  const verdict = improvementVerdict([...baseline, ...control], [...scores, ...measured]);
  const decision = { strategy: best.reference, control, measured, ...verdict };
  const decisionPath = join(directory, "final.decision.json");
  const existing = await optionalRecord(decisionPath);
  if (existing && canonicalJson(existing) !== canonicalJson(decision)) throw new Error("final acceptance changed");
  if (!existing) await writeTrialRecord(decisionPath, decision);
  if (!verdict.accepted && !plan.audit && !plan.diagnostic) {
    for (const child of children) await hooks.reject(child!, "The parent strategy failed independent acceptance.");
    await hooks.reject(best, "Independent holdout regression; search is closed without promotion.");
    return { strategy: plan.initial, rounds, promoted: false, stopReason: "holdout-regression" };
  }
  const controlScores: TrialScore[] = []; const candidateScores: TrialScore[] = [];
  for (let sample = 0; sample < PRODUCTIVITY_PAIRS; sample++) {
    const before = children[sample * 2]; const after = children[sample * 2 + 1];
    if (before && !before.validationError) controlScores.push(...await evaluate(before, holdout, `productivity-control-${sample}`));
    if (after && !after.validationError) candidateScores.push(...await evaluate(after, holdout, `productivity-candidate-${sample}`));
  }
  const productivity: ProductivityEvidence = { target: target.reference, controlParent: plan.initial.reference,
    candidateParent: best.reference, controlChildren: children.flatMap((child, index) => child && index % 2 === 0 ? [child.reference] : []),
    candidateChildren: children.flatMap((child, index) => child && index % 2 === 1 ? [child.reference] : []),
    control: controlScores, candidate: candidateScores, ...(generationFailures.length ? { generationFailures, accepted: false,
      reason: "Descendant comparison is incomplete; failed generations have no task scores." } : improvementVerdict(controlScores, candidateScores)) };
  await phase("productivity-decision", productivity, async () => productivity);
  for (const child of children) if (child) await hooks.reject(child, "An evaluation-only descendant; never a production deployment.");
  if (plan.diagnostic) {
    await hooks.reject(best, "Diagnostic simulation is not evidence for production adoption.");
    return { strategy: plan.initial, rounds, productivity: { ...productivity, accepted: false,
      reason: generationFailures.length ? productivity.reason : "Diagnostic observations only; repeated independent controls remain required." }, promoted: false, stopReason: "diagnostic-only" };
  }
  if (!verdict.accepted) {
    await hooks.reject(best, "The complete audit did not demonstrate an independent execution gain.");
    return { strategy: plan.initial, rounds, productivity, promoted: false, stopReason: "holdout-regression" };
  }
  if (!productivity.accepted) {
    await hooks.reject(best, "No independent evidence that the new improver produces better descendants.");
    return { strategy: plan.initial, rounds, productivity, promoted: false, stopReason: "productivity-unproven" };
  }
  if (plan.audit?.frozenChildren || plan.audit?.evaluationOnly) return { strategy: best, rounds, productivity, promoted: false, stopReason: "archive-verified" };
  await phase("final-promotion", { candidate: best, baseline: plan.initial, rounds, decision, productivity }, async () => {
    await hooks.promote(best, plan.initial, signal); return { reference: best.reference };
  });
  return { strategy: best, rounds, productivity, promoted: true };
}
