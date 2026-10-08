import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import type { ContentBlock, ToolSchema } from "@deepseek-ai/dsh-llm";
import type { JsonSchemaNode, ToolDefinition } from "@deepseek-ai/dsh-tools";
import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";

import type { AssembleContext, PromptAssembly } from "@deepseek-ai/dsh-system-prompt";
import { CAPABILITY_FIXTURE_FILE, CONTEXT_SELECTOR_TOOL, IMPROVER_TOOL, assertCapabilityFixtureSuite, assertExecutionContext, canonicalJson } from "@chopin/evolution";
import type {
  ArtifactProjection,
  ArtifactExposureData,
  CapabilityFixtureSuite,
  DeploymentRequest,
  EvolutionProjection,
  ExecutionContext,
} from "@chopin/evolution";
import {
  artifactReferenceOf,
  assertLastKnownGood,
  currentStepRequestId,
  hasPostCanaryBehavior,
  literalContext,
  latestSuccessfulDeployment,
  matchApplicabilityTrigger,
  referenceMatchesArtifact,
  selectProductionArtifacts,
  selectContextArtifacts,
  triggerFactsDigest,
} from "@chopin/evolution-runtime";
import type { TriggerFacts, TriggerMatch } from "@chopin/evolution-runtime";
import { SandboxedPlugin, PluginExecutionError, verifyCapabilityFixtures } from "@chopin/plugin-sandbox";
import { boundedPluginContext } from "./isolated.js";
import { successfulCalls } from "./tool-history.js";
import { executeCapabilityTool } from "./dispatch.js";

type JsonValue = Parameters<ToolDefinition["output"]["render"]>[1];

export const name = "chopin-plugin-adapter";
export const inject = ["chopinEvolution", "systemPrompt", "tools"];

export interface Config {
  mode?: "production" | "controller";
  hotReload?: boolean;
  pollIntervalMs?: number;
}

export interface PendingDeployment {
  artifactId: string;
  request: DeploymentRequest;
}

export interface ControllerDeployment {
  current: ArtifactProjection;
  target: ArtifactProjection;
  request: DeploymentRequest;
}

interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

function parseVersion(value: string): SemanticVersion {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (match === null) throw new Error(`unsupported semantic version ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] === undefined ? {} : { prerelease: match[4] }),
  };
}

function compareVersions(left: SemanticVersion, right: SemanticVersion): number {
  const numeric = left.major - right.major || left.minor - right.minor || left.patch - right.patch;
  if (numeric !== 0) return numeric;
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  return left.prerelease.localeCompare(right.prerelease, undefined, { numeric: true });
}

function upperBound(base: SemanticVersion, operator: "^" | "~"): SemanticVersion {
  if (operator === "~") return { major: base.major, minor: base.minor + 1, patch: 0 };
  if (base.major > 0) return { major: base.major + 1, minor: 0, patch: 0 };
  if (base.minor > 0) return { major: 0, minor: base.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: base.patch + 1 };
}

/** Manifest requires allows a single range only; this judges fail-closed against its full grammar. */
export function satisfiesVersionRange(versionInput: string, rangeInput: string): boolean {
  const version = parseVersion(versionInput);
  const range = rangeInput.trim();
  const wildcard = /^(\d+|\*)\.(\d+|\*)\.(\d+|\*)$/.exec(range);
  if (wildcard !== null && wildcard.slice(1).some((part) => part === "*")) {
    const values = [version.major, version.minor, version.patch];
    return wildcard.slice(1).every((part, index) => part === "*" || Number(part) === values[index]);
  }
  const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(range);
  if (match === null) return false;
  const operator = match[1] ?? "=";
  const base = parseVersion(match[2] as string);
  const comparison = compareVersions(version, base);
  if (operator === "^") return comparison >= 0 && compareVersions(version, upperBound(base, "^")) < 0;
  if (operator === "~") return comparison >= 0 && compareVersions(version, upperBound(base, "~")) < 0;
  if (operator === ">=") return comparison >= 0;
  if (operator === "<=") return comparison <= 0;
  if (operator === ">") return comparison > 0;
  if (operator === "<") return comparison < 0;
  return comparison === 0;
}

function exactApproval(artifact: ArtifactProjection): boolean {
  return artifact.approvalReceipts.some((receipt) =>
    receipt.decision === "allowed-once"
    && receipt.artifactId === artifact.id
    && receipt.contentDigest === artifact.contentDigest
    && receipt.manifestDigest === artifact.manifestDigest
    && receipt.surfaceDigest === artifact.surfaceDigest);
}

export { selectProductionArtifacts } from "@chopin/evolution-runtime";

export function controllerDeployments(
  projection: EvolutionProjection,
  pending: readonly PendingDeployment[],
): ControllerDeployment[] {
  const deployments: ControllerDeployment[] = [];
  for (const item of pending) {
    if (item.request.mode === "disabled") continue;
    const current = projection.artifacts.find((artifact) => artifact.id === item.artifactId);
    if (current === undefined) throw new Error(`deployment artifact ${item.artifactId} not found`);
    const reference = item.request.mode === "rollback" ? item.request.rollbackTarget : artifactReferenceOf(current);
    if (reference === undefined) throw new Error(`rollback request ${item.request.requestId} has no target`);
    const target = projection.artifacts.find((artifact) => artifact.id === reference.artifactId);
    if (target === undefined) throw new Error(`deployment target ${reference.artifactId} not found`);
    if (item.request.mode === "rollback") assertLastKnownGood(projection, current, reference);
    else if (!referenceMatchesArtifact(reference, target) || target.id !== current.id) {
      throw new Error(`deployment target ${reference.artifactId} differs from requested artifact`);
    }
    if (!exactApproval(target)) throw new Error(`deployment target ${target.id} has no exact approval`);
    if (target.manifest.runtime === "mcp") throw new Error(`deployment target ${target.id} uses unsupported MCP runtime`);
    if (target.manifest.runtime === "dsh-plugin") deployments.push({ current, target, request: item.request });
  }
  return deployments;
}

export function assertLoadContract(
  projection: EvolutionProjection,
  artifact: ArtifactProjection,
  available: readonly ArtifactProjection[],
  versions: { pluginApi: string; dsh: string },
): void {
  if (!satisfiesVersionRange(versions.pluginApi, artifact.manifest.requires.chopinPluginApi)) {
    throw new Error(`${artifact.id} requires Chopin Plugin API ${artifact.manifest.requires.chopinPluginApi}, running ${versions.pluginApi}`);
  }
  const dshRange = artifact.manifest.requires.dsh;
  if (dshRange !== undefined && !satisfiesVersionRange(versions.dsh, dshRange)) {
    throw new Error(`${artifact.id} requires DSH ${dshRange}, running ${versions.dsh}`);
  }
  const byCapability = new Map(available.map((item) => [item.manifest.id, item]));
  for (const dependency of artifact.manifest.dependencies) {
    const installed = byCapability.get(dependency.id);
    if (installed === undefined || installed.manifest.version !== dependency.version) {
      throw new Error(`${artifact.id} requires effective ${dependency.id}@${dependency.version}`);
    }
  }
  for (const installed of available) {
    if (installed.id === artifact.id || installed.manifest.id === artifact.manifest.id) continue;
    if (artifact.manifest.conflicts.includes(installed.manifest.id) || installed.manifest.conflicts.includes(artifact.manifest.id)) {
      throw new Error(`${artifact.id} conflicts with active capability ${installed.id}`);
    }
  }
}

function permission(artifact: ArtifactProjection, value: string): void {
  if (!artifact.manifest.permissions.includes(value)) throw new Error(`${artifact.id} did not declare permission ${value}`);
}

function provided(artifact: ArtifactProjection, field: keyof ArtifactProjection["manifest"]["provides"], value: string): void {
  if (!artifact.manifest.provides[field].includes(value)) throw new Error(`${artifact.id} did not declare provides.${field} ${value}`);
}

export function assertPublicToolOutputs(plugin: SandboxedPlugin): void {
  for (const tool of plugin.inspection.definitions.tools) {
    if ([IMPROVER_TOOL, CONTEXT_SELECTOR_TOOL].includes(tool.name)) continue;
    try { assertSupportedJsonSchema(tool.outputSchema); }
    catch (error) { throw new PluginExecutionError(`${tool.name}: ${String(error)}`); }
  }
}

function assertPluginContract(artifact: ArtifactProjection, plugin: SandboxedPlugin): void {
  assertPublicToolOutputs(plugin);
  for (const definition of plugin.inspection.definitions.contexts) {
    permission(artifact, "system-prompt:context");
    provided(artifact, "contexts", definition.name);
  }
  for (const definition of plugin.inspection.definitions.guards) {
    permission(artifact, "tools:guard");
    provided(artifact, "guards", definition.name);
  }
  for (const definition of plugin.inspection.definitions.tools) {
    permission(artifact, "tools:register");
    if (definition.dispatch) permission(artifact, "tools:dispatch");
    provided(artifact, "tools", definition.name);
  }
}

export { successfulCalls } from "./tool-history.js";

interface ApplicableInvocation {
  facts: TriggerFacts;
  match: TriggerMatch;
  sessionId: string;
  requestId: string;
  occurredAt: string;
}

const executionContexts = new WeakMap<Agent, { requestId: string; value: ExecutionContext }>();

function executionEnvironment(agent: Agent | undefined, requestId: string): { environment?: ExecutionContext } {
  if (!agent) return {};
  const current = executionContexts.get(agent);
  return current?.requestId === requestId ? { environment: current.value } : {};
}

function applicableInvocation(ctx: Context, artifact: ArtifactProjection, agent: Agent | undefined): ApplicableInvocation | undefined {
  if (agent === undefined) return undefined;
  const prompt = ctx.chopinEvolution.contextPrompt(agent);
  if (prompt === undefined) return undefined;
  const facts = ctx.chopinEvolution.factsNowFor(agent, prompt.prompt);
  const match = matchApplicabilityTrigger(artifact.manifest.trigger, facts);
  if (!match.matches) return undefined;
  return {
    facts,
    match,
    sessionId: String(agent.session.id),
    requestId: currentStepRequestId(agent, prompt),
    occurredAt: new Date().toISOString(),
  };
}

function callOccurredAt(session: Session, callId: string, fallback: string): string {
  const events = session.snapshotEvents();
  const event = events.find((item) => item.type === "tool/call" && String(item.data.callId) === callId);
  return event === undefined ? fallback : new Date(event.time).toISOString();
}

function exposureData(
  artifact: ArtifactProjection,
  phase: "selected" | "injected" | "tool-called" | "gate-evaluated",
  invocation: ApplicableInvocation,
  options: { callId?: string; toolName?: string; injectedChars?: number } = {},
): ArtifactExposureData {
  return {
    phase,
    sessionId: invocation.sessionId,
    requestId: invocation.requestId,
    contentDigest: artifact.contentDigest,
    factsDigest: triggerFactsDigest(invocation.facts),
    matchedSelectors: invocation.match.matchedSelectors,
    ...(options.toolName === undefined ? {} : { toolName: options.toolName }),
    ...(options.callId === undefined ? {} : { callId: options.callId }),
    ...(options.injectedChars === undefined ? {} : { injectedChars: options.injectedChars }),
  };
}

function exposureKey(
  artifact: ArtifactProjection,
  invocation: ApplicableInvocation,
  phase: string,
  suffix: string,
): string {
  return `${artifact.id}:${invocation.sessionId}:${invocation.requestId}:${phase}:${suffix}`;
}

function recordBestEffort(
  ctx: Context,
  artifact: ArtifactProjection,
  invocation: ApplicableInvocation,
  phase: "selected" | "gate-evaluated",
  suffix: string,
  options: { callId?: string; toolName?: string; injectedChars?: number } = {},
): void {
  void ctx.chopinEvolution.recordExposure(
    artifact.id,
    exposureData(artifact, phase, invocation, options),
    exposureKey(artifact, invocation, phase, suffix),
    invocation.occurredAt,
  ).catch((error) => ctx.logger.warn("capability exposure write failed: %s", (error as Error).message));
}

function resultContent(value: JsonValue): ContentBlock[] {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}

function registerSandboxedPlugin(ctx: Context, artifact: ArtifactProjection, plugin: SandboxedPlugin): () => void {
  const disposers: Array<() => void> = [];
  let disposed = false;
  const disposeAll = () => {
    if (disposed) return;
    disposed = true;
    const errors: unknown[] = [];
    for (let index = disposers.length - 1; index >= 0; index -= 1) {
      try {
        disposers[index]?.();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `failed to dispose ${artifact.id} registrations`);
  };
  try {
    for (const definition of plugin.inspection.definitions.guards) {
      disposers.push(ctx.tools.guard((execution) => {
        if (!definition.tools.includes(execution.name)) return undefined;
        const invocation = applicableInvocation(ctx, artifact, execution.agent);
        if (invocation === undefined) return undefined;
        const environment = executionEnvironment(execution.agent, invocation.requestId);
        const callId = String(execution.callId);
        if (execution.agent !== undefined) {
          invocation.requestId = callId;
          invocation.occurredAt = callOccurredAt(execution.agent.session, callId, invocation.occurredAt);
        }
        const calls = successfulCalls(execution.agent?.session);
        recordBestEffort(ctx, artifact, invocation, "selected", `guard:${definition.name}`, { callId, toolName: execution.name });
        const decision = plugin.evaluateGuard(definition.name, {
          toolName: execution.name,
          arguments: execution.arguments as Record<string, JsonValue>,
          successfulCalls: calls,
          ...environment,
        });
        recordBestEffort(ctx, artifact, invocation, "gate-evaluated", definition.name, { callId, toolName: execution.name });
        return decision;
      }));
    }
    for (const definition of plugin.inspection.definitions.tools) {
      const tool: ToolDefinition = {
        name: definition.name,
        description: definition.description,
        parameters: definition.inputSchema as unknown as ToolDefinition["parameters"],
        output: {
          schema: definition.outputSchema as JsonSchemaNode,
          render: (_args, value) => resultContent(value),
        },
        async execute(args, execution) {
          const invocation = applicableInvocation(ctx, artifact, execution.agent);
          if (invocation === undefined || execution.agent === undefined) {
            throw new Error(`${artifact.id} is not applicable to the current task facts`);
          }
          const environment = executionEnvironment(execution.agent, invocation.requestId);
          const callId = String(execution.callId);
          invocation.requestId = callId;
          invocation.occurredAt = callOccurredAt(execution.agent.session, callId, invocation.occurredAt);
          await ctx.chopinEvolution.recordExposure(
            artifact.id,
            exposureData(artifact, "selected", invocation, { callId, toolName: definition.name }),
            exposureKey(artifact, invocation, "selected", `tool:${definition.name}`),
            invocation.occurredAt,
          );
          const value = await executeCapabilityTool(ctx, plugin, definition.name, args as Record<string, JsonValue>, execution, environment);
          await ctx.chopinEvolution.recordExposure(
            artifact.id,
            exposureData(artifact, "tool-called", invocation, { callId, toolName: definition.name }),
            exposureKey(artifact, invocation, "tool-called", definition.name),
            invocation.occurredAt,
          );
          return value;
        },
      };
      if (definition.name !== IMPROVER_TOOL && definition.name !== CONTEXT_SELECTOR_TOOL) disposers.push(ctx.tools.register(tool));
      if (definition.name === IMPROVER_TOOL) {
        disposers.push(ctx.chopinEvolution.registerImprover({ kind: "artifact", id: artifact.id, contentDigest: artifact.contentDigest },
          async (input, signal) => plugin.executeTool(IMPROVER_TOOL, {
            callId: `plan-${input.strategy.contentDigest.slice(7, 23)}`,
            arguments: JSON.parse(JSON.stringify(input)),
          }, signal)));
      }
      if (definition.name === CONTEXT_SELECTOR_TOOL) {
        disposers.push(ctx.chopinEvolution.registerContextSelector({ kind: "artifact", id: artifact.id, contentDigest: artifact.contentDigest },
          async (input, signal) => plugin.executeTool(CONTEXT_SELECTOR_TOOL, {
            callId: `select-${artifact.contentDigest.slice(7, 23)}`, arguments: JSON.parse(JSON.stringify(input)),
          }, signal)));
      }
    }
  } catch (error) {
    try {
      disposeAll();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `failed to register ${artifact.id} transactionally`);
    }
    throw error;
  }
  return disposeAll;
}

async function loadArtifact(
  ctx: Context,
  artifact: ArtifactProjection,
): Promise<{ plugin: SandboxedPlugin; stagedPath: string }> {
  const staged = await ctx.chopinEvolution.artifacts.inspect(artifact.contentDigest);
  if (staged.surfaceDigest !== artifact.surfaceDigest) throw new Error(`${artifact.id} staged surface digest changed`);
  const plugin = await SandboxedPlugin.inspect(
    join(staged.path, staged.manifest.entry),
    artifact.manifest.id,
    artifact.manifest.version,
  );
  if (canonicalJson(plugin.inspection.manifest) !== canonicalJson(artifact.manifest)) {
    throw new Error(`${artifact.id} runtime manifest differs from approved manifest`);
  }
  assertPluginContract(artifact, plugin);
  return { plugin, stagedPath: staged.path };
}

interface MountedCapability {
  artifact: ArtifactProjection;
  plugin: SandboxedPlugin;
  dispose: () => void;
}

export interface HotActivationOptions {
  watchChanges?: boolean;
  pollIntervalMs?: number;
}

function productionFingerprint(artifacts: readonly ArtifactProjection[]): string {
  return canonicalJson(artifacts.map((artifact) => ({
    id: artifact.id,
    contentDigest: artifact.contentDigest,
    manifestDigest: artifact.manifestDigest,
    surfaceDigest: artifact.surfaceDigest,
    manifest: artifact.manifest,
  })));
}

/** Maps controller-confirmed active state live into capabilities visible in the current Cordis scope. */
export class HotActivationManager {
  private readonly mounted = new Map<string, MountedCapability>();
  private readonly knownToolNames = new Set<string>();
  private readonly knownContextNames = new Set<string>();
  private readonly stepLeases = new Map<string, symbol>();
  private readonly boundaryTokens = new WeakMap<AssembleContext, symbol>();
  private readonly infrastructureDisposers: Array<() => void> = [];
  private tail: Promise<void> = Promise.resolve();
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private requested = false;
  private rescanRequested = false;
  private reconciledRevision?: string;
  private poisoned?: Error;

  constructor(
    private readonly ctx: Context,
    private readonly options: HotActivationOptions = {},
  ) {}

  get artifacts(): string[] {
    return [...this.mounted.values()].map((item) => item.artifact.id).sort();
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("hot activation manager is stopped");
    const eventsPath = this.ctx.chopinEvolution.events.path;
    const interval = this.options.pollIntervalMs ?? 1_000;
    if (this.options.watchChanges !== false && (!Number.isSafeInteger(interval) || interval < 50)) {
      throw new Error("plugin adapter pollIntervalMs must be an integer >= 50");
    }
    await mkdir(dirname(eventsPath), { recursive: true });

    // SystemPrompt collects tool schemas synchronously first, then computes contexts,
    // and only then enters the assemble waterfall. This earliest context is a zero-text
    // boundary marker: there is no await between it and schema collection, so once it
    // completes any async reconcile can only swap versions after the lease check.
    this.infrastructureDisposers.push(this.ctx.systemPrompt.context({
      name: "chopin:hot-activation-step-boundary",
      order: Number.MIN_SAFE_INTEGER,
      text: (context) => {
        if (context.agent === undefined || context.signal === undefined || this.stopped) return "";
        const sessionId = String(context.agent.session.id);
        if (this.stepLeases.has(sessionId)) return "";
        const token = Symbol(sessionId);
        this.stepLeases.set(sessionId, token);
        this.boundaryTokens.set(context, token);
        return "";
      },
    }));
    this.infrastructureDisposers.push(this.ctx.on("system-prompt/assemble", async (assembly, context, next) => {
      const agent = context.agent;
      if (agent === undefined || this.stopped) return next();
      const sessionId = String(agent.session.id);
      const token = this.boundaryTokens.get(context);
      try {
        if (token !== undefined) await this.reconcile(token);
        await this.rewriteAssembly(assembly, agent);
        return await next();
      } catch (error) {
        if (token !== undefined && this.stepLeases.get(sessionId) === token) this.stepLeases.delete(sessionId);
        throw error;
      }
    }));
    this.infrastructureDisposers.push(this.ctx.on("session/event", (session, event) => {
      if (event.type !== "step/end" && event.type !== "turn/end") return;
      if (this.stepLeases.delete(String(session.id))) this.requestReconcile();
    }));

    try {
      await this.reconcile();
      if (this.options.watchChanges === false) return;
      const directory = dirname(eventsPath);
      const filename = basename(eventsPath);
      this.watcher = watch(directory, { persistent: false }, (_event, changed) => {
        if (changed === null || String(changed) === filename) this.requestReconcile();
      });
      this.watcher.on("error", (error) => this.ctx.logger.warn("hot capability watcher failed: %s", error.message));
      this.timer = setInterval(() => this.requestReconcile(), interval);
      this.timer.unref();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  reconcile(boundaryToken?: symbol): Promise<void> {
    const run = this.tail.then(() => this.reconcileOnce(boundaryToken));
    this.tail = run.catch(() => undefined);
    return run;
  }

  async idle(): Promise<void> {
    await this.tail;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.watcher?.close();
    if (this.timer !== undefined) clearInterval(this.timer);
    this.disposeInfrastructure();
    const errors = this.disposeMounted([...this.mounted.values()]);
    this.mounted.clear();
    this.stepLeases.clear();
    if (errors.length > 0) {
      this.ctx.logger.warn("hot capability stop cleanup failed: %s", new AggregateError(errors).message);
    }
  }

  private requestReconcile(): void {
    if (this.stopped) return;
    if (this.requested) { this.rescanRequested = true; return; }
    this.requested = true;
    queueMicrotask(() => {
      if (this.stopped) return;
      void this.reconcile().catch((error) => {
        this.ctx.logger.warn("hot capability reconcile failed: %s", (error as Error).message);
      }).finally(() => {
        this.requested = false;
        if (this.rescanRequested) {
          this.rescanRequested = false;
          this.requestReconcile();
        }
      });
    });
  }

  private disposeInfrastructure(): void {
    const disposers = this.infrastructureDisposers.splice(0).reverse();
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
        this.ctx.logger.warn("hot capability infrastructure cleanup failed: %s", (error as Error).message);
      }
    }
  }

  private disposeMounted(entries: readonly MountedCapability[]): unknown[] {
    const errors: unknown[] = [];
    for (const mounted of [...entries].reverse()) {
      try {
        mounted.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private canMutate(boundaryToken?: symbol): boolean {
    if (this.stepLeases.size === 0) return true;
    if (boundaryToken === undefined) return false;
    return [...this.stepLeases.values()].every((token) => token === boundaryToken);
  }

  private validateDesired(projection: EvolutionProjection, desired: readonly ArtifactProjection[]): void {
    for (const artifact of desired) {
      if (!exactApproval(artifact)) throw new Error(`active artifact ${artifact.id} has no exact approval`);
      if (latestSuccessfulDeployment(artifact, "active") === undefined) {
        throw new Error(`active artifact ${artifact.id} has no successful active deployment`);
      }
      assertLoadContract(projection, artifact, desired, {
        pluginApi: this.ctx.chopinEvolution.pluginApiVersion,
        dsh: this.ctx.chopinEvolution.dshVersion,
      });
    }
  }

  private affectedCapabilities(desired: readonly ArtifactProjection[]): string[] {
    const desiredByCapability = new Map(desired.map((artifact) => [artifact.manifest.id, artifact]));
    const affected = new Set<string>();
    for (const [capabilityId, mounted] of this.mounted) {
      const next = desiredByCapability.get(capabilityId);
      if (next === undefined || next.id !== mounted.artifact.id || next.contentDigest !== mounted.artifact.contentDigest) {
        affected.add(capabilityId);
      }
    }
    for (const [capabilityId, artifact] of desiredByCapability) {
      const current = this.mounted.get(capabilityId);
      if (current === undefined || current.artifact.id !== artifact.id || current.artifact.contentDigest !== artifact.contentDigest) {
        affected.add(capabilityId);
      }
    }
    return [...affected].sort();
  }

  private async rewriteAssembly(assembly: PromptAssembly, agent: Agent): Promise<void> {
    const prompt = this.ctx.chopinEvolution.contextPrompt(agent);
    if (prompt !== undefined) await this.ctx.chopinEvolution.factsFor(agent, prompt.prompt);
    this.ctx.chopinEvolution.clearPreparedContexts(agent, "plugin");
    const capabilitySchemas = new Map<string, ToolSchema>();
    const contexts: Array<{ name: string; order: number; text: string }> = [];
    const mountedCapabilities = [...this.mounted.values()].sort((left, right) => left.artifact.id.localeCompare(right.artifact.id));
    for (const mounted of mountedCapabilities) {
      const invocation = applicableInvocation(this.ctx, mounted.artifact, agent);
      for (const definition of mounted.plugin.inspection.definitions.tools) {
        if (definition.name === IMPROVER_TOOL || definition.name === CONTEXT_SELECTOR_TOOL) continue;
        this.knownToolNames.add(definition.name);
        if (invocation === undefined) continue;
        const schema: ToolSchema = {
          name: definition.name,
          description: definition.description,
          parameters: definition.inputSchema,
        };
        capabilitySchemas.set(definition.name, schema);
      }
    }
    assembly.tools = [
      ...assembly.tools.filter((schema) => !this.knownToolNames.has(schema.name)),
      ...[...capabilitySchemas.values()].sort((left, right) => left.name.localeCompare(right.name)),
    ];
    executionContexts.delete(agent);
    if (prompt !== undefined && mountedCapabilities.length > 0) {
      const facts = this.ctx.chopinEvolution.factsNowFor(agent, prompt.prompt);
      const projection = (await this.ctx.chopinEvolution.events.snapshot()).projection;
      const environment: ExecutionContext = { objective: prompt.prompt.slice(0, 8_000), taskKinds: facts.taskKinds,
        tools: this.ctx.tools.schemas(agent).map(tool => tool.name)
          .filter(name => !this.knownToolNames.has(name) || capabilitySchemas.has(name)), files: facts.paths,
        sourceIds: selectContextArtifacts(projection, facts, 256).map(item => item.artifact.id) };
      assertExecutionContext(environment);
      executionContexts.set(agent, { requestId: currentStepRequestId(agent, prompt), value: environment });
    }
    for (const mounted of mountedCapabilities) {
      const invocation = applicableInvocation(this.ctx, mounted.artifact, agent);
      for (const definition of mounted.plugin.inspection.definitions.contexts) {
        const name = `chopin:${mounted.artifact.id}:${definition.name}`;
        this.knownContextNames.add(name);
        if (invocation === undefined) continue;
        if (prompt === undefined) continue;
        recordBestEffort(this.ctx, mounted.artifact, invocation, "selected", `context:${definition.name}`);
        const rendered = boundedPluginContext(mounted.plugin.renderContext(definition.name, {
          workspace: agent.session.header.cwd ?? "",
          prompt: prompt.prompt,
          ...executionEnvironment(agent, invocation.requestId),
        }));
        if (rendered !== "") {
          this.ctx.chopinEvolution.prepareContext(agent, {
            name, text: rendered, artifact: mounted.artifact,
            matchedSelectors: invocation.match.matchedSelectors, bodyChars: rendered.length,
          }, invocation.facts, "plugin");
          contexts.push({ name, order: definition.order, text: rendered });
        }
      }
    }

    assembly.contexts = [
      ...assembly.contexts.filter((context) => !this.knownContextNames.has(context.name)),
      ...contexts.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
        .map(({ name, text }) => literalContext(assembly, name, text)),
    ];
  }

  private async restorePrevious(
    previous: ReadonlyMap<string, MountedCapability>,
    attemptedFingerprint: string,
  ): Promise<unknown[]> {
    if (this.stopped) return [];
    const latest = await this.ctx.chopinEvolution.events.fold();
    const effective = selectProductionArtifacts(latest);
    const restoreAll = productionFingerprint(effective) === attemptedFingerprint;
    const effectiveByCapability = new Map(effective.map((artifact) => [artifact.manifest.id, artifact]));
    const errors: unknown[] = [];
    for (const [capabilityId, old] of previous) {
      const selected = effectiveByCapability.get(capabilityId);
      if (!restoreAll && (selected?.id !== old.artifact.id || selected.contentDigest !== old.artifact.contentDigest)) continue;
      try {
        const restored: MountedCapability = {
          artifact: old.artifact,
          plugin: old.plugin,
          dispose: registerSandboxedPlugin(this.ctx, old.artifact, old.plugin),
        };
        this.mounted.set(capabilityId, restored);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private async reconcileOnce(boundaryToken?: symbol): Promise<void> {
    if (this.stopped) return;
    if (this.poisoned !== undefined) throw this.poisoned;
    if (!this.canMutate(boundaryToken)) return;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const snapshot = await this.ctx.chopinEvolution.events.snapshot();
      if (snapshot.revision === this.reconciledRevision) return;
      const projection = snapshot.projection;
      const desired = selectProductionArtifacts(projection);
      this.validateDesired(projection, desired);
      const affected = this.affectedCapabilities(desired);
      if (affected.length === 0) {
        this.reconciledRevision = snapshot.revision;
        return;
      }
      const desiredByCapability = new Map(desired.map((artifact) => [artifact.manifest.id, artifact]));
      const fingerprint = productionFingerprint(desired);

      const prepared = new Map<string, { artifact: ArtifactProjection; plugin: SandboxedPlugin }>();
      for (const capabilityId of affected) {
        const artifact = desiredByCapability.get(capabilityId);
        if (artifact === undefined) continue;
        const loaded = await loadArtifact(this.ctx, artifact);
        prepared.set(capabilityId, { artifact, plugin: loaded.plugin });
      }
      if (this.stopped || !this.canMutate(boundaryToken)) return;

      // sandbox inspect is async. Replay the authoritative JSONL once before swapping
      // registrations; if the state entered quarantine/retire or a newer version appeared
      // meanwhile, retry on the new snapshot and never briefly mount the stale one.
      const latestProjection = await this.ctx.chopinEvolution.events.fold();
      const latestDesired = selectProductionArtifacts(latestProjection);
      this.validateDesired(latestProjection, latestDesired);
      if (productionFingerprint(latestDesired) !== fingerprint) continue;
      if (this.stopped || !this.canMutate(boundaryToken)) return;

      const previous = new Map<string, MountedCapability>();
      for (const capabilityId of affected) {
        const mounted = this.mounted.get(capabilityId);
        if (mounted !== undefined) previous.set(capabilityId, mounted);
      }
      const disposalErrors = this.disposeMounted([...previous.values()]);
      if (disposalErrors.length > 0) {
        this.poisoned = new AggregateError(disposalErrors, "hot activation could not dispose the previous exact registrations");
        throw this.poisoned;
      }
      for (const capabilityId of previous.keys()) this.mounted.delete(capabilityId);

      const installed = new Map<string, MountedCapability>();
      try {
        for (const capabilityId of affected) {
          const next = prepared.get(capabilityId);
          if (next === undefined) continue;
          const mounted: MountedCapability = {
            ...next,
            dispose: registerSandboxedPlugin(this.ctx, next.artifact, next.plugin),
          };
          this.mounted.set(capabilityId, mounted);
          installed.set(capabilityId, mounted);
          for (const definition of next.plugin.inspection.definitions.tools) this.knownToolNames.add(definition.name);
          for (const definition of next.plugin.inspection.definitions.contexts) {
            this.knownContextNames.add(`chopin:${next.artifact.id}:${definition.name}`);
          }
        }
        for (const mounted of installed.values()) {
          await this.ctx.chopinEvolution.recordRuntimeLoaded(mounted.artifact.id, "active", mounted.artifact.surfaceDigest);
        }
      } catch (error) {
        const cleanupErrors = this.disposeMounted([...installed.values()]);
        for (const capabilityId of installed.keys()) this.mounted.delete(capabilityId);
        if (this.stopped) return;
        if (cleanupErrors.length > 0) {
          this.poisoned = new AggregateError([error, ...cleanupErrors], "hot activation failed and new registrations could not be removed");
          throw this.poisoned;
        }
        const restoreErrors = await this.restorePrevious(previous, fingerprint);
        if (restoreErrors.length > 0) {
          this.poisoned = new AggregateError([error, ...restoreErrors], "hot activation failed and previous registrations could not be restored");
          throw this.poisoned;
        }
        throw error;
      }

      this.ctx.logger.info("hot capabilities active: %s", this.artifacts.join(", ") || "none");
      return;
    }
    throw new Error("evolution state kept changing during hot activation; no stale version was mounted");
  }
}

async function applyController(ctx: Context, projection: EvolutionProjection): Promise<void> {
  const pending = await ctx.chopinEvolution.pendingForCurrentGeneration();
  const deployments: ControllerDeployment[] = [];
  for (const item of pending) {
    if (item.request.mode === "disabled") continue;
    try {
      deployments.push(...controllerDeployments(projection, [item]));
    } catch (error) {
      await ctx.chopinEvolution.completeDeploymentRequest(
        item.request.requestId,
        "fail",
        item.request.rollbackTarget?.surfaceDigest ?? item.request.surfaceDigest,
        (error as Error).message,
      );
      ctx.logger.warn("deployment request %s rejected: %s", item.request.requestId, (error as Error).message);
    }
  }
  const active = selectProductionArtifacts(projection);
  const loaded = new Set<string>();
  for (const item of deployments) {
    const key = `${item.target.id}\0${item.target.contentDigest}`;
    try {
      assertLoadContract(projection, item.target, [
        ...active.filter((artifact) => artifact.manifest.id !== item.target.manifest.id),
        item.target,
      ], {
        pluginApi: ctx.chopinEvolution.pluginApiVersion,
        dsh: ctx.chopinEvolution.dshVersion,
      });
      if (item.request.mode === "active" && !(await hasPostCanaryBehavior(ctx.chopinEvolution.events, item.current))) {
        throw new Error(`${item.current.id} has no behavior evidence after its current canary deployment`);
      }
      let canaryDetail = "sandbox inspected exact capability surface";
      if (!loaded.has(key)) {
        const sandboxed = await loadArtifact(ctx, item.target);
        if (item.request.mode === "canary") {
          const raw = JSON.parse(await readFile(join(sandboxed.stagedPath, CAPABILITY_FIXTURE_FILE), "utf8")) as unknown;
          assertCapabilityFixtureSuite(raw);
          const suite = raw as CapabilityFixtureSuite;
          const report = await verifyCapabilityFixtures(sandboxed.plugin, suite);
          const verifiedFixture = item.target.verificationReceipts.findLast((receipt) => receipt.verdict === "pass")?.fixtureDigest;
          if (verifiedFixture !== report.fixtureDigest) throw new Error(`${item.target.id} canary fixture digest differs from verification`);
          if (!report.passed) {
            const failures = report.checks.filter((check) => check.status === "fail").map((check) => `${check.id}: ${check.detail ?? "failed"}`);
            throw new Error(`canary behavior failed: ${failures.join("; ")}`);
          }
          canaryDetail = `sandbox behavior fixtures passed ${report.checks.length}/${report.checks.length} at ${report.fixtureDigest}`;
        }
        loaded.add(key);
      }
      const receipt = await ctx.chopinEvolution.completeDeploymentRequest(
        item.request.requestId,
        "pass",
        item.target.surfaceDigest,
        canaryDetail,
      );
      if (item.request.mode === "canary" || item.request.mode === "active") {
        await ctx.chopinEvolution.recordRuntimeLoaded(item.target.id, item.request.mode, item.target.surfaceDigest);
      }
      ctx.logger.info("loaded capability %s for %s generation %s", item.target.id, receipt.mode, receipt.processGeneration);
    } catch (error) {
      await ctx.chopinEvolution.completeDeploymentRequest(
        item.request.requestId,
        "fail",
        item.target.surfaceDigest,
        (error as Error).message,
      );
      ctx.logger.warn("deployment capability %s failed: %s", item.current.id, (error as Error).message);
    }
  }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const mode = config.mode ?? "production";
  if (mode !== "production" && mode !== "controller") throw new Error(`unknown plugin adapter mode ${String(config.mode)}`);
  const projection = await ctx.chopinEvolution.events.fold();
  if (mode === "controller") {
    await applyController(ctx, projection);
    return;
  }
  const manager = new HotActivationManager(ctx, {
    watchChanges: config.hotReload ?? true,
    pollIntervalMs: config.pollIntervalMs,
  });
  await manager.start();
  ctx.effect(() => () => manager.stop());
}
