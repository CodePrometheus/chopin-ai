import { mkdir, mkdtemp, realpath, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Agents from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import Llm, { BlockAssembler, LlmAdapter, LlmError, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import Sessions, { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionEvent, TurnEndReason } from "@deepseek-ai/dsh-session";
import Projection from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import * as FileTools from "@deepseek-ai/dsh-tool-fs";
import * as FileObservation from "@deepseek-ai/dsh-fs-observation-policy";
import type { FsTarget, FsWriteIntent, FsEditRequest, FsVersion, FsObservation } from "@deepseek-ai/dsh-fs";
import * as instructions from "@chopin/evolution-runtime/instructions";
import * as integrity from "@chopin/evolution-runtime/integrity";
import type { RequestBudget } from "@chopin/evolution-runtime/request-budget";
import { scrub } from "@chopin/ledger";
import { canonicalJson, improvementDigest } from "@chopin/evolution";
import type { JsonObject } from "@chopin/evolution";
import { checkProject, snapshotWorkspace, recordProjectOutput } from "./rsi-project.js";
import type { ProjectTask } from "./rsi-project.js";
import { writeTrialRecord } from "./rsi-trial.js";
import type { SandboxedPlugin } from "@chopin/plugin-sandbox";
import { mountIsolatedCapability } from "@chopin/plugin-adapter/isolated";
import { assertTrialSources, selectTrialContext } from "./rsi-context.js";
import type { TrialContextSnapshot } from "./rsi-context.js";
import { PROJECT_CORE_TOOLS, projectEnvironment, projectEvidence } from "./rsi-input.js";
import { projectCheckTool } from "./rsi-check.js";
import { executionEvidence } from "./rsi-evidence.js";

async function registerProjectTools(scope: Context, check: ToolDefinition) {
  await scope.plugin(FileTools, {});
  await scope.plugin(FileObservation);
  scope.tools.register(check);
}

export async function projectToolContracts(workspace: string): Promise<JsonObject[]> {
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt, {}); await ctx.plugin(Tools);
    new LocalFileSystem(ctx, { cwd: workspace, diffBasisMaxBytes: 128_000 });
    await registerProjectTools(ctx, projectCheckTool(async () => ({}), []));
    return PROJECT_CORE_TOOLS.map(name => {
      const tool = ctx.tools.get(name);
      if (!tool) throw new Error(`Project tool contract is unavailable: ${name}`);
      return JSON.parse(JSON.stringify({ name, description: tool.description, inputSchema: tool.parameters, outputSchema: tool.output.schema })) as JsonObject;
    });
  } finally { await ctx.fiber.dispose(); }
}

/** File tools keep the native read/write contract; the resolved real path must belong to the task's declared file set. */
export class ProjectFileSystem extends LocalFileSystem {
  constructor(ctx: Context, readonly root: string, readonly task: ProjectTask) { super(ctx, { cwd: root, diffBasisMaxBytes: 128_000 }); }
  private async allowed(target: FsTarget, mutation = false) {
    const path = relative(await realpath(this.root), this.processPath(target)).split(sep).join("/");
    const files = mutation ? this.task.writable : [...Object.keys(this.task.files), ...this.task.writable];
    if (!files.includes(path)) throw new Error("Path is outside the task's declared file permissions");
  }
  override async resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }) {
    const target = await super.resolve(path, options); await this.allowed(target); return target;
  }
  override async writeText(target: FsTarget, content: string, intent?: FsWriteIntent, signal?: AbortSignal) {
    await this.allowed(target, true);
    if (Buffer.byteLength(content) > 128_000) throw new Error("File exceeds the task output budget");
    return super.writeText(target, content, intent, signal);
  }
  override async editText(target: FsTarget, edit: FsEditRequest, intent?: { version: FsVersion }, signal?: AbortSignal) {
    await this.allowed(target, true); return super.editText(target, edit, intent, signal);
  }
}

interface SessionOptions {
  host: Context;
  directory: string;
  task: ProjectTask;
  plugin?: SandboxedPlugin;
  context: TrialContextSnapshot;
  strategyDigest: string;
  previousRequests: number;
  requestLimit: number;
  logicalWorkspace: string;
  route: Pick<GenerateOptions, "provider" | "model" | "reasoningEffort">;
  budget: RequestBudget;
  instructionFiles: string[];
  instructionsDigest: string;
  signal: AbortSignal;
}

class TaskRequestLimit extends LlmError {
  constructor() { super("Project task exceeded its request limit", "TASK_BUDGET_EXHAUSTED"); }
}

/** Transport and host failures abort the experiment; only the task's own bounded outcomes are scored. */
export function measuredCompletion(end: TurnEndReason): boolean {
  if (end.kind === "completed") return true;
  if (end.kind === "blocked" || end.kind === "max-tokens") return false;
  if (end.kind === "error") {
    if (end.error.code === "TASK_BUDGET_EXHAUSTED") return false;
    throw new LlmError(end.error.message, end.error.code);
  }
  throw new Error(`Project trial was interrupted: ${end.kind}`);
}

class BudgetedTransport extends LlmAdapter {
  calls = 0;
  failure?: unknown;
  constructor(readonly options: SessionOptions) { super(); }
  override resolveModel(provider: string, model: string) { return this.options.host.llm.resolveModelInfo(provider, model); }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    try { yield* this.generate(request); }
    catch (error) { if (!(error instanceof TaskRequestLimit)) this.failure = error; throw error; }
  }
  private async *generate(request: GenerateOptions): AsyncIterable<StreamChunk> {
    const options = this.options;
    options.signal.throwIfAborted();
    if (options.previousRequests + this.calls >= options.requestLimit) throw new TaskRequestLimit();
    await assertTrialSources(options.context, options.host.chopinEvolution);
    if (improvementDigest((await instructions.loadPersonalInstructions({ files: options.instructionFiles })).text) !== options.instructionsDigest) {
      throw new Error("User instructions changed during the project trial");
    }
    let reservation;
    try { reservation = await options.budget.reserve(options.route.provider, options.route.model, String(request.sessionId)); }
    catch (error) { this.failure = error; throw error; }
    this.calls += 1;
    const assembler = new BlockAssembler(); let outcome = "error"; let finished = false;
    try {
      // The child session has validated its own request; the host only carries model transport and never assumes the child's identity.
      for await (const chunk of options.host.llm.stream({ ...request, ...options.route, signal: AbortSignal.any([options.signal, ...(request.signal ? [request.signal] : [])]) })) {
        assembler.push(chunk); if (chunk.type === "finish") finished = true; yield chunk;
      }
      if (!finished) throw new LlmError("Project transport ended without a finish event", "INCOMPLETE_TRIAL_STREAM");
      if (assembler.finish.kind === "stop" || assembler.finish.kind === "tool-calls") outcome = "completed";
    } catch (error) { this.failure = error; throw error; }
    finally {
      await options.budget.settle(reservation, { requestId: reservation.requestId, endedAt: new Date().toISOString(), outcome,
        ...(assembler.usage ? { usage: assembler.usage } : {}) });
    }
  }
}

type ProjectSessionResult = Awaited<ReturnType<typeof checkProject>> & {
  publicFeedback: Record<string, unknown>; sessionId: string; requests: number;
  completion: TurnEndReason;
  infrastructureFailures?: number;
  usage?: Awaited<ReturnType<RequestBudget["status"]>>["usage"];
};

interface ProjectCheckpoint {
  identity: string;
  attempt: string;
  requests: number;
  sessionId: string;
  events: readonly SessionEvent[];
  sourceDigest: string;
  infrastructureFailures: number;
  observations: Array<{ target: FsTarget; observation: FsObservation }>;
}

export async function readProjectCheckpoint(directory: string, identity: string, requests: number, task: ProjectTask): Promise<ProjectCheckpoint | undefined> {
  if (requests === 0) return undefined;
  let saved: { value: ProjectCheckpoint; valueDigest: string };
  try { saved = JSON.parse(await readFile(join(directory, `checkpoint-${requests}.json`), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("An interrupted trial has no verified checkpoint; starting over would invalidate its comparison");
    throw error;
  }
  const checkpoint = saved.value;
  if (!checkpoint || saved.valueDigest !== improvementDigest(checkpoint) || checkpoint.identity !== identity || checkpoint.requests !== requests
    || typeof checkpoint.attempt !== "string" || !checkpoint.attempt.startsWith("attempt-") || basename(checkpoint.attempt) !== checkpoint.attempt
    || checkpoint.sessionId !== `rsi-task-${checkpoint.attempt}` || !Array.isArray(checkpoint.events) || checkpoint.events.at(-1)?.type !== "turn/end"
    || !Array.isArray(checkpoint.observations)
    || !Number.isSafeInteger(checkpoint.infrastructureFailures) || checkpoint.infrastructureFailures < 1) throw new Error("Project checkpoint identity or content changed");
  const workspace = join(directory, checkpoint.attempt, "workspace");
  if (await realpath(workspace) !== join(await realpath(directory), checkpoint.attempt, "workspace")
    || improvementDigest(await snapshotWorkspace(workspace, task)) !== checkpoint.sourceDigest) throw new Error("Project checkpoint workspace changed");
  return checkpoint;
}

export async function runProjectSession(options: SessionOptions): Promise<ProjectSessionResult> {
  options.signal.throwIfAborted();
  if (!Number.isSafeInteger(options.requestLimit) || options.requestLimit < 1 || options.requestLimit > 12
    || options.budget.phase?.limit !== options.requestLimit) throw new Error("Project request cap differs from its phase allocation");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const identity = improvementDigest({ protocol: 4, task: options.task, route: options.route,
    context: options.context, strategyDigest: options.strategyDigest, instructionsDigest: options.instructionsDigest,
    logicalWorkspace: options.logicalWorkspace, requestLimit: options.requestLimit });
  const completedPath = join(options.directory, "completed.json");
  try {
    const saved = JSON.parse(await readFile(completedPath, "utf8")) as { identity: string; resultDigest: string; attempt: string; result: ProjectSessionResult };
    if (saved.identity !== identity) throw new Error("Completed project trial inputs changed");
    if (saved.resultDigest !== improvementDigest(saved.result) || saved.result.requests !== options.previousRequests
      || typeof saved.attempt !== "string" || !saved.attempt.startsWith("attempt-") || basename(saved.attempt) !== saved.attempt) {
      throw new Error("Completed project trial result or cost changed");
    }
    const output = JSON.parse(await readFile(join(options.directory, saved.attempt, "output.json"), "utf8")) as { files: Record<string, string> };
    const allowed = new Set([...Object.keys(options.task.files), ...options.task.writable]);
    if (Object.keys(output.files).some(path => !allowed.has(path)) || Object.entries(options.task.files)
      .some(([path, content]) => !options.task.writable.includes(path) && output.files[path] !== content)) throw new Error("Completed output changed immutable inputs");
    const verified = await checkProject(output.files, options.task.checks, options.signal);
    const completed = measuredCompletion(saved.result.completion);
    if (verified.sourceDigest !== saved.result.sourceDigest || canonicalJson(verified.results) !== canonicalJson(saved.result.results)
      || saved.result.publicFeedback.completion !== saved.result.completion.kind
      || saved.result.passed !== (completed ? verified.passed : 0)) throw new Error("Completed output no longer matches its verification");
    return saved.result;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const checkpoint = await readProjectCheckpoint(options.directory, identity, options.previousRequests, options.task);
  const attempt = checkpoint ? join(options.directory, checkpoint.attempt) : await mkdtemp(join(options.directory, "attempt-"));
  const workspace = join(attempt, "workspace");
  if (!checkpoint) {
    await mkdir(workspace);
    for (const [path, content] of Object.entries(options.task.files)) {
      await mkdir(dirname(join(workspace, path)), { recursive: true });
      await writeFile(join(workspace, path), content, { flag: "wx", mode: 0o600 });
    }
  }
  const ctx = new Context(); const transport = new BudgetedTransport(options);
  const observations = new Map<string, ProjectCheckpoint["observations"][number]>();
  try {
    await ctx.plugin(SystemPrompt, {}); await ctx.plugin(Sessions); await ctx.plugin(Tools); await ctx.plugin(Llm);
    await ctx.plugin(Agents); await ctx.plugin(Projection); await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    await ctx.plugin(integrity, { preset: "chopin", requiredTools: PROJECT_CORE_TOOLS });
    new ProjectFileSystem(ctx, workspace, options.task);
    ctx.llm.registerAdapter([options.route.provider], transport);
    const id = SessionId(`rsi-task-${attempt.split(sep).at(-1)}`);
    const handle = await ctx.agents.create({ sessionId: id, ...(checkpoint ? { seed: checkpoint.events } : {}), meta: { cwd: workspace, agentPreset: "project-trial" },
      agentOptions: { ...options.route, maxTokens: 8_000 }, setup: async (scope, agent) => {
        const projectRules = Object.keys(options.task.files).filter(path => ["AGENTS.md", "CLAUDE.md"].includes(path.split("/").at(-1)!)
          && options.task.writable.some(file => !path.includes("/") || file.startsWith(`${dirname(path)}/`))).map(path => join(workspace, path));
        await scope.plugin(instructions, { files: [...options.instructionFiles, ...projectRules] });
        await registerProjectTools(scope, projectCheckTool(() => snapshotWorkspace(workspace, options.task), options.task.publicChecks));
        scope.on("fs/observed", (target, observation, actor) => {
          if ((actor as { agent?: unknown } | undefined)?.agent === agent) observations.set(target.targetKey, { target, observation });
        });
        for (const saved of checkpoint?.observations ?? []) {
          const target = await scope.fs.resolve(saved.target.displayPath);
          const info = await scope.fs.stat(target);
          if (target.targetKey !== saved.target.targetKey || (saved.observation.kind === "present"
            ? info?.version !== saved.observation.version : info !== undefined)) throw new Error("Observed file version changed since the project checkpoint");
          scope.emit("fs/observed", target, saved.observation, { agent });
        }
        if (options.plugin) scope.effect(() => mountIsolatedCapability(scope, agent, options.plugin!, options.logicalWorkspace, options.task.objective,
          () => projectEnvironment(options.task, options.context, options.requestLimit, options.previousRequests + transport.calls)));
        const context = await selectTrialContext(options.context, options.plugin, options.signal);
        if (context.text) scope.systemPrompt.context({ name: "trial-experience", order: 300, text: context.text });
        if (options.context.entries.length > 0) scope.tools.register({ name: "experience_read", description: "Read a source admitted to this sealed task.",
          parameters: { type: "object", properties: { artifactId: { type: "string" } }, required: ["artifactId"], additionalProperties: false },
          output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
          async execute(args) {
            const entry = options.context.entries.find(entry => entry.id === (args as { artifactId: string }).artifactId);
            if (!entry) throw new Error("Experience is outside the sealed task scope");
            return entry.body;
          } });
        scope.systemPrompt.section({ name: "project-assignment", order: 100, text: "Complete the authorized engineering task using the declared files. Inspect and change files using their tools. When ready, call project_check with finish=true to check and submit without another model request. Failed public checks do not finish the task. Independent acceptance remains private. Project instructions and host constraints remain authoritative." });
        scope.systemPrompt.context({ name: "project-request-budget", order: 210,
          text: () => `Model requests left, including this request: ${Math.max(0, options.requestLimit - options.previousRequests - transport.calls)}/${options.requestLimit}.` });
      } });
    const ended = new Promise<TurnEndReason>(resolveEnd => {
      const release = ctx.on("session/event", (session, event) => {
        if (session.id !== id || event.type !== "turn/end") return;
        release(); resolveEnd(event.data.reason);
      });
    });
    const abort = () => handle.agent.cancel({ kind: "parent" });
    options.signal.addEventListener("abort", abort, { once: true });
    try {
      options.signal.throwIfAborted();
      handle.agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text:
        checkpoint ? "Continue the same authorized task from the retained workspace and recorded tool results. Completed operations remain applied; verify the current files before submitting. The original request allowance still applies."
          : `${options.task.objective}\n\nAvailable files: ${Object.keys(options.task.files).join(", ")}\nWritable files: ${options.task.writable.join(", ")}` }] }));
      const end = await ended; await handle.agent.whenIdle(); options.signal.throwIfAborted();
      const files = await snapshotWorkspace(workspace, options.task);
      const cost = await options.budget.status();
      const events = handle.agent.session.snapshotEvents();
      let completed: boolean;
      try {
        if (transport.failure) throw transport.failure;
        completed = measuredCompletion(end);
      } catch (error) {
        const requests = cost.phaseUsed ?? options.previousRequests + transport.calls;
        if (requests > options.previousRequests) {
          const value: ProjectCheckpoint = { identity, attempt: basename(attempt), requests, sessionId: String(id), events,
            sourceDigest: improvementDigest(files), infrastructureFailures: (checkpoint?.infrastructureFailures ?? 0) + 1,
            observations: [...observations.values()] };
          await writeTrialRecord(join(options.directory, `checkpoint-${requests}.json`), { value, valueDigest: improvementDigest(value) });
        }
        throw error;
      }
      await writeTrialRecord(join(attempt, "session.json"), events);
      const publicReport = await checkProject(files, options.task.publicChecks, options.signal);
      const report = await checkProject(files, options.task.checks, options.signal);
      await recordProjectOutput(attempt, files, report);
      const calls = new Map(events.filter(event => event.type === "tool/call").map(event => [event.data.callId, event.data.name]));
      const failures = events.flatMap(event => event.type === "tool/result" && event.data.message.isError
        ? [{ tool: calls.get(event.data.message.toolCallId) ?? "unknown",
          error: scrub(event.data.message.content.filter(item => item.type === "text").map(item => item.text).join("\n")).slice(0, 800) }] : []).slice(-8);
      const activity = { tools: events.filter(event => event.type === "tool/call" || event.type === "tool/ptc-dispatch-start").map(event => event.data.name),
        changedFiles: Object.keys(files).filter(path => files[path] !== options.task.files[path]) };
      const result: ProjectSessionResult = { ...report, passed: completed ? report.passed : 0, completion: end,
        ...(checkpoint ? { infrastructureFailures: checkpoint.infrastructureFailures } : {}),
        publicFeedback: { task: options.task.objective, ...publicReport, activity, failures, completion: end.kind,
          ...(checkpoint ? { infrastructureFailures: checkpoint.infrastructureFailures } : {}),
          terminal: scrub(JSON.stringify(end)).slice(0, 1_500),
        ...(options.task.split === "search" ? { searchOutcome: report.results, project: projectEvidence(options.task, files),
          executionEvidence: executionEvidence(options.task, options.strategyDigest, events, files) } : {}) }, sessionId: String(id),
        requests: cost.phaseUsed ?? options.previousRequests + transport.calls, usage: cost.phaseUsage ?? [] };
      await writeTrialRecord(completedPath, { identity, resultDigest: improvementDigest(result), attempt: basename(attempt), result });
      return result;
    } finally { options.signal.removeEventListener("abort", abort); await handle.dispose(); }
  } finally { await ctx.fiber.dispose(); }
}
