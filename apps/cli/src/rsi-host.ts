import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { ContextFormed, GenerateOptions } from "@deepseek-ai/dsh-llm";
import type { ExperimentCoordinator } from "@chopin/evolution-runtime/experiments";
import { loadPersonalInstructions, INSTRUCTION_POLICY } from "@chopin/evolution-runtime/instructions";
import { RequestBudget } from "@chopin/evolution-runtime/request-budget";
import { latestHumanPrompt, modelEnvironment } from "@chopin/evolution-runtime/facts";
import { artifactBuilt, artifactDrafted, artifactRejected, artifactQuarantined, candidateRejected, baselineImprovementPlan, assertImprovementPlan,
  canonicalJson, improvementDigest, IMPROVER_TOOL, candidateObserved, candidateCorroborated, candidateClassified, baselineImprover, assertImprovementInput } from "@chopin/evolution";
import type { ImprovementInput } from "@chopin/evolution";
import { scrub } from "@chopin/ledger";
import { SandboxedPlugin, PluginSandboxError, PluginExecutionError, verifyCapabilityFixtures } from "@chopin/plugin-sandbox";
import type { ExperimentHooks, ExperimentPlan, ProductivityEvidence, StrategyCandidate, TrialScore } from "./rsi-engine.js";
import { allocateExperimentRequests, diagnosticGenerationLimit, generationRequestLimit, minimumExperimentRequests, runExperiment } from "./rsi-engine.js";
import { writeTrialRecord } from "./rsi-trial.js";
import { assertProjectExecutionAvailable, assertProjectTaskPack, loadProjectTasks, PROJECT_TASK_FILE } from "./rsi-project.js";
import type { ProjectTask } from "./rsi-project.js";
import { runProjectSession, projectToolContracts } from "./rsi-session.js";
import { executionContractFixtures, executionTemplate, executionInterfaceContract, proposalOrigin } from "./rsi-capability.js";
import type { ProposalOrigin } from "./rsi-capability.js";
import { assertTrialSources, captureTrialContext } from "./rsi-context.js";
import { selectRoleArtifact } from "@chopin/evolution-runtime";
import type { TriggerFacts } from "@chopin/evolution-runtime";
import { FailureReplays, failureReplay } from "./rsi-replay.js";
import { improvementEvidence } from "./rsi-input.js";
import { readDevelopmentHistory, readUnopenedAudit, readFrozenAudit } from "./rsi-history.js";
import { applySourceEdits, assertGenerationFinish, sourceEditSchema, SourceProposalError, SOURCE_EDIT_TOOL } from "./rsi-generation.js";
import { IMPROVER_INPUT_SCHEMA } from "@chopin/evolution-runtime/improver-template";
import { assertPublicToolOutputs } from "@chopin/plugin-adapter";

export const name = "chopin-rsi-executor";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "chopin-rsi-executor": { kind: "chopin-rsi-executor" } & ContextFormed;
  }
}
export const inject = ["chopinEvolution", "llm"];

class CandidatePlanError extends Error {}

interface RunConfig {
  id: string;
  createdAt: string;
  sessionId: string;
  provider: string;
  model: string;
  reasoningEffort?: GenerateOptions["reasoningEffort"];
  maxRequests: number;
  allocation: ReturnType<typeof allocateExperimentRequests>;
  instructionsDigest: string;
  runtimeDigest: string;
  facts: TriggerFacts;
  workspace: string;
  request: NonNullable<ReturnType<typeof latestHumanPrompt>>;
  plan: ExperimentPlan;
}

async function optional<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Search candidates are kept only in the archive; formal deployment comes after independent engineering tasks pass acceptance. */
export class RsiExecutor extends Service implements ExperimentCoordinator {
  private readonly running = new Map<string, { id: string; abort: AbortController; done: Promise<void> }>();
  private starting?: { sessionId: string; cancelled: boolean };
  readonly root: string;
  private readonly replays: FailureReplays;
  private readonly loadedRuntime: Promise<{ digest: string } | { error: unknown }>;

  constructor(ctx: Context) {
    super(ctx, "chopinExperiments");
    this.root = join(dirname(ctx.chopinEvolution.events.path), "experiments");
    this.replays = new FailureReplays(join(this.root, "replays"));
    this.loadedRuntime = this.runtimeDigest().then(digest => ({ digest }), error => ({ error }));
    const captureAbort = new AbortController();
    let captures: Promise<void> = Promise.resolve();
    ctx.on("agent/pre-step", async ({ agent }, next) => {
      await captures;
      const result = await next();
      if (result.kind === "enter") {
        try { await this.replays.begin(agent); }
        catch (error) { ctx.logger.warn("replay checkpoint unavailable: %s", scrub(String(error))); }
      }
      return result;
    });
    ctx.on("session/event", (session, event) => {
      if (event.type !== "turn/end" || event.data.reason.kind !== "completed") return;
      captures = captures.then(async () => {
        const saved = await this.replays.finish(session, captureAbort.signal);
        if (saved) {
          const summary = `Saved ${saved} real failure replay(s); no model was called. See /rsi tasks.`;
          session.append("user/message", createUserMessage({ source: { kind: name, form: "notice", summary },
            content: [{ type: "text", text: summary }] }), { surfaceOp: "append" });
        }
      }).catch(error => { if (!captureAbort.signal.aborted) ctx.logger.warn("replay capture failed: %s", scrub(String(error))); });
    });
    ctx.on("session/flush", async () => { await captures; });
    ctx.effect(() => async () => {
      captureAbort.abort();
      await captures;
      for (const run of this.running.values()) run.abort.abort(new Error("Runtime stopped"));
      await Promise.all([...this.running.values()].map((run) => run.done));
    });
  }

  async start(agent: Agent, maxRequests: number, command: string): Promise<string> {
    return this.admit(agent, () => this.startRun(agent, maxRequests, command));
  }

  async audit(agent: Agent, sourceId: string, maxRequests: number, taskFile: string, command: string): Promise<string> {
    if (!/^[a-f0-9-]{36}$/.test(sourceId)) throw new Error("Invalid source experiment id");
    return this.admit(agent, () => this.startRun(agent, maxRequests, command, { sourceId, taskFile }));
  }

  async assess(agent: Agent, sourceId: string, maxRequests: number, command: string, taskFile?: string): Promise<string> {
    if (!/^[a-f0-9-]{36}$/.test(sourceId)) throw new Error("Invalid source experiment id");
    return this.admit(agent, () => this.startRun(agent, maxRequests, command, { sourceId, reuseNominee: true, taskFile }));
  }

  async recheck(agent: Agent, sourceId: string, maxRequests: number, taskFile: string, command: string): Promise<string> {
    if (!/^[a-f0-9-]{36}$/.test(sourceId)) throw new Error("Invalid experiment id");
    return this.admit(agent, () => this.startRun(agent, maxRequests, command, { sourceId, taskFile, frozen: true }));
  }

  async probe(agent: Agent, sourceId: string, maxRequests: number, taskFile: string, command: string): Promise<string> {
    if (!/^[a-f0-9-]{36}$/.test(sourceId)) throw new Error("Invalid experiment id");
    return this.admit(agent, () => this.startRun(agent, maxRequests, command, { sourceId, taskFile, diagnostic: true }));
  }

  private async admit<T>(agent: Agent, action: () => Promise<T>): Promise<T> {
    if (this.running.size > 0 || this.starting) throw new Error("An improvement experiment is already running");
    this.starting = { sessionId: String(agent.session.id), cancelled: false };
    try { return await action(); } finally { this.starting = undefined; }
  }

  private async personalInstructions() {
    return loadPersonalInstructions({ files: await this.instructionFiles() });
  }

  /** Same source as the preset row: the listed files, else the default global file only when it exists. */
  private async instructionFiles(): Promise<string[]> {
    if (process.env.CHOPIN_USER_INSTRUCTIONS) return JSON.parse(process.env.CHOPIN_USER_INSTRUCTIONS);
    const fallback = join(homedir(), ".claude", "CLAUDE.md");
    try {
      await access(fallback);
      return [fallback];
    } catch {
      return [];
    }
  }

  private async runtimeDigest(): Promise<string> {
    const modules = ["rsi-engine", "rsi-project", "rsi-project-worker", "rsi-session", "rsi-context", "rsi-capability", "rsi-host", "rsi-trial", "rsi-replay", "rsi-search", "rsi-input", "rsi-check", "rsi-history", "rsi-generation", "rsi-evidence"];
    const sources = await Promise.all(modules.map(module => readFile(new URL(`./${module}.js`, import.meta.url), "utf8")));
    for (const name of ["@chopin/evolution", "@chopin/evolution-runtime", "@chopin/plugin-adapter", "@chopin/plugin-sandbox"]) {
      const root = new URL(".", import.meta.resolve(name));
      const files = (await readdir(root, { withFileTypes: true })).filter(file => file.isFile() && file.name.endsWith(".js"))
        .map(file => file.name).sort();
      for (const file of files) sources.push(await readFile(new URL(file, root), "utf8"));
    }
    return improvementDigest({ node: process.version, runtime: this.ctx.chopinEvolution.dshVersion, sources });
  }

  private async loadedRuntimeDigest(): Promise<string> {
    const loaded = await this.loadedRuntime;
    if ("error" in loaded) throw loaded.error;
    if (loaded.digest !== await this.runtimeDigest()) throw new Error("Core execution code changed after startup; restart before beginning or resuming an experiment");
    return loaded.digest;
  }

  async tasks(agent: Agent): Promise<string> {
    const workspace = agent.session.header.cwd;
    if (!workspace) return "The current session has no project directory.";
    try {
      const pack = await loadProjectTasks(workspace);
      const replayed = await this.replays.apply(workspace, pack);
      return `${PROJECT_TASK_FILE}: ${pack.tasks.filter(task => task.split === "search").length} search task(s), ${pack.tasks.filter(task => task.split === "holdout").length} holdout task(s); ${replayed.tasks.filter((task, index) => task.id !== pack.tasks[index]!.id).length} use real failure replays, ${pack.tasks.filter(task => task.capture).length} have automatic capture enabled. No model has been called yet.`;
    } catch (error) { return String(error); }
  }

  private async startRun(agent: Agent, maxRequests: number, command: string, auditSource?: { sourceId: string; taskFile?: string; reuseNominee?: boolean; frozen?: boolean; diagnostic?: boolean }): Promise<string> {
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 4 || maxRequests > 120) throw new Error("An experiment needs a request limit between 4 and 120");
    const runtimeDigest = await this.loadedRuntimeDigest();
    const route = { ...agent.options };
    const facts = this.ctx.chopinEvolution.factsNowFor(agent);
    if (this.ctx.chopinEvolution.useBaselineImprover) throw new Error("A baseline-only profile cannot run a promotable improvement experiment");
    if (!route.provider || !route.model) throw new Error("Select a model before starting an experiment");
    route.reasoningEffort ??= (await this.ctx.llm.resolveModelInfo(route.provider, route.model)).reasoning?.defaultEffort;
    const workspace = agent.session.header.cwd;
    if (!workspace) throw new Error("A project workspace is required");
    const fresh = auditSource?.reuseNominee && auditSource.taskFile ? await loadProjectTasks(workspace, auditSource.taskFile) : undefined;
    const reuse = auditSource?.reuseNominee ? await readUnopenedAudit(join(this.root, auditSource.sourceId), fresh?.tasks) : undefined;
    const declared = fresh ?? (reuse ? { schemaVersion: 1 as const, tasks: reuse.plan.tasks } : await loadProjectTasks(workspace, auditSource?.taskFile));
    const pack = auditSource ? declared : await this.replays.apply(workspace, declared);
    assertProjectTaskPack(pack);
    const frozen = auditSource?.frozen ? await readFrozenAudit(join(this.root, auditSource.sourceId), pack.tasks) : undefined;
    const history = reuse ?? frozen ?? (auditSource ? await readDevelopmentHistory(join(this.root, auditSource.sourceId), pack.tasks) : undefined);
    if (history && (history.workspace !== workspace || history.provider !== route.provider || history.model !== route.model)) {
      throw new Error("Development evidence belongs to a different workspace or model route");
    }
    let audit: ExperimentPlan["audit"] = history?.audit;
    const diagnostic = auditSource?.diagnostic || (!fresh && reuse?.plan.diagnostic === true);
    const repetitions = diagnostic ? 1 : 2;
    const diagnosticMode = diagnostic ? { diagnostic: true as const } : {};
    if (diagnostic && audit) {
      const generationLimit = diagnosticGenerationLimit({ tasks: pack.tasks, rounds: 1, repetitions, audit, ...diagnosticMode }, maxRequests);
      audit = { ...audit, generationLimit };
    }
    const singleRound = allocateExperimentRequests({ tasks: pack.tasks, rounds: 1, repetitions, ...(audit ? { audit } : {}), ...diagnosticMode }, maxRequests);
    let rounds = 1;
    let allocation = singleRound;
    if (!audit && maxRequests >= minimumExperimentRequests({ tasks: pack.tasks, rounds: 2, repetitions: 2 })) {
      const repeated = allocateExperimentRequests({ tasks: pack.tasks, rounds: 2, repetitions: 2 }, maxRequests);
      if (repeated.taskLimit >= 6 || repeated.taskLimit === singleRound.taskLimit) { rounds = 2; allocation = repeated; }
    }
    await assertProjectExecutionAvailable();
    const instructionsDigest = improvementDigest((await this.personalInstructions()).text);
    if (reuse && instructionsDigest !== reuse.instructionsDigest) throw new Error("Personal instructions changed since the archived nomination");
    const id = randomUUID();
    const directory = join(this.root, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    agent.session.append("user/message", createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: command }] }), { surfaceOp: "append" });
    const request = latestHumanPrompt(agent.session)!;
    const initial = await this.ctx.chopinEvolution.readImprover(agent, facts);
    if (frozen && (canonicalJson(initial.reference) !== canonicalJson(frozen.initial.reference) || initial.source !== frozen.initial.source
      || route.reasoningEffort !== frozen.reasoningEffort)) throw new Error("Frozen comparison baseline or reasoning effort changed");
    if (reuse && (canonicalJson(initial.reference) !== canonicalJson(reuse.plan.initial.reference) || initial.source !== reuse.plan.initial.source
      || route.reasoningEffort !== reuse.reasoningEffort)) {
      throw new Error("The production baseline changed since nomination");
    }
    const stored = initial.reference.kind === "artifact" ? await this.ctx.chopinEvolution.artifacts.inspect(initial.reference.contentDigest) : undefined;
    const contexts: ExperimentPlan["contexts"] = {};
    for (const task of pack.tasks) {
      contexts[task.id] = reuse && !fresh ? reuse.plan.contexts[task.id]! : await captureTrialContext(this.ctx.chopinEvolution, workspace,
        modelEnvironment(route.provider, route.model), task.objective);
      await assertTrialSources(contexts[task.id]!, this.ctx.chopinEvolution);
    }
    const plan: ExperimentPlan = {
      schemaVersion: 3, id, objective: "Improve task execution and the procedure that produces future execution improvements, preserving host rules and independent evaluators.",
      initial: { ...initial, ...(stored ? { directory: stored.path, manifest: stored.manifest } : {}) },
      tasks: pack.tasks, contexts, replaySources: Object.fromEntries(pack.tasks.map((task, index) => [task.id, declared.tasks[index]!])),
      repetitions, rounds, ...diagnosticMode,
      ...(audit ? { audit } : {}),
    };
    const config: RunConfig = { id, createdAt: new Date().toISOString(), sessionId: String(agent.session.id), provider: route.provider, model: route.model,
      ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}), maxRequests, allocation, instructionsDigest,
      runtimeDigest, facts, workspace, request, plan };
    await writeTrialRecord(join(directory, "run.json"), config);
    if (this.starting?.cancelled) throw new Error("User cancelled experiment startup");
    this.launch(agent, config, false);
    return `${plan.diagnostic ? "Diagnostic simulation (cannot promote)" : audit ? "Full audit" : "Improvement experiment"} ${id} started; model ${config.provider}/${config.model}, at most ${maxRequests} requests, at most ${allocation.taskLimit} per task; ${allocation.confirmationReserve} reserved for verification. /rsi to check, /rsi stop to stop.`;
  }

  async resume(agent: Agent, id: string): Promise<string> {
    return this.admit(agent, () => this.resumeRun(agent, id));
  }

  private async resumeRun(agent: Agent, id: string): Promise<string> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid experiment id");
    const config = await optional<RunConfig>(join(this.root, id, "run.json"));
    if (!config || config.id !== id || config.sessionId !== String(agent.session.id)) throw new Error("Resume the owning session before continuing this experiment");
    if (config.plan.schemaVersion !== 3) throw new Error("This experiment uses an earlier protocol; its records are preserved, but it cannot be resumed with the new protocol");
    const completed = await optional(join(this.root, id, "complete.json"));
    if (completed) return `Experiment ${id} is already complete; no budget will be spent again.`;
    if (this.starting?.cancelled) throw new Error("User cancelled experiment startup");
    this.launch(agent, config, true);
    return `Resuming experiment ${id}; existing artifacts are reused and the original request limit still applies.`;
  }

  async stop(agent: Agent): Promise<string> {
    if (this.starting?.sessionId === String(agent.session.id)) {
      this.starting.cancelled = true;
      return "Experiment startup cancelled; no model request will be made.";
    }
    const run = this.running.get(String(agent.session.id));
    if (!run) return "No improvement experiment is running in the current session.";
    run.abort.abort(new Error("User stopped the experiment"));
    await run.done;
    return `Experiment ${run.id} stopped; artifacts and the budget already used are kept.`;
  }

  async status(agent: Agent): Promise<string> {
    const active = this.running.get(String(agent.session.id));
    if (active) {
      const config = await optional<RunConfig>(join(this.root, active.id, "run.json"));
      if (!config) throw new Error("active experiment configuration is missing");
      const budget = new RequestBudget(join(this.root, active.id, "budget"), { runId: config.id,
        provider: config.provider, model: config.model, maxRequests: config.maxRequests, phaseLimits: config.allocation.phaseLimits });
      const initialized = await optional(join(budget.directory, "budget.json"));
      const used = initialized ? (await budget.status()).used : 0;
      return `Experiment ${active.id} is running, ${used}/${config.maxRequests} model requests used; /rsi stop to stop it.`;
    }
    let directories: string[];
    try { directories = await readdir(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "No improvement experiments yet. /rsi run <request limit> authorizes one budgeted experiment."; throw error; }
    const records = [];
    for (const id of directories) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      const config = await optional<RunConfig>(join(this.root, id, "run.json"));
      if (!config || config.sessionId !== String(agent.session.id)) continue;
      const completed = await optional<{ promoted: boolean; stopReason?: string; budget: { used: number; limit: number };
        rounds: Array<{ candidate?: StrategyCandidate; searchAccepted: boolean }>; productivity?: ProductivityEvidence }>(join(this.root, id, "complete.json"));
      const outcome = !completed ? "incomplete; resume explicitly to continue" : completed.stopReason === "baseline-ceiling"
        ? "reached the acceptance ceiling declared for this experiment; search stopped" : completed.stopReason === "holdout-regression" ? "holdout acceptance failed; not deployed"
          : completed.stopReason === "productivity-unproven" ? "descendant comparison did not prove the improver more effective; not deployed"
            : completed.stopReason === "archive-verified" ? "frozen artifact passed the benefit audit on new tasks; old deployment eligibility not restored"
              : completed.stopReason === "diagnostic-only" ? "diagnostic simulation complete; not a formal benefit verification; not deployed"
            : completed.promoted ? "passed acceptance and was submitted for activation, only within the declared scope" : "no net improvement observed; original version kept";
      const evidence = completed?.productivity;
      const totals = (scores: TrialScore[]) => scores.reduce((sum, score) => ({ passed: sum.passed + score.passed,
        total: sum.total + score.total, requests: sum.requests + score.requests }), { passed: 0, total: 0, requests: 0 });
      const before = evidence ? totals(evidence.control) : undefined;
      const after = evidence ? totals(evidence.candidate) : undefined;
      const productivity = evidence && before && after
        ? `; ${evidence.controlChildren.length} descendant comparison group(s), acceptance checks ${before.passed}/${before.total} -> ${after.passed}/${after.total}, requests ${before.requests} -> ${after.requests}` : "";
      const incomplete = evidence?.generationFailures?.length ? `; ${evidence.generationFailures.length} descendant generations failed; comparison incomplete, no task scores imputed.` : "";
      records.push({ createdAt: config.createdAt, text: `${id}: ${outcome}${completed ? `; requests ${completed.budget.used}/${completed.budget.limit}, search candidates ${completed.rounds.filter(round => round.candidate).length}, adopted ${completed.promoted ? 1 : 0}` : ""}${productivity}${incomplete}` });
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5).map((item) => item.text).join("\n") || "No improvement experiments in the current session yet. /rsi run <request limit> authorizes one experiment.";
  }

  private launch(agent: Agent, config: RunConfig, resume: boolean): void {
    const abort = new AbortController();
    const key = String(agent.session.id);
    const done = Promise.resolve().then(() => this.execute(agent, config, abort.signal, resume)).catch(async (error: unknown) => {
      const reason = scrub(error instanceof Error ? error.message : String(error));
      try {
        await writeTrialRecord(join(this.root, config.id, `stopped-${randomUUID()}.json`), { reason, stoppedAt: new Date().toISOString() });
      } catch (recordError) {
        this.ctx.logger.warn("experiment %s stopped: %s; recording failed: %s", config.id, reason, scrub(String(recordError)));
      }
      try { this.notice(agent, `Experiment ${config.id} stopped: ${reason}`); }
      catch (noticeError) { this.ctx.logger.warn("experiment %s stopped: %s; notice failed: %s", config.id, reason, scrub(String(noticeError))); }
    }).finally(() => { this.running.delete(key); });
    this.running.set(key, { id: config.id, abort, done });
  }

  private notice(agent: Agent, text: string): void {
    agent.session.append("user/message", createUserMessage({
      source: { kind: name, form: "notice", summary: text }, content: [{ type: "text", text }],
    }), { surfaceOp: "append" });
  }

  private async execute(agent: Agent, config: RunConfig, signal: AbortSignal, resume: boolean): Promise<void> {
    const directory = join(this.root, config.id);
    if (config.runtimeDigest !== await this.loadedRuntimeDigest()) throw new Error("The sealed execution or verification runtime changed; start a new experiment");
    if (improvementDigest((await this.personalInstructions()).text) !== config.instructionsDigest) throw new Error("user instructions changed; start a new controlled experiment");
    const budget = new RequestBudget(join(directory, "budget"), { runId: config.id, provider: config.provider,
      model: config.model, maxRequests: config.maxRequests, phaseLimits: config.allocation.phaseLimits });
    if (canonicalJson(config.allocation) !== canonicalJson(allocateExperimentRequests(config.plan, config.maxRequests))) {
      throw new Error("The sealed request allocation changed");
    }
    await budget.initialize();
    if (agent.session.header.cwd !== config.workspace) throw new Error("Experiment workspace changed");
    const availableTools = await projectToolContracts(config.workspace);
    const generate = async (key: string, input: unknown, generationKey = key): Promise<string> => {
      signal.throwIfAborted();
      if (config.runtimeDigest !== await this.runtimeDigest()) throw new Error("The sealed generation runtime changed");
      const instructions = await this.personalInstructions();
      if (improvementDigest(instructions.text) !== config.instructionsDigest) throw new Error("user instructions changed during the experiment");
      const path = join(directory, `${key}.generation.json`);
      const { source: originalSource, ...details } = input as { source: string; [key: string]: unknown };
      if (typeof originalSource !== "string" || !originalSource.trim() || originalSource.length > 64_000) throw new Error("Invalid source edit input");
      const sourceDigest = improvementDigest(originalSource);
      const payload = { ...details, sourceDigest, sourceLines: originalSource.split("\n").map((text, index) => ({ line: index + 1, text })) };
      const inputDigest = improvementDigest({ format: "source-edits-v1", payload });
      const cached = await optional<{ inputDigest: string; source: string }>(path);
      if (cached) {
        if (cached.inputDigest !== inputDigest) throw new Error("generation inputs changed");
        return cached.source;
      }
      const generationBudget = new RequestBudget(budget.directory, budget.identity, { id: generationKey, limit: generationRequestLimit(config.plan) });
      await generationBudget.initialize();
      const reservation = await generationBudget.reserve(config.provider, config.model, config.sessionId);
      const assembler = new BlockAssembler();
      let outcome = "error";
      let finished = false;
      try {
        for await (const chunk of this.ctx.llm.stream({ provider: config.provider, model: config.model,
          sessionId: SessionId(`rsi-${config.id}`),
          ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}), maxTokens: 8_000, signal,
          system: `${INSTRUCTION_POLICY}\nThis is an authorized isolated capability revision. Use revise_capability once to replace the necessary source line ranges; keep unchanged scaffolding intact. All ranges refer to the supplied original lines. Preserve the assigned manifest and interfaces. This tool only proposes text changes: no file, network, shell or delegation operations are available.`,
          tools: [sourceEditSchema(originalSource)],
          messages: [createUserMessage({ source: { kind: name, form: "instructions" }, content: [{ type: "text", text: instructions.text }] }),
            createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: JSON.stringify(payload) }] })],
        })) { assembler.push(chunk); if (chunk.type === "finish") finished = true; }
        assertGenerationFinish(finished, assembler.finish);
        const calls = assembler.blocks().filter(block => block.type === "tool-call");
        if (calls.length !== 1 || calls[0]!.name !== SOURCE_EDIT_TOOL) throw new SourceProposalError("Generation did not produce exactly one source edit proposal");
        let edits: unknown;
        try { edits = JSON.parse(calls[0]!.arguments); }
        catch { throw new SourceProposalError("Source edit arguments are not valid JSON"); }
        const source = applySourceEdits(originalSource, sourceDigest, edits);
        await writeTrialRecord(path, { inputDigest, sourceDigest, edits, source });
        outcome = "completed";
        return source;
      } catch (error) {
        await writeTrialRecord(join(directory, `${key}.failure-${reservation.sequence}.json`), {
          inputDigest, finish: finished ? JSON.parse(scrub(JSON.stringify(assembler.finish))) : null,
          error: scrub(error instanceof Error ? error.message : String(error)),
        });
        throw error;
      } finally {
        await generationBudget.settle(reservation, { requestId: reservation.requestId, endedAt: new Date().toISOString(), outcome,
          ...(assembler.usage ? { usage: assembler.usage } : {}) });
      }
    };
    const loadStrategy = async (strategy: StrategyCandidate) => {
      if (strategy.reference.kind === "builtin") {
        if (canonicalJson(strategy.reference) !== canonicalJson(baselineImprover())) throw new Error("The sealed builtin strategy differs from this runtime");
        return undefined;
      }
      const staged = await this.ctx.chopinEvolution.artifacts.inspect(strategy.reference.contentDigest);
      if (`${staged.manifest.id}:${staged.manifest.version}` !== strategy.reference.id) throw new Error("Archived strategy identity changed");
      if (await readFile(join(staged.path, staged.manifest.entry), "utf8") !== strategy.source) throw new Error("Archived strategy source changed");
      return SandboxedPlugin.inspect(join(staged.path, staged.manifest.entry), staged.manifest.id, staged.manifest.version);
    };
    const planWith = async (strategy: StrategyCandidate, input: ImprovementInput) => {
      assertImprovementInput(input);
      const plugin = await loadStrategy(strategy);
      const plan = strategy.reference.kind === "builtin" ? baselineImprovementPlan(input)
        : await plugin!.executeTool(IMPROVER_TOOL, { callId: randomUUID(), arguments: JSON.parse(JSON.stringify(input)) }, signal);
      try { assertImprovementPlan(plan, input); }
      catch (error) { throw new CandidatePlanError(String(error)); }
      return plan;
    };
    const planOnce = async (key: string, strategy: StrategyCandidate, input: ImprovementInput) => {
      const path = join(directory, `${key}.planning.json`);
      const inputDigest = improvementDigest({ strategy: strategy.reference, input });
      const saved = await optional<{ inputDigest: string; planDigest: string; plan: Awaited<ReturnType<typeof planWith>> }>(path);
      if (saved) {
        if (saved.inputDigest !== inputDigest || saved.planDigest !== improvementDigest(saved.plan)) throw new Error("The sealed planning checkpoint changed");
        assertImprovementPlan(saved.plan, input); return saved.plan;
      }
      const plan = await planWith(strategy, input);
      await writeTrialRecord(path, { inputDigest, planDigest: improvementDigest(plan), plan });
      return plan;
    };
    const solve = async (strategy: StrategyCandidate, task: ProjectTask, key: string): Promise<TrialScore> => {
      if (config.runtimeDigest !== await this.runtimeDigest()) throw new Error("The sealed execution runtime changed");
      const taskBudget = new RequestBudget(budget.directory, budget.identity, { id: key, limit: config.allocation.taskLimit });
      await taskBudget.initialize();
      const previousRequests = (await taskBudget.status()).phaseUsed!;
      const plugin = await loadStrategy(strategy);
      let report;
      try { report = await runProjectSession({ host: this.ctx, directory: join(directory, key), task,
        plugin, context: config.plan.contexts[task.id]!,
        strategyDigest: strategy.reference.contentDigest, previousRequests, requestLimit: config.allocation.taskLimit, logicalWorkspace: config.workspace,
        route: { provider: config.provider, model: config.model, ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}) },
        budget: taskBudget, instructionFiles: await this.instructionFiles(), instructionsDigest: config.instructionsDigest, signal }); }
      catch (error) {
        if (!(error instanceof PluginExecutionError) || (await taskBudget.status()).phaseUsed !== previousRequests) throw error;
        return { taskId: task.id, taskDigest: improvementDigest(task), sourceDigest: improvementDigest(task.files), passed: 0,
          total: task.checks.length, requests: previousRequests, completed: false, results: task.checks.map(check => ({ id: check.id, passed: false })),
          publicFeedback: { task: task.objective, policyError: scrub(String(error)).slice(0, 1_000) } };
      }
      const replay = !report.infrastructureFailures && failureReplay(config.plan.replaySources?.[task.id] ?? task, task.files, { sourceDigest: report.sourceDigest, total: report.total,
        passed: report.results.filter(item => item.passed).length, results: report.results }, { sessionId: report.sessionId, requestId: key });
      if (replay) await this.replays.save(config.workspace, replay);
      if (config.runtimeDigest !== await this.runtimeDigest()) throw new Error("The execution runtime changed during the measured trial");
      return { taskId: task.id, taskDigest: improvementDigest(task), sourceDigest: report.sourceDigest,
        passed: report.passed, total: report.total, requests: report.requests, completed: report.publicFeedback.completion === "completed",
        ...(report.infrastructureFailures ? { infrastructureFailures: report.infrastructureFailures } : {}),
        results: report.results.map(({ id, passed }) => ({ id, passed })), publicFeedback: report.publicFeedback };
    };
    const proposeAttempt = async (parent: StrategyCandidate, feedback: readonly unknown[], key: string,
      _signal: AbortSignal, target = parent, generationKey = key): ReturnType<ExperimentHooks["propose"]> => {
        const originPath = join(directory, `${key}.origin.json`);
        const proposal = proposalOrigin({ experimentId: config.id, key, baseline: config.plan.initial, parent, target,
          workspace: config.workspace, model: modelEnvironment(config.provider, config.model), runtimeVersion: this.ctx.chopinEvolution.dshVersion });
        const original = await optional<ProposalOrigin>(originPath);
        if (original && canonicalJson(original) !== canonicalJson(proposal)) throw new Error("The experiment's parent, target or baseline changed");
        if (!original) await writeTrialRecord(originPath, proposal);
        const metaInput: ImprovementInput = { schemaVersion: 1, objective: config.plan.objective, strategy: parent.reference,
          evidence: improvementEvidence(feedback),
          environment: { objective: config.plan.objective, taskKinds: ["capability-authoring"], tools: [SOURCE_EDIT_TOOL], sourceIds: [],
            files: [proposal.manifest.entry], writable: [proposal.manifest.entry],
            budget: { limit: generationRequestLimit(config.plan), remaining: key === generationKey ? generationRequestLimit(config.plan) : 1 } },
          budget: { maxActions: 1 }, history: [], work: [{ key: "self", action: "improve-strategy", targetId: target.reference.id,
            detail: `Review ${feedback.length} source-linked search evidence entries; preserve every passed check and improve execution or the method producing later candidates.`, evidenceUnits: feedback.length }] };
        let metaPlan;
        try { metaPlan = await planOnce(key, parent, metaInput); }
        catch (error) {
          if (!(error instanceof CandidatePlanError) && !(error instanceof PluginExecutionError)) throw error;
          return { candidate: null, reason: scrub(String(error)).slice(0, 1_000) };
        }
        if (!metaPlan.actions.some(action => action.key === "self")) return { candidate: null, reason: "The improver chose not to modify this target." };
        const fixtures = executionContractFixtures(proposal.manifest);
        let source: string;
        try { source = await generate(`${key}-proposal`, { objective: config.plan.objective,
          executionContract: "Planning receives version-bound evidence and task resources. It also chooses among offered search parents using search-archive evidence; these choices determine subsequent revisions. Treat archived observations as hypotheses until reproduced on the current version. Contexts, guards and public tools receive execution.environment. A dispatch tool receives execution.steps (successful host calls) and returns {kind:'call',tool,arguments} or {kind:'done',value}; the host alone invokes declared tools, enforces their existing policies and stops on tool failure or its fixed action cap. Validation results may guide recovery; never invent a success. Unknown scope grants no permission. Remaining model requests do not revoke an admitted tool call. Keep guidance bounded and avoid duplication.",
          interfaceAdditions: { environment: (IMPROVER_INPUT_SCHEMA.properties as Record<string, unknown>).environment,
            evidence: (IMPROVER_INPUT_SCHEMA.properties as Record<string, unknown>).evidence, toolDispatch: executionInterfaceContract(), availableTools },
          planning: metaPlan, publicExecutionEvidence: feedback, assignedManifest: proposal.manifest, fixedContract: fixtures,
          source: target.reference.kind === "builtin" ? executionTemplate(proposal.manifest) : target.source }, `${generationKey}-proposal`); }
        catch (error) {
          if (!(error instanceof SourceProposalError)) throw error;
          const reason = scrub(error.message).slice(0, 1_000);
          return { candidate: null, reason, generationFailure: reason };
        }
        const workspace = join(directory, key);
        await mkdir(workspace, { recursive: true, mode: 0o700 });
        await this.sourceFile(join(workspace, "index.mjs"), source);
        await this.sourceFile(join(workspace, "capability.json"), JSON.stringify(proposal.manifest));
        await this.sourceFile(join(workspace, "capability.tests.json"), JSON.stringify(fixtures));
        const staged = await this.ctx.chopinEvolution.artifacts.stage(workspace);
        const artifactId = `${proposal.manifest.id}:${proposal.manifest.version}`;
        await this.ctx.chopinEvolution.events.transact((projection) => {
          if (projection.artifacts.some(item => item.id === artifactId)) return { events: [], value: undefined };
          const actor = { kind: "system" as const, id: name };
          const meta = { candidateId: proposal.candidateId, actor };
          return { events: [candidateObserved({ ...meta, actor: { kind: "user", id: config.request.requestId } }, {
            signalKey: `experiment:${config.id}:${key}`, lesson: config.plan.objective,
            evidence: { evidenceId: proposal.candidateId, class: "user-request", independenceKey: config.id, independentUnits: 1,
              observedAt: config.request.occurredAt, contentHash: improvementDigest(proposal), summary: "Authorized experiment origin; not a quality claim.",
              sourceSessionId: config.sessionId, sourceRef: `session:${config.sessionId}:user-message:${config.request.requestId}` },
          }), candidateCorroborated(meta, { rootCause: config.plan.objective, trigger: proposal.manifest.trigger,
            boundaries: { includes: ["declared execution surfaces"], excludes: ["host authority", "evaluators", "budgets"] } }),
          candidateClassified(meta, [{ proposalId: proposal.proposalId, kind: proposal.manifest.kind, intendedEffect: "advisory",
            summary: proposal.manifest.summary, trigger: proposal.manifest.trigger, requiredPermissions: proposal.manifest.permissions }]),
          artifactDrafted({ artifactId, actor }, { manifest: staged.manifest, contentDigest: staged.contentDigest,
            manifestDigest: staged.manifestDigest, surfaceDigest: staged.surfaceDigest })], value: undefined };
        });
        let validationError: string | undefined;
        try {
          const plugin = await SandboxedPlugin.inspect(join(workspace, "index.mjs"), proposal.manifest.id, proposal.manifest.version);
          if (canonicalJson(plugin.inspection.manifest) !== canonicalJson(proposal.manifest)) throw new Error("generated strategy changed its manifest");
          assertPublicToolOutputs(plugin);
          const execution = plugin.inspection.definitions.tools.find(tool => tool.name.startsWith("learned_execution_"));
          if (!execution?.dispatch || canonicalJson([...execution.dispatch.tools].sort()) !== canonicalJson(["read", "write", "edit", "project_check"].sort())) {
            throw new Error("generated strategy changed its bounded execution surface");
          }
          const contract = await verifyCapabilityFixtures(plugin, fixtures);
          if (!contract.passed) throw new Error(`Fixed interface checks failed: ${contract.checks.filter(check => check.status === "fail").slice(0, 3)
            .map(check => `${check.id}: ${(check.detail ?? "failed").slice(0, 220)}`).join("; ")}`);
        } catch (error) {
          if (error instanceof PluginSandboxError && !(error instanceof PluginExecutionError)) throw error;
          validationError = scrub((error as Error).message).slice(0, 1_000);
        }
        return { candidate: { reference: { kind: "artifact", id: artifactId, contentDigest: staged.contentDigest }, source,
          directory: staged.path, manifest: staged.manifest, candidateId: proposal.candidateId, proposalId: proposal.proposalId,
          ...(validationError ? { validationError } : {}) } };
      };
    const hooks: ExperimentHooks = {
      solve,
      selectParent: async (archive, current, preferred, key) => {
        const ordered = [...archive].sort((a, b) => Number(b.strategy.reference.id === preferred.reference.id)
          - Number(a.strategy.reference.id === preferred.reference.id) || a.strategy.reference.id.localeCompare(b.strategy.reference.id));
        const work = ordered.map((record, index) => ({ key: `source-${index}`, action: "select-search-parent", targetId: record.strategy.reference.id,
          detail: `Observed search source; expansions=${record.expansions ?? 0}; completed=${record.scores.filter(score => score.completed).length}/${record.scores.length}.`,
          evidenceUnits: record.scores.length }));
        const input: ImprovementInput = { schemaVersion: 1, objective: "Choose one observed search parent; this does not authorize deployment.",
          strategy: current.reference, budget: { maxActions: 1 }, work, history: [],
          evidence: improvementEvidence([{ kind: "search-archive", entries: ordered.map(record => ({ strategy: record.strategy.reference,
            parentId: record.parentId ?? null, expansions: record.expansions ?? 0,
            observations: record.scores.map(score => ({ taskDigest: score.taskDigest, passed: score.passed, total: score.total,
              completed: score.completed, requests: score.requests })) })) }]) };
        const plan = await planOnce(`${key}-selection`, current, input);
        if (plan.actions.length !== 1) throw new CandidatePlanError("Search policy must select exactly one offered source");
        return work.find(item => item.key === plan.actions[0]!.key)!.targetId;
      },
      propose: async (parent, feedback, key, signal, target = parent) => {
        const proposed = await proposeAttempt(parent, feedback, key, signal, target);
        const invalid = proposed.candidate;
        const failure = invalid?.validationError ?? proposed.generationFailure;
        if (!failure || generationRequestLimit(config.plan) === 1) return proposed;
        const phaseBudget = new RequestBudget(budget.directory, budget.identity, { id: `${key}-proposal`, limit: generationRequestLimit(config.plan) });
        if ((await phaseBudget.status()).remaining === 0) return proposed;
        if (invalid) await hooks.reject(invalid, failure);
        return proposeAttempt(parent, [...feedback, { kind: "contract-failure", strategy: (invalid ?? target).reference,
          error: failure }], `${key}-repair`, signal, invalid ?? target, key);
      },
      reject: async (candidate, reason) => {
        await this.ctx.chopinEvolution.events.transact((projection) => ({ events: [
          ...(projection.artifacts.find((item) => item.id === candidate.reference.id)?.state === "draft"
            ? [artifactRejected({ artifactId: candidate.reference.id, actor: { kind: "system", id: name } }, reason)] : []),
          ...(projection.candidates.find((item) => item.id === candidate.candidateId)?.state === "classified"
            ? [candidateRejected({ candidateId: candidate.candidateId!, actor: { kind: "system", id: name } }, reason)] : []),
        ], value: undefined }));
      },
      promote: async (candidate, baseline, currentSignal) => {
        currentSignal.throwIfAborted();
        if (config.runtimeDigest !== await this.runtimeDigest()) throw new Error("The sealed runtime changed before promotion");
        for (const context of Object.values(config.plan.contexts)) await assertTrialSources(context, this.ctx.chopinEvolution);
        if (improvementDigest((await this.personalInstructions()).text) !== config.instructionsDigest) throw new Error("user instructions changed before promotion");
        const staged = await this.ctx.chopinEvolution.artifacts.inspect(candidate.reference.contentDigest);
        if (await readFile(join(staged.path, staged.manifest.entry), "utf8") !== candidate.source) throw new Error("evaluated source changed before promotion");
        await this.ctx.chopinEvolution.events.transact((projection) => {
          const artifact = projection.artifacts.find((item) => item.id === candidate.reference.id);
          if (!artifact || artifact.contentDigest !== staged.contentDigest) throw new Error("evaluated artifact is missing");
          if (artifact.state === "draft") {
            const current = projection.artifacts.filter((item) => item.manifest.id === staged.manifest.id && item.enabled);
            const initial = baseline.reference;
            const selected = selectRoleArtifact(projection, IMPROVER_TOOL, config.facts);
            const parent = selected?.id === initial.id && selected.contentDigest === initial.contentDigest;
            if (initial.kind === "builtin" ? selected !== undefined || current.length > 0 : !parent || current.some(item => item.id !== initial.id)) {
              throw new Error("active strategy changed during the experiment");
            }
            if (projection.artifacts.some((item) => item.id !== artifact.id && item.manifest.id === staged.manifest.id
              && ["built", "verified", "approved", "installed-disabled", "canary-active"].includes(item.state))) {
              throw new Error("another strategy deployment is already pending");
            }
          } else if (!["built", "verified", "approved", "installed-disabled", "canary-active", "active"].includes(artifact.state)) {
            throw new Error("evaluated strategy was withdrawn");
          }
          return { events: artifact.state === "draft" ? [artifactBuilt({ artifactId: artifact.id, actor: { kind: "system", id: name } }, {
            contentDigest: staged.contentDigest, manifestDigest: staged.manifestDigest, surfaceDigest: staged.surfaceDigest,
            sourceRevision: `experiment:${config.id}@${staged.contentDigest}`,
          })] : [], value: undefined };
        });
        try {
          const deadline = Date.now() + 60_000;
          while (true) {
            currentSignal.throwIfAborted();
            await this.ctx.chopinEvolution.advance();
            const projection = (await this.ctx.chopinEvolution.events.snapshot()).projection;
            const artifact = projection.artifacts.find((item) => item.id === candidate.reference.id)!;
            if (artifact.state === "active" && artifact.enabled) {
              if (selectRoleArtifact(projection, IMPROVER_TOOL, config.facts)?.id !== artifact.id) throw new Error("The accepted strategy is not the effective improver for its sealed scope");
              break;
            }
            if (artifact.deploymentReceipts.some((receipt) => receipt.health === "fail") || artifact.verificationReceipts.some((receipt) => receipt.verdict !== "pass")) {
              throw new Error("independently selected strategy failed deployment verification");
            }
            if (Date.now() >= deadline) throw new Error("deployment did not finish within the experiment window");
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        } catch (error) {
          await this.ctx.chopinEvolution.events.transact((projection) => {
            const artifact = projection.artifacts.find((item) => item.id === candidate.reference.id)!;
            const meta = { artifactId: artifact.id, actor: { kind: "system" as const, id: name } };
            const reason = scrub((error as Error).message);
            return { events: ["canary-active", "active", "retired"].includes(artifact.state)
              ? [artifactQuarantined(meta, reason, [`experiment:${config.id}`])]
              : ["built", "verified", "approved", "installed-disabled"].includes(artifact.state) ? [artifactRejected(meta, reason)] : [], value: undefined };
          });
          await this.ctx.chopinEvolution.advance();
          throw error;
        }
      },
      progress: (phase) => this.notice(agent, `Improvement experiment ${config.id.slice(0, 8)}: ${phase === "baseline-saturated" ? "baseline reached the acceptance ceiling; stopping the fruitless search" : phase.startsWith("baseline") ? "running repeated controls of the search baseline" : phase.includes("proposal") ? "generating improvement strategies" : phase.startsWith("round-") ? "evaluating search candidates" : phase.includes("promotion") ? "submitting the version that passed holdout acceptance" : phase.startsWith("productivity-") ? "evaluating descendants of the old and new improvers" : "running holdout acceptance"}.`),
    };
    const result = await runExperiment(config.plan, directory, hooks, signal, resume);
    await writeTrialRecord(join(directory, "complete.json"), { ...result, budget: await budget.status(), completedAt: new Date().toISOString() });
    this.notice(agent, result.promoted ? "Execution capability and improver descendant comparison both passed; activated. The current session loads the new version at the next model step."
      : result.stopReason === "diagnostic-only" ? "Real diagnostic simulation complete; a single observation is not a formal benefit verification, no candidate promoted."
      : result.stopReason === "productivity-unproven" ? "Descendant comparison did not prove the improver more effective; no candidate deployed, original strategy unchanged."
        : "This experiment did not meet the independent quality and call-efficiency requirements; original strategy unchanged.");
  }

  private async sourceFile(path: string, source: string): Promise<void> {
    try {
      const existing = await readFile(path, "utf8");
      if (existing !== source) throw new Error("experiment source changed");
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const { open } = await import("node:fs/promises");
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(source); await file.sync(); } finally { await file.close(); }
  }
}

export function apply(ctx: Context): void { new RsiExecutor(ctx); }
