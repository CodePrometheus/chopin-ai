import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { foldEvolutionEvents, assertEvolutionEvent, improvementDigest, canonicalJson, IMPROVER_TOOL, ArtifactStore } from "@chopin/evolution";
import type { CapabilityManifest, EvolutionEvent } from "@chopin/evolution";
import { evaluateTrialSource, readTrialTask, writeTrialRecord } from "./rsi-trial.js";

interface Submission {
  phase: string; sessionId: string; sourceDigest: string; manifest: CapabilityManifest; mode: string;
}

export async function verifyImproverSubmission(input: { workspace: string; outputDirectory: string; eventsFile: string;
  artifactsDirectory: string; generation: string }) {
  const submission: Submission = JSON.parse(await readFile(join(input.outputDirectory, "submission.json"), "utf8"));
  if (submission.mode !== "improve") throw new Error("submission is not an improver version");
  const projection = foldEvolutionEvents((await readFile(input.eventsFile, "utf8")).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line)));
  const manifest = submission.manifest;
  const artifact = projection.artifacts.find((item) => item.id === `${manifest.id}:${manifest.version}`);
  if (!artifact?.enabled || artifact.state !== "active" || canonicalJson(artifact.manifest) !== canonicalJson(manifest)
    || canonicalJson(manifest.provides.tools) !== canonicalJson([IMPROVER_TOOL])) throw new Error("submitted improver is not the exact active artifact");
  const loaded = artifact.deploymentReceipts.find((receipt) => receipt.operationId.startsWith("runtime-load-")
    && receipt.processGeneration === input.generation && receipt.health === "pass");
  if (loaded === undefined) throw new Error("submitted improver has not hot-activated in the owning process");
  const plan = projection.improvements?.find((item) => item.id === manifest.lineage.improvementId);
  if (plan?.sessionId !== submission.sessionId) throw new Error("improver has no matching owning plan");
  const stored = await new ArtifactStore(input.artifactsDirectory).inspect(artifact.contentDigest);
  const hashes = await Promise.all([join(input.workspace, "candidate", "index.mjs"), join(stored.path, stored.manifest.entry)]
    .map(async (file) => `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`));
  if (hashes.some((hash) => hash !== submission.sourceDigest)) throw new Error("active source differs from submitted source");
  const report = { artifactId: artifact.id, contentDigest: artifact.contentDigest, sourceDigest: submission.sourceDigest,
    sessionId: submission.sessionId, generation: input.generation, loadedReceiptId: loaded.receiptId,
    origin: plan.input.strategy, improvementId: plan.id, benefitVerified: false };
  await writeTrialRecord(join(input.outputDirectory, "activation.json"), report);
  return report;
}

export async function evaluateTrialSubmission(input: {
  workspace: string; outputDirectory: string; taskFile: string; taskDigest: string; eventsFile: string;
}) {
  const output = resolve(input.outputDirectory);
  const submission: Submission = JSON.parse(await readFile(join(output, "submission.json"), "utf8"));
  if (submission.mode !== "solve") throw new Error("only completed task submissions have a task score");
  const task = await readTrialTask(input.taskFile, input.taskDigest);
  if (task.hiddenCases.length === 0) throw new Error("independent cases are missing");
  const events = (await readFile(input.eventsFile, "utf8")).split("\n").filter((line) => line.trim()).map((line) => {
    const event: EvolutionEvent = JSON.parse(line); assertEvolutionEvent(event); return event;
  });
  const plan = foldEvolutionEvents(events).improvements?.find((item) => item.id === submission.manifest.lineage.improvementId);
  if (plan === undefined || plan.sessionId !== submission.sessionId) throw new Error("submission has no matching host planning record");
  const expectedManifest = { ...task.manifest, lineage: { ...task.manifest.lineage, improvementId: plan.id } };
  if (canonicalJson(expectedManifest) !== canonicalJson(submission.manifest)) throw new Error("submission changed the assigned manifest");
  const source = await readFile(join(input.workspace, "index.mjs"));
  if (`sha256:${createHash("sha256").update(source).digest("hex")}` !== submission.sourceDigest) throw new Error("submitted source changed");
  const score = await evaluateTrialSource(input.workspace, expectedManifest, task.hiddenCases);
  const report = { phase: submission.phase, sessionId: submission.sessionId, taskId: task.id, taskDigest: input.taskDigest,
    starterDigest: improvementDigest(task.starter), strategy: plan.input.strategy, improvementId: plan.id, ...score };
  await writeTrialRecord(join(output, "independent.json"), report);
  return report;
}

export async function trialRequestUsage(directory: string, phase: string) {
  const files = (await readdir(directory)).filter((name) => /^\d{6}\.request\.json$/.test(name)).sort();
  const requests = [];
  for (const file of files) {
    const request = JSON.parse(await readFile(join(directory, file), "utf8"));
    if (request.phase !== phase) continue;
    let result;
    try { result = JSON.parse(await readFile(join(directory, file.replace(".request.", ".result.")), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (result !== undefined && result.requestId !== request.requestId) throw new Error("request result identity differs");
    requests.push({ request, result: result ?? null });
  }
  return { attempts: requests.length, unsettled: requests.filter((item) => item.result === null).length,
    missingUsage: requests.filter((item) => item.result?.usage === undefined).length, requests };
}

export async function compareTrialReports(root: string, baselinePhase: string, evolvedPhase: string) {
  const control = join(resolve(root), "control");
  const run = JSON.parse(await readFile(join(control, "run.json"), "utf8"));
  for (const phase of [baselinePhase, evolvedPhase]) {
    if (!/^[a-z0-9-]+$/.test(phase) || !run.phases.some((item: { id: string; mode: string }) => item.id === phase && item.mode === "solve")) {
      throw new Error("comparison phase was not declared");
    }
  }
  type Score = Awaited<ReturnType<typeof evaluateTrialSubmission>>;
  const [baseline, evolved]: Score[] = await Promise.all([baselinePhase, evolvedPhase]
    .map(async (phase) => JSON.parse(await readFile(join(control, phase, "independent.json"), "utf8"))));
  if (!baseline || !evolved || baseline.taskDigest !== evolved.taskDigest || baseline.casesDigest !== evolved.casesDigest
    || baseline.starterDigest !== evolved.starterDigest || baseline.total !== evolved.total || baseline.total === 0
    || baseline.strategy.kind !== "builtin" || evolved.strategy.kind !== "artifact") throw new Error("comparison inputs or strategy origins differ from the paired design");
  const arms = [];
  for (const phase of [baselinePhase, evolvedPhase]) {
    const usage = await trialRequestUsage(join(control, "budget"), phase);
    const phaseBudget = JSON.parse(await readFile(join(control, "budget", phase, "phase.json"), "utf8"));
    const overlay = JSON.parse(await readFile(join(control, phase, "overlay.yml"), "utf8"));
    const budgetConfig = overlay.flatMap((item: { insert?: Array<{ id: string; config: unknown }> }) => item.insert ?? [])
      .find((item: { id: string }) => item.id === "rsi-request-budget")?.config;
    if (phaseBudget.limit !== run.phaseLimit || usage.attempts > run.phaseLimit || usage.unsettled !== 0 || usage.missingUsage !== 0
      || !budgetConfig || budgetConfig.reasoningEffort !== run.reasoningEffort || budgetConfig.model !== run.model
      || budgetConfig.provider !== run.provider || usage.requests.some(({ request }) => request.provider !== run.provider || request.model !== run.model)) {
      throw new Error("comparison route, settings, budget or measured usage is incomplete");
    }
    const totals = usage.requests.reduce((sum, { result }) => ({ inputTokens: sum.inputTokens + result.usage.inputTokens,
      cacheReadTokens: sum.cacheReadTokens + (result.usage.cacheReadTokens ?? 0),
      outputTokens: sum.outputTokens + result.usage.outputTokens }), { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 });
    arms.push({ phase, attempts: usage.attempts, ...totals });
  }
  const report = { baseline: { ...arms[0], passed: baseline.passed, total: baseline.total, strategy: baseline.strategy },
    evolved: { ...arms[1], passed: evolved.passed, total: evolved.total, strategy: evolved.strategy },
    taskDigest: baseline.taskDigest, casesDigest: baseline.casesDigest,
    qualityVerdict: evolved.passed < baseline.passed ? "regression" : evolved.passed > baseline.passed ? "observed-gain" : "no-quality-gain",
    limitations: ["One run per arm does not establish a general improvement or a reliable cost advantage.",
      "Token measurements are provider-reported, not subscription charges. Strategy-generation requests are additional overhead."] };
  await writeTrialRecord(join(control, `${baselinePhase}-${evolvedPhase}.comparison.json`), report);
  return report;
}
