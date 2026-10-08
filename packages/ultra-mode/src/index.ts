/**
 * Chopin Ultra: session-scoped max reasoning plus bounded parallel subagents.
 *
 * OpenAI's Ultra mode is orchestration, not a `reasoning.effort` value. This
 * plugin keeps the wire value honest (`max`) and owns the extra behavior in the
 * host: `/mode ultra` exposes one 2-3 worker batch tool only for that live
 * Agent, waits for every DSH spawn child, and removes the capability on
 * `/mode standard` or Agent disposal.
 *
 * @module @chopin/ultra-mode
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentOptions } from "@deepseek-ai/dsh-agent";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { ContentBlock, LlmCallConfig, LlmResolvedModelInfo } from "@deepseek-ai/dsh-llm";
import type { SubagentResult, SubagentRun } from "@deepseek-ai/dsh-subagent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { UltraStateStore, type UltraStateEvent } from "./state.js";

export const name = "chopin-ultra-mode";
export const inject = ["agents", "commands", "llm", "subagents", "systemPrompt", "tools"];

export interface Config {
  stateDir: string;
  delegationTools: string[];
}

const DEFAULT_DELEGATION_TOOLS = ["subagent", "subagent_fork", "subagent_claude_code", "workflow", "ralph"];

export const Config: z<Config> = z.object({
  stateDir: z.string().default(join(homedir(), ".chopin", "ultra-mode")),
  delegationTools: z.array(z.string()).default(DEFAULT_DELEGATION_TOOLS),
});

const MAX_EFFORT = ReasoningEffortId("max");
const SPAWN_PROVIDER = "spawn";
const MIN_WORKERS = 2;
const MAX_WORKERS = 3;
const ULTRA_TOOL = "ultra_delegate";
const WORKER_TOOLS = new Set(["skill", "bash", "read", "write", "edit", "read_image", "glob", "grep", "str_replace_editor", "web_search", "web_fetch"]);

const ULTRA_SECTION = [
  "Chopin Ultra mode is active for this session.",
  "For a task with two or more independent workstreams, call ultra_delegate once with 2-3 self-contained tasks. The host runs those DSH workers in parallel and waits for all results. If the task is trivial or serial, proceed alone; never create filler work merely to use Ultra.",
  "Treat worker outputs as evidence, verify conflicts, and produce the final synthesis yourself. Direct subagent, workflow, and ralph fan-out are disabled while Ultra is active; ultra_delegate is the bounded orchestration path.",
  "The parent and its direct Ultra workers use max reasoning. Ultra consumes additional subscription quota and tokens, so keep delegated prompts focused.",
].join("\n");

const WORKER_PERSONA = [
  "You are one bounded worker in a Chopin Ultra batch.",
  "Complete only the delegated task, use first-hand evidence and available tools, and return a concise result for the parent to verify and synthesize.",
  "Do not delegate, start workflows, or broaden the task. State uncertainty and failures plainly.",
].join(" ");

interface UltraTask {
  description: string;
  prompt: string;
}

interface UltraReport {
  description: string;
  status: string;
  output: string;
  diagnostic?: string;
}

interface ModelRoute {
  provider: string;
  model: string;
}

interface UltraInstallation {
  agent: Agent;
  workerTag: string;
  workerIds: Set<string>;
  preexistingChildIds: Set<string>;
  blockedTools: string[];
  workerTools: string[];
  route: ModelRoute;
  validatedRoute: string;
  baseEffort?: ReturnType<typeof ReasoningEffortId>;
  requestEpoch: number;
  batchEpoch?: number;
  dispose: () => void;
}

interface EffortRestore {
  generation: string;
  route: ModelRoute;
  effort?: ReturnType<typeof ReasoningEffortId>;
}

declare module "@deepseek-ai/dsh-agent" {
  interface AgentOptions {
    /** Process-local marker for an exact Chopin Ultra worker generation. */
    chopinUltraWorkerTag?: string;
  }
}

export type UltraMode = "standard" | "ultra";

export function parseMode(input: string): UltraMode | "status" | undefined {
  const value = input.trim().toLowerCase();
  if (value === "") return "status";
  if (value === "standard" || value === "ultra") return value;
  return undefined;
}

export function supportsMaxReasoning(info: LlmResolvedModelInfo): boolean {
  return info.reasoning?.efforts.some((effort) => effort.id === MAX_EFFORT) === true;
}

function currentRoute(agent: Agent): ModelRoute | undefined {
  const events = agent.session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "request/header") continue;
    return { provider: event.data.header.config.provider, model: event.data.header.config.model };
  }
  const { provider, model } = agent.options;
  if (provider !== undefined && model !== undefined) return { provider, model };
  return undefined;
}

function currentEffort(agent: Agent): ReturnType<typeof ReasoningEffortId> | undefined {
  const events = agent.session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "request/header") continue;
    return event.data.header.adapterDefaults?.reasoningEffort === true
      ? undefined
      : event.data.header.config.reasoningEffort;
  }
  return undefined;
}

/** The latest tool call of the current human request is self-improvement work. */
export function isEvolutionStep(agent: Pick<Agent, "session">): boolean {
  const events = agent.session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "user/message" && event.data.source.kind === "user") return false;
    if (event?.type !== "tool/call") continue;
    return event.data.name.startsWith("evolution_") || event.data.name === "submit_evolution";
  }
  return false;
}

const EVOLUTION_STEP_GENERATION = "evolution-step";

function routeKey(route: ModelRoute): string {
  return `${route.provider}\u0000${route.model}`;
}

function restorationFrom(event: UltraStateEvent | undefined): EffortRestore | undefined {
  if (event === undefined || event.state === "restored") return undefined;
  return {
    generation: event.generation,
    route: { provider: event.provider, model: event.model },
    ...(event.effort === undefined ? {} : { effort: ReasoningEffortId(event.effort) }),
  };
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= 1_000 ? text : `${text.slice(0, 997)}...`;
}

function outputText(blocks: readonly ContentBlock[]): string {
  const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
  return text === "" && blocks.length > 0 ? "[non-text worker output]" : text;
}

async function disposeRuns(runs: readonly SubagentRun[]): Promise<unknown[]> {
  const settled = await Promise.allSettled(runs.map((run) => run.dispose()));
  return settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
}

function disposeExact(disposers: readonly (() => void)[]): unknown[] {
  const errors: unknown[] = [];
  for (let index = disposers.length - 1; index >= 0; index -= 1) {
    try {
      disposers[index]?.();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function assertMaxRoute(ctx: Context, route: ModelRoute, signal: AbortSignal): Promise<void> {
  const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal);
  if (!supportsMaxReasoning(info)) {
    throw new Error(`${route.provider}/${route.model} does not expose max reasoning; Ultra cannot run.`);
  }
}

function restoreEffort(
  config: LlmCallConfig,
  effort: ReturnType<typeof ReasoningEffortId> | undefined,
): LlmCallConfig {
  if (effort !== undefined) return { ...config, reasoningEffort: effort };
  const restored = { ...config };
  delete restored.reasoningEffort;
  return restored;
}

async function runUltraBatch(
  ctx: Context,
  installation: UltraInstallation,
  tasks: readonly UltraTask[],
  signal: AbortSignal,
): Promise<UltraReport[]> {
  const parent = installation.agent;
  if (tasks.length < MIN_WORKERS || tasks.length > MAX_WORKERS) {
    throw new Error(`ultra_delegate requires ${MIN_WORKERS}-${MAX_WORKERS} tasks, got ${tasks.length}`);
  }
  for (const [index, task] of tasks.entries()) {
    if (task.description.trim() === "" || task.prompt.trim() === "") {
      throw new Error(`ultra_delegate task ${index + 1} requires non-empty description and prompt`);
    }
  }

  const starts = await Promise.allSettled(tasks.map((task) => ctx.subagents.start(SPAWN_PROVIDER, {
    label: task.description,
    prompt: [{ type: "text", text: task.prompt }],
    parent,
    signal,
    agentOptions: {
      provider: installation.route.provider,
      model: installation.route.model,
      chopinUltraWorkerTag: installation.workerTag,
    } satisfies AgentOptions,
    maxDepth: 1,
    persona: WORKER_PERSONA,
    toolFilter: { allow: installation.workerTools },
  })));
  const runs = starts.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const startErrors = starts.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (startErrors.length > 0) {
    const cleanupErrors = await disposeRuns(runs);
    throw new AggregateError([...startErrors, ...cleanupErrors], "Ultra worker startup failed");
  }

  const results = await Promise.allSettled(runs.map((run) => run.result));
  const cleanupErrors = await disposeRuns(runs);
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Ultra worker cleanup failed");

  return results.map((settled, index) => {
    const task = tasks[index] as UltraTask;
    if (settled.status === "rejected") {
      return { description: task.description, status: "infrastructure-error", output: "", diagnostic: errorText(settled.reason) };
    }
    const result: SubagentResult = settled.value;
    return {
      description: task.description,
      status: result.stopReason,
      output: outputText(result.output),
      ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
    };
  });
}

function renderReports(reports: readonly UltraReport[]): ContentBlock[] {
  return [{
    type: "text",
    text: reports.map((report, index) => {
      const diagnostic = report.diagnostic === undefined ? "" : `\nDiagnostic: ${report.diagnostic}`;
      return `Worker ${index + 1} — ${report.description} [${report.status}]${diagnostic}\n${report.output}`;
    }).join("\n\n"),
  }];
}

function ultraTool(ctx: Context, installation: UltraInstallation, enabled: () => boolean) {
  const owner = installation.agent;
  return defineTool({
    name: ULTRA_TOOL,
    description: "Run 2-3 independent, self-contained tasks as bounded DSH subagents in parallel, wait for every worker, and return their reports for parent verification and synthesis. Use only when the work genuinely decomposes; do not create filler tasks.",
    parameters: {
      tasks: {
        type: "array",
        required: true,
        description: "Two or three independent tasks that can run concurrently.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            description: { type: "string", required: true, description: "Short 3-5 word worker label." },
            prompt: { type: "string", required: true, description: "Complete standalone worker task with scope, evidence, and expected result." },
          },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          reports: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                description: { type: "string", required: true },
                status: { type: "string", required: true },
                output: { type: "string", required: true },
                diagnostic: { type: "string" },
              },
            },
          },
        },
      },
      render: (_args, value) => renderReports(value.reports),
    },
    async execute(args, execution) {
      if (execution.agent !== owner || !enabled()) throw new Error("Ultra mode is not active for this agent");
      if (installation.batchEpoch === installation.requestEpoch) {
        throw new Error("Ultra already started one worker batch in this model step");
      }
      installation.batchEpoch = installation.requestEpoch;
      return { reports: await runUltraBatch(ctx, installation, args.tasks, execution.signal) };
    },
  });
}

function modeResult(mode: UltraMode): CommandResult {
  if (mode === "standard") return { kind: "success", text: "Chopin mode: standard. Ultra delegation is disabled." };
  return {
    kind: "success",
    text: "Chopin mode: ultra. Parent and direct workers use max reasoning; ultra_delegate runs 2-3 bounded workers in parallel. This can consume up to four model contexts and uses subscription quota faster. Ultra overrides /effort; choose another effort after /mode standard.",
  };
}

export function apply(ctx: Context, config: Config): void {
  if (config.stateDir.trim() === "") throw new Error("Ultra stateDir must be non-empty");
  if (config.delegationTools.some((tool) => tool.trim() === "")) {
    throw new Error("Ultra delegationTools must contain only non-empty names");
  }
  const active = new Map<string, UltraInstallation>();
  const passiveChecks = new Set<string>();
  const passiveTasks = new Set<Promise<void>>();
  const passiveByAgent = new Map<string, Promise<void>>();
  const pendingRestorations = new Set<string>();
  const stateStore = new UltraStateStore(config.stateDir);
  const restorationOf = async (agent: Agent) => {
    const id = String(agent.session.id);
    const restoration = restorationFrom(await stateStore.latest(id));
    if (restoration === undefined) pendingRestorations.delete(id);
    else pendingRestorations.add(id);
    return restoration;
  };
  const recordEffortState = async (
    agent: Agent,
    state: UltraStateEvent["state"],
    generationId: string,
    route: ModelRoute,
    effort: ReturnType<typeof ReasoningEffortId> | undefined,
  ): Promise<void> => {
    const sessionId = String(agent.session.id);
    await stateStore.append({
      sessionId,
      state,
      generation: generationId,
      provider: route.provider,
      model: route.model,
      ...(effort === undefined ? {} : { effort }),
    });
    if (state === "restored") passiveChecks.add(sessionId);
    else {
      passiveChecks.delete(sessionId);
      pendingRestorations.add(sessionId);
    }
  };
  const idOf = (agent: Agent) => String(agent.session.id);
  const installationOf = (agent: Agent) => {
    const installation = active.get(idOf(agent));
    return installation?.agent === agent ? installation : undefined;
  };
  const isRootUltra = (agent: Agent | undefined) => agent !== undefined && installationOf(agent) !== undefined;
  const workerInstallation = (agent: Agent) => {
    const parentId = agent.session.header.parentSession;
    if (parentId === undefined) return undefined;
    const installation = active.get(String(parentId));
    return installation?.workerTag === agent.options.chopinUltraWorkerTag ? installation : undefined;
  };
  const finishRestorationIfApplied = async (agent: Agent, restoration: EffortRestore): Promise<boolean> => {
    const baseline = agent.session.requestHeader();
    const routeMatches = baseline !== undefined && routeKey(baseline.config) === routeKey(restoration.route);
    const restored = baseline !== undefined && (
      baseline.adapterDefaults?.reasoningEffort === true
      || baseline.config.reasoningEffort !== MAX_EFFORT
      || (routeMatches && restoration.effort === MAX_EFFORT)
    );
    if (!restored) return false;
    await recordEffortState(
      agent,
      "restored",
      restoration.generation,
      { provider: baseline.config.provider, model: baseline.config.model },
      baseline.config.reasoningEffort,
    );
    return true;
  };
  const releaseInstallation = (agent: Agent) => {
    const installation = installationOf(agent);
    if (installation === undefined) return false;
    active.delete(idOf(agent));
    installation.dispose();
    return true;
  };
  const disable = async (agent: Agent) => {
    const installation = installationOf(agent);
    if (installation === undefined) return false;
    await recordEffortState(agent, "restore-pending", installation.workerTag, installation.route, installation.baseEffort);
    return releaseInstallation(agent);
  };

  const executeMode = async (invocation: CommandInvocation): Promise<CommandResult> => {
    const mode = parseMode(invocation.rawInput);
    if (mode === undefined) return { kind: "error", text: "Usage: /mode [ultra|standard]" };
    if (mode === "status") return modeResult(isRootUltra(invocation.agent) ? "ultra" : "standard");
    if (invocation.agent.status !== "idle") return { kind: "error", text: "Cannot switch Chopin mode while the agent is running." };
    try {
      return await invocation.agent.runMaintenance(async (maintenanceSignal) => {
        const signal = AbortSignal.any([invocation.signal, maintenanceSignal]);
        const passive = passiveByAgent.get(idOf(invocation.agent));
        if (passive !== undefined) await Promise.allSettled([passive]);
        if (mode === "standard") {
          await disable(invocation.agent);
          return modeResult("standard");
        }
        if (invocation.agent.session.header.parentSession !== undefined) {
          return { kind: "error", text: "Ultra mode can only be enabled on a top-level session." };
        }
        if (isRootUltra(invocation.agent)) return modeResult("ultra");
        const provider = ctx.subagents.getProvider(SPAWN_PROVIDER);
        if (provider === undefined) return { kind: "error", text: "Ultra mode requires the DSH spawn subagent provider." };
        if (!provider.capabilities.depthLimit || !provider.capabilities.persona || !provider.capabilities.toolFilter) {
          return { kind: "error", text: "The configured spawn provider cannot enforce Ultra worker boundaries." };
        }
        const route = currentRoute(invocation.agent);
        if (route === undefined) return { kind: "error", text: "Ultra mode needs a current provider/model route." };
        try {
          await assertMaxRoute(ctx, route, signal);
        } catch (error) {
          return { kind: "error", text: errorText(error) };
        }
        const owner = invocation.agent;
        const durableRestore = await restorationOf(owner);
        const baseEffort = durableRestore === undefined ? currentEffort(owner) : durableRestore.effort;
        const blockedTools = config.delegationTools.filter((tool) => ctx.tools.get(tool, owner) !== undefined);
        const blockedToolSet = new Set(blockedTools);
        const visibleTools = ctx.tools.schemas(owner).map((tool) => tool.name);
        const workerTools = visibleTools.filter((tool) => WORKER_TOOLS.has(tool) && !blockedToolSet.has(tool));
        if (workerTools.length === 0) {
          return { kind: "error", text: "Ultra mode needs at least one safe worker tool (for example bash, read, grep, or web_search)." };
        }
        const allowedTools = new Set(visibleTools);
        for (const tool of blockedTools) allowedTools.delete(tool);
        allowedTools.add(ULTRA_TOOL);
        const preexistingChildIds = new Set(ctx.agents.list().flatMap((agent) =>
          agent.session.header.parentSession === owner.session.id ? [idOf(agent)] : []));
        const disposers: Array<() => void> = [];
        const installation: UltraInstallation = {
          agent: owner,
          workerTag: `${idOf(owner)}:${randomUUID()}`,
          workerIds: new Set(),
          preexistingChildIds,
          blockedTools,
          workerTools,
          route,
          validatedRoute: routeKey(route),
          baseEffort,
          requestEpoch: 0,
          dispose: () => {
            const errors = disposeExact(disposers);
            installation.workerIds.clear();
            installation.preexistingChildIds.clear();
            if (errors.length > 0) throw new AggregateError(errors, "Ultra mode cleanup failed");
          },
        };
        try {
          if (blockedTools.length > 0) disposers.push(owner.ctx.tools.restrict({ deny: blockedTools }));
          disposers.push(owner.ctx.tools.guard((execution) => allowedTools.has(execution.name)
            ? undefined
            : `Ultra mode freezes the parent tool catalog; ${execution.name} was added after activation.`));
          disposers.push(owner.ctx.tools.register(ultraTool(ctx, installation, () => installationOf(owner) === installation)));
          active.set(idOf(owner), installation);
          await recordEffortState(owner, "active", installation.workerTag, route, baseEffort);
        } catch (error) {
          active.delete(idOf(owner));
          const cleanupErrors = disposeExact(disposers);
          if (cleanupErrors.length > 0) {
            throw new AggregateError([error, ...cleanupErrors], "Ultra mode activation failed");
          }
          throw error;
        }
        return modeResult("ultra");
      });
    } catch (error) {
      if (invocation.agent.status !== "idle" || errorText(error).includes("already has active work")) {
        return { kind: "error", text: "Cannot switch Chopin mode while the agent is running." };
      }
      throw error;
    }
  };

  ctx.commands.register({
    name: "mode",
    description: "show or switch Chopin execution mode",
    input: { hint: "[ultra|standard]" },
    handler: executeMode,
  });
  ctx.systemPrompt.section({
    name: "chopin:ultra-mode",
    order: 116,
    text: (context) => isRootUltra(context.agent) ? ULTRA_SECTION : "",
  });
  ctx.on("agent/created", ({ agent }) => {
    const installation = workerInstallation(agent);
    if (installation !== undefined) installation.workerIds.add(idOf(agent));
  });
  ctx.on("agent/pre-step", async ({ agent }, next) => {
    const parentId = agent.session.header.parentSession;
    if (parentId !== undefined) {
      const directRoot = active.get(String(parentId));
      if (
        directRoot !== undefined
        && !directRoot.preexistingChildIds.has(idOf(agent))
        && workerInstallation(agent) !== directRoot
      ) return { kind: "reject" };
      if ([...active.values()].some((installation) => installation.workerIds.has(String(parentId)))) {
        return { kind: "reject" };
      }
    }
    return next();
  });
  ctx.on("agent/request", async ({ agent, signal }, next) => {
    const config = await next();
    const root = installationOf(agent);
    if (root !== undefined) {
      const route = { provider: config.provider, model: config.model };
      const key = routeKey(route);
      const routeChanged = key !== root.validatedRoute;
      if (key !== root.validatedRoute) {
        await assertMaxRoute(ctx, route, signal);
        root.validatedRoute = key;
      }
      root.route = route;
      if (routeChanged || (config.reasoningEffort !== MAX_EFFORT && config.reasoningEffort !== root.baseEffort)) {
        root.baseEffort = routeChanged && config.reasoningEffort === MAX_EFFORT
          ? undefined
          : config.reasoningEffort;
        await recordEffortState(agent, "active", root.workerTag, route, root.baseEffort);
      }
      root.requestEpoch += 1;
      return { ...config, reasoningEffort: MAX_EFFORT };
    }
    const worker = workerInstallation(agent);
    if (worker === undefined) {
      const agentId = idOf(agent);
      // Self-modification steps run at max reasoning; the recorded state restores the base effort on the next ordinary step.
      if (config.reasoningEffort !== MAX_EFFORT && !pendingRestorations.has(agentId) && isEvolutionStep(agent)) {
        const route = { provider: config.provider, model: config.model };
        try {
          await assertMaxRoute(ctx, route, signal);
        } catch {
          return config;
        }
        await recordEffortState(agent, "active", EVOLUTION_STEP_GENERATION, route, config.reasoningEffort);
        return { ...config, reasoningEffort: MAX_EFFORT };
      }
      if (config.reasoningEffort !== MAX_EFFORT && !pendingRestorations.has(agentId)) {
        if (!passiveChecks.has(agentId)) {
          passiveChecks.add(agentId);
          let shouldRetry = false;
          const task = (async () => {
            const restoration = await restorationOf(agent);
            if (restoration !== undefined) shouldRetry = !(await finishRestorationIfApplied(agent, restoration));
          })();
          passiveTasks.add(task);
          passiveByAgent.set(agentId, task);
          void task.catch((error) => {
            ctx.logger.warn("Ultra passive restoration check failed for %s: %s", agent.id, errorText(error));
          }).finally(() => {
            passiveTasks.delete(task);
            if (passiveByAgent.get(agentId) === task) passiveByAgent.delete(agentId);
            if (shouldRetry) passiveChecks.delete(agentId);
          });
        }
        return config;
      }
      const restoration = await restorationOf(agent);
      if (restoration === undefined) return config;
      if (await finishRestorationIfApplied(agent, restoration)) return config;
      const sameRoute = routeKey(restoration.route) === routeKey(config);
      return config.reasoningEffort === MAX_EFFORT
        ? restoreEffort(config, sameRoute ? restoration.effort : undefined)
        : config;
    }
    worker.workerIds.add(idOf(agent));
    return {
      ...config,
      provider: worker.route.provider,
      model: worker.route.model,
      reasoningEffort: MAX_EFFORT,
    };
  });
  ctx.on("agent/disposed", ({ agent }) => {
    try {
      releaseInstallation(agent);
    } catch (error) {
      ctx.logger.warn("Ultra mode cleanup failed for %s: %s", agent.id, errorText(error));
    }
  });
  ctx.effect(() => async () => {
    const installations = [...active.values()];
    active.clear();
    const errors: unknown[] = [];
    passiveChecks.clear();
    passiveByAgent.clear();
    pendingRestorations.clear();
    for (const installation of installations) {
      try {
        installation.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    await Promise.allSettled([...passiveTasks]);
    passiveTasks.clear();
    if (errors.length > 0) throw new AggregateError(errors, "Ultra mode cleanup failed");
  });
}
