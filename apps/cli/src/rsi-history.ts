import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { canonicalJson, improvementDigest } from "@chopin/evolution";
import type { ExperimentPlan, ExperimentResult, StrategyCandidate, TrialScore } from "./rsi-engine.js";
import { improvementVerdict } from "./rsi-engine.js";
import type { ProjectTask } from "./rsi-project.js";
import { projectEvidence } from "./rsi-input.js";

export function historicalOutcome(score: TrialScore): "success" | "task-failure" | "infrastructure" {
  if (score.infrastructureFailures) return "infrastructure";
  if (score.completed) return score.passed === score.total ? "success" : "task-failure";
  const feedback = (score.publicFeedback ?? {}) as { terminal?: string; policyError?: string; completion?: string };
  if (feedback.policyError || feedback.completion === "blocked" || feedback.completion === "max-tokens") return "task-failure";
  try {
    const end = JSON.parse(feedback.terminal ?? "null") as { error?: { code?: string } } | null;
    return end?.error?.code === "TASK_BUDGET_EXHAUSTED" ? "task-failure" : "infrastructure";
  } catch { return "infrastructure"; }
}

/** History may only serve as new development material, never as the control scores of the current run. */
export async function readDevelopmentHistory(directory: string, tasks: ProjectTask[]) {
  const config = JSON.parse(await readFile(join(directory, "run.json"), "utf8")) as {
    plan: ExperimentPlan; workspace: string; provider: string; model: string; runtimeDigest?: string;
  };
  let complete: ExperimentResult | undefined;
  try { complete = JSON.parse(await readFile(join(directory, "complete.json"), "utf8")) as ExperimentResult; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (config.plan.schemaVersion !== 3 || config.plan.id !== basename(directory)
    || (complete !== undefined && !Array.isArray(complete.rounds))) throw new Error("Unsupported development evidence record");
  const target = complete ? [...complete.rounds].reverse().find(round => round.candidate && !round.candidate.validationError)?.candidate
    : config.plan.audit?.nominee;
  if (!target) throw new Error("The completed experiment has no executable candidate to revise");
  const seenFamilies = new Set(config.plan.tasks.map(task => task.family));
  const inputs = new Set(config.plan.tasks.map(task => improvementDigest({ objective: task.objective, files: task.files })));
  for (const task of tasks.filter(task => task.split === "holdout")) {
    if (seenFamilies.has(task.family) || inputs.has(improvementDigest({ objective: task.objective, files: task.files }))) {
      throw new Error("Previously observed tasks cannot be reused as fresh independent acceptance");
    }
  }
  const strategies = [config.plan.initial, ...(config.plan.audit?.nominee ? [config.plan.audit.nominee] : []),
    ...(complete?.rounds.flatMap(round => round.candidate ? [round.candidate] : []) ?? [])];
  const observations: Array<{ phase: string; score: TrialScore; strategy: StrategyCandidate; task: ProjectTask; files: Record<string, string> }> = [];
  for (const file of (await readdir(directory)).filter(name => /^(baseline|round-\d+|holdout-(control|candidate))-task-\d+-repeat-\d+\.result\.json$/.test(name)).sort()) {
    const phase = file.slice(0, -".result.json".length);
    const stored = JSON.parse(await readFile(join(directory, file), "utf8")) as { inputDigest: string; value: TrialScore; valueDigest: string };
    if (stored.valueDigest !== improvementDigest(stored.value)) throw new Error("Historical trial content changed");
    const score = stored.value;
    improvementVerdict([score], [score]);
    const task = config.plan.tasks.find(task => task.id === score.taskId);
    if (!task || score.taskDigest !== improvementDigest(task)) throw new Error("Historical task contract changed");
    const strategy = strategies.find(strategy => stored.inputDigest === improvementDigest({ strategy, task, context: config.plan.contexts[task.id] }));
    if (!strategy) throw new Error("Historical strategy or input binding changed");
    const feedback = score.publicFeedback as { policyError?: unknown } | null;
    if (score.requests === 0 && typeof feedback?.policyError === "string") {
      if (score.completed || score.sourceDigest !== improvementDigest(task.files) || score.results.some(result => result.passed)) {
        throw new Error("Historical preflight failure contains task output");
      }
      observations.push({ phase, score, strategy, task, files: task.files });
      continue;
    }
    const saved = JSON.parse(await readFile(join(directory, phase, "completed.json"), "utf8")) as { attempt: string; resultDigest: string; result: unknown };
    if (saved.resultDigest !== improvementDigest(saved.result) || !saved.attempt.startsWith("attempt-") || basename(saved.attempt) !== saved.attempt) {
      throw new Error("Historical project result changed");
    }
    const output = JSON.parse(await readFile(join(directory, phase, saved.attempt, "output.json"), "utf8")) as { files: Record<string, string> };
    if (improvementDigest(output.files) !== score.sourceDigest) throw new Error("Historical output changed");
    observations.push({ phase, score, strategy, task, files: output.files });
  }
  const selected = new Set<string>();
  const evidence: unknown[] = [];
  for (const item of observations.sort((left, right) => Number(right.score.passed < right.score.total) - Number(left.score.passed < left.score.total)
    || left.phase.localeCompare(right.phase))) {
    if (evidence.length >= 6) break;
    const outcome = historicalOutcome(item.score);
    const key = `${item.task.family}:${outcome}`;
    if (selected.has(key)) continue;
    selected.add(key);
    if (outcome === "infrastructure") {
      const feedback = item.score.publicFeedback as { terminal?: string };
      const note = { kind: "infrastructure-observation", sourceExperiment: config.plan.id, phase: item.phase,
        taskDigest: item.score.taskDigest, requests: item.score.requests, terminal: feedback.terminal ?? "unknown interruption",
        ...(item.score.infrastructureFailures ? { infrastructureFailures: item.score.infrastructureFailures } : {}),
        measuredQuality: false };
      if (canonicalJson([...evidence, note]).length <= 27_000) evidence.push(note);
      continue;
    }
    const identity = { kind: "historical-development", outcome, sourceExperiment: config.plan.id, phase: item.phase,
      strategy: item.strategy.reference, runtimeDigest: config.runtimeDigest ?? null,
      evidenceScope: "Version-bound observation; effect on another strategy or runtime requires revalidation.",
      taskDigest: item.score.taskDigest, sourceDigest: item.score.sourceDigest, requests: item.score.requests,
      completed: item.score.completed, results: item.score.results, feedback: item.score.publicFeedback };
    const full = { ...identity, project: projectEvidence(item.task, item.files) };
    const entry = canonicalJson([...evidence, full]).length <= 27_000 ? full : identity;
    if (canonicalJson([...evidence, entry]).length <= 27_000) evidence.push(entry);
    if (evidence.length === 6) break;
  }
  if (!evidence.length) throw new Error("No complete development evidence is available");
  return { workspace: config.workspace, provider: config.provider, model: config.model,
    audit: { sourceExperiment: config.plan.id, target: target as StrategyCandidate, evidence } };
}

export async function readUnopenedAudit(directory: string, freshTasks?: ProjectTask[]) {
  const config = JSON.parse(await readFile(join(directory, "run.json"), "utf8")) as {
    id: string; plan: ExperimentPlan; workspace: string; provider: string; model: string; instructionsDigest: string; reasoningEffort?: string;
  };
  if (config.id !== basename(directory) || config.plan.schemaVersion !== 3 || !config.plan.audit) throw new Error("Not a sealed complete audit");
  const names = await readdir(directory);
  if (!freshTasks && (names.some(name => /-task-\d+-repeat-\d+\.started\.json$/.test(name)) || (names.includes("complete.json") && !config.plan.diagnostic))) {
    throw new Error("Independent evaluation has already begun; a new audit needs fresh tasks");
  }
  const heldOut = (freshTasks ?? config.plan.tasks).filter(task => task.split === "holdout");
  if (freshTasks && heldOut.some(task => config.plan.tasks.some(previous => task.family === previous.family
    || improvementDigest({ objective: task.objective, files: task.files }) === improvementDigest({ objective: previous.objective, files: previous.files })))) {
    throw new Error("Previously declared tasks cannot be reused as fresh independent acceptance");
  }
  const root = dirname(directory);
  for (const id of (await readdir(root)).filter(name => /^[a-f0-9-]{36}$/.test(name) && (freshTasks || name !== config.id))) {
    const files = await readdir(join(root, id));
    if (!files.includes("run.json")) continue;
    const previous = JSON.parse(await readFile(join(root, id, "run.json"), "utf8")) as { plan: ExperimentPlan };
    for (const file of files) {
      const match = /^(baseline|round-\d+|holdout-(?:control|candidate)|productivity-(?:control|candidate)-\d+)-task-(\d+)-repeat-\d+\.started\.json$/.exec(file);
      if (!match) continue;
      const split = match[1] === "baseline" || match[1]!.startsWith("round-") ? "search" : "holdout";
      const task = previous.plan.tasks.filter(task => task.split === split)[Number(match[2])];
      if (!task) throw new Error("Archived trial does not match its declared task index");
      if (heldOut.some(current => current.family === task.family || improvementDigest({ objective: current.objective, files: current.files })
        === improvementDigest({ objective: task.objective, files: task.files }))) throw new Error("An archived task was already exposed in another experiment");
    }
  }
  const phase = JSON.parse(await readFile(join(directory, "round-1-proposal.result.json"), "utf8")) as {
    inputDigest: string; valueDigest: string; value: { candidate: StrategyCandidate | null };
  };
  if (phase.valueDigest !== improvementDigest(phase.value) || phase.inputDigest !== improvementDigest({
    parent: config.plan.initial, target: config.plan.audit.target, feedback: config.plan.audit.evidence,
  }) || !phase.value.candidate || phase.value.candidate.validationError) throw new Error("The archived nomination is not valid");
  const frozenChildren = !freshTasks && config.plan.diagnostic ? await readFrozenChildren(directory, config.plan, phase.value.candidate) : undefined;
  return { ...config, audit: { sourceExperiment: config.plan.audit.sourceExperiment, target: config.plan.audit.target,
    evidence: config.plan.audit.evidence, nominee: phase.value.candidate,
    generationLimit: freshTasks ? 2 : 1, resumedFrom: config.id,
    ...(freshTasks ? { evaluationOnly: true as const } : {}), ...(frozenChildren ? { frozenChildren } : {}) } };
}

async function readFrozenChildren(directory: string, plan: ExperimentPlan, nominee: StrategyCandidate): Promise<Array<StrategyCandidate | null>> {
  const children: Array<StrategyCandidate | null> = [];
  for (let sample = 0; sample < 2; sample++) {
    for (const [label, parent] of [["control", plan.initial], ["candidate", nominee]] as const) {
      const key = `productivity-${label}-${sample}`;
      const stored = JSON.parse(await readFile(join(directory, `${key}-proposal.result.json`), "utf8")) as {
        inputDigest: string; valueDigest: string; value: { candidate: StrategyCandidate | null };
      };
      if (stored.inputDigest !== improvementDigest({ parent, target: plan.initial, feedback: plan.audit!.evidence })
        || stored.valueDigest !== improvementDigest(stored.value)
        || (stored.value.candidate !== null && stored.value.candidate?.reference.kind !== "artifact")) throw new Error("Frozen descendant provenance changed");
      children.push(stored.value.candidate);
    }
  }
  return children;
}

/** An audit only accepts frozen artifacts with complete provenance; neither the earlier scores nor deployment eligibility carry over. */
export async function readFrozenAudit(directory: string, tasks: ProjectTask[]) {
  const history = await readDevelopmentHistory(directory, tasks);
  const config = JSON.parse(await readFile(join(directory, "run.json"), "utf8")) as {
    id: string; plan: ExperimentPlan; reasoningEffort?: string;
  };
  if (!config.plan.audit || config.plan.rounds !== 1 || config.id !== basename(directory)) throw new Error("Only a complete audit can be rechecked");
  const nominee = history.audit.target;
  const children = await readFrozenChildren(directory, config.plan, nominee);
  if (children.some(child => !child || child.validationError)) throw new Error("Frozen comparison has invalid descendants");
  return { ...history, initial: config.plan.initial, reasoningEffort: config.reasoningEffort,
    audit: { ...config.plan.audit, sourceExperiment: config.id, nominee, frozenChildren: children } };
}
