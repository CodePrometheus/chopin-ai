import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import z from "@deepseek-ai/schemastery";
import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import { isAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent, UserMessage } from "@deepseek-ai/dsh-session";
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";
import type {  } from "@deepseek-ai/dsh-tools";
import {
  ArtifactStore,
  EvolutionEventStore,
  IMPROVER_TOOL,
  CONTEXT_SELECTOR_TOOL,
  baselineContextSelector,
  baselineContextSelection,
  baselineImprover,
  baselineImprovementPlan,
  improvementDigest,
  improvementPlanned,
  assertImprovementInput,
  artifactExposureRecorded,
  artifactDemoted,
  artifactFeedbackRecorded,
  artifactQuarantined,
  artifactTrusted,
  candidateClassified,
  candidateCorroborated,
  candidateIdFor,
  candidateObserved,
  canonicalJson,
  evaluateFeedbackWindow,
} from "@chopin/evolution";
import { scrub } from "@chopin/ledger";
import type {
  ApprovalReceipt,
  ArtifactProjection,
  ArtifactState,
  ArtifactExposureData,
  CapabilityManifest,
  DeploymentMode,
  DeploymentReceipt,
  DeploymentRequest,
  EvolutionActor,
  EvolutionEvent,
  EvolutionProjection,
  FeedbackVerdict,
  FeedbackWindow,
  VerificationReceipt,
  ImprovementInput,
  ImprovementRecord,
  ImproverReference,
  ImprovementWork,
} from "@chopin/evolution";

import { ExperienceContext } from "./experience-context.js";
import { selectRoleArtifact } from "./deployment.js";
export { selectRoleArtifact } from "./deployment.js";
import { DeploymentLifecycle } from "./lifecycle.js";
import { ExperienceAuthoring } from "./experience-authoring.js";
import type { ArtifactHost } from "./runtime-host.js";
import {
  artifactReferenceOf,
  latestSuccessfulDeployment,
  latestFeedbackDeployment,
  selectProductionArtifacts,
  selectFeedbackArtifacts,
} from "./deployment.js";
import { defaultTriggerFacts, latestHumanPrompt } from "./facts.js";
import type { PromptIdentity } from "./facts.js";
import type { ExperienceContextResult } from "./render.js";
import { normalizeTriggerFacts } from "./selection.js";
import type { TriggerFacts } from "./selection.js";
import { completedTask, currentRequestEvents, maintenanceCallCount } from "./maintenance.js";
import type { InlineExperience } from "./inline.js";
import type { ContextSelector, PreparedExperienceContext } from "./context-selection.js";
import {
  CONTEXT_SELECTION_INPUT_SCHEMA,
  CONTEXT_SELECTION_OUTPUT_SCHEMA,
  contextSelectorFixtures,
  contextSelectorTemplate,
} from "./context-selector-template.js";
import { improvementInput, runImprover, renderImprovement } from "./improver.js";
import type { ImproverRunner, RegisteredImprover } from "./improver.js";
import { improverTemplate, improverContractFixtures } from "./improver-template.js";


declare module "@deepseek-ai/cordis" {
  interface Context {
    chopinEvolution: ChopinEvolution;
  }
}

/** Version of the installed base, i.e. the version this process actually runs. */
const INSTALLED_DSH_VERSION = (createRequire(import.meta.url)("@deepseek-ai/dsh-agent/package.json") as { version: string }).version;

export interface Config {
  eventsFile: string;
  artifactsDir: string;
  receiptsDir: string;
  chopinVersion: string;
  /** Version of the running base; defaults to the installed base version. */
  dshVersion?: string;
  processGeneration: string;
  autonomous?: boolean;
  maxMaintenanceCalls?: number;
  /** Maximum entries in the experience index; default 200. */
  maxIndexItems?: number;
  /** Total character budget of the experience index; default 25000. */
  maxIndexChars?: number;
  /** Character cap for an on-demand body read; default 16000. */
  maxBodyChars?: number;
  maxInlineChars?: number;
  maxInlineItems?: number;
  useBaselineImprover?: boolean;
}

export const Config: z<Config> = z.object({
  eventsFile: z.string().required(),
  artifactsDir: z.string().required(),
  receiptsDir: z.string().required(),
  chopinVersion: z.string().required(),
  dshVersion: z.string(),
  processGeneration: z.string().required(),
  autonomous: z.boolean().default(true),
  maxMaintenanceCalls: z.number().default(8),
  maxIndexItems: z.number(),
  maxIndexChars: z.number(),
  maxBodyChars: z.number(),
  maxInlineChars: z.number().default(2_000),
  maxInlineItems: z.number().default(200),
  useBaselineImprover: z.boolean().default(false),
});

export type EvolutionFactProvider = (agent: Agent) => Partial<TriggerFacts> | Promise<Partial<TriggerFacts>>;

export interface HostFeedbackProvenance {
  actorId: string;
  observedAt: string;
}

export interface HostFeedbackOptions {
  /** Record the window without a verdict; for session snapshots, verdicts are only drawn on cumulative windows. Default true. */
  applyVerdict?: boolean;
}

export interface UserCorrectionInput {
  /** A short name for a new experience; an update may also use the exact experience id already shown. */
  slug: string;
  /** What to do from now on, written as behavior. */
  lesson: string;
  /** When to recall it: action + surface, the line that goes into the experience index. */
  when: string;
  scope?: "global" | "workspace";
}

export interface ExperienceRecordInput extends UserCorrectionInput {
  source: "correction" | "completion";
  kind?: "memory" | "skill";
  body?: string;
}

export interface UserCorrectionResult {
  outcome: ApprovalOutcome;
  candidateId: string;
  eventId?: string;
  /** The experience artifact landed after approval and its current effective state. */
  artifactId?: string;
  artifactState?: ArtifactState;
  enabled?: boolean;
  authorization?: "user" | "policy";
}

/** What one `advance()` pass moved, listing the transitions that happened by artifact id. */
export interface AdvanceResult {
  verified: string[];
  deployed: string[];
  retired: string[];
  resolved: string[];
}

export interface ExperienceReadResult {
  artifactId: string;
  contentDigest: string;
  kind: "memory" | "skill";
  when?: string;
  summary: string;
  body: string;
}

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function canonicalTimestamp(value: string, name: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${name} must be a canonical ISO timestamp`);
  }
  return value;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive safe integer`);
  return resolved;
}

function mergeFacts(parts: readonly Partial<TriggerFacts>[]): TriggerFacts {
  return normalizeTriggerFacts({
    repos: parts.flatMap((part) => part.repos ?? []),
    taskKinds: parts.flatMap((part) => part.taskKinds ?? []),
    paths: parts.flatMap((part) => part.paths ?? []),
    tools: parts.flatMap((part) => part.tools ?? []),
    errorKeys: parts.flatMap((part) => part.errorKeys ?? []),
    languages: parts.flatMap((part) => part.languages ?? []),
    environments: parts.flatMap((part) => part.environments ?? []),
  });
}

export class ChopinEvolution extends Service {
  private readonly experienceContext: ExperienceContext;
  private readonly lifecycle: DeploymentLifecycle;
  private readonly authoring: ExperienceAuthoring;
  readonly events: EvolutionEventStore;
  readonly artifacts: ArtifactStore;
  private readonly providers = new Set<EvolutionFactProvider>();
  private readonly options: { maxIndexItems: number; maxIndexChars: number; maxBodyChars: number };
  private readonly exposureWrites = new Map<Promise<void>, string>();
  readonly chopinVersion: string;
  readonly dshVersion: string;
  readonly pluginApiVersion = "1.1.0";
  readonly processGeneration: string;
  readonly autonomous: boolean;
  readonly maxMaintenanceCalls: number;
  readonly maxInlineChars: number;
  readonly maxInlineItems: number;
  private readonly claimedPrompts = new WeakMap<Agent, PromptIdentity>();
  private readonly extraFacts = new WeakMap<Agent, { requestId: string; facts: TriggerFacts }>();
  private readonly improvers = new Map<string, RegisteredImprover>();
  private readonly contextSelectors = new Map<string, Set<ContextSelector>>();
  private readonly improvementWork = new Set<(agent: Agent) => ImprovementWork[]>();
  readonly useBaselineImprover: boolean;

  constructor(ctx: Context, config: Config) {
    super(ctx, "chopinEvolution");
    this.events = new EvolutionEventStore(config.eventsFile);
    this.artifacts = new ArtifactStore(config.artifactsDir);
    this.chopinVersion = config.chopinVersion;
    this.dshVersion = config.dshVersion ?? INSTALLED_DSH_VERSION;
    this.processGeneration = config.processGeneration;
    this.autonomous = config.autonomous ?? true;
    this.useBaselineImprover = config.useBaselineImprover ?? false;
    this.maxMaintenanceCalls = positive(config.maxMaintenanceCalls, 8, "maxMaintenanceCalls");
    this.maxInlineChars = positive(config.maxInlineChars, 2_000, "maxInlineChars");
    this.maxInlineItems = positive(config.maxInlineItems, 200, "maxInlineItems");
    this.options = {
      maxIndexItems: positive(config.maxIndexItems, 200, "maxIndexItems"),
      maxIndexChars: positive(config.maxIndexChars, 25_000, "maxIndexChars"),
      maxBodyChars: positive(config.maxBodyChars, 16_000, "maxBodyChars"),
    };
    const host: ArtifactHost = {
      events: this.events, artifacts: this.artifacts, receiptsDir: config.receiptsDir,
      chopinVersion: this.chopinVersion, dshVersion: this.dshVersion,
      processGeneration: this.processGeneration, autonomous: this.autonomous,
      requestAuditedApproval: (...args) => this.requestAuditedApproval(...args),
    };
    this.lifecycle = new DeploymentLifecycle({ ...host, warn: (message, ...values) => ctx.logger.warn(message, ...values) });
    this.authoring = new ExperienceAuthoring({ ...host, advance: () => this.advance(),
      maintenanceBudgetReached: (agent) => this.maintenanceBudgetReached(agent),
      guardedTools: () => ctx.get("chopinGates")?.guardedTools() ?? [],
    });
    this.experienceContext = new ExperienceContext({
      events: this.events, artifacts: this.artifacts, options: this.options,
      maxInlineChars: this.maxInlineChars, maxInlineItems: this.maxInlineItems,
      contextPrompt: agent => this.contextPrompt(agent),
      factsFor: (agent, prompt) => this.factsFor(agent, prompt),
      selectedContextSelector: (projection, facts) => this.selectedContextSelector(projection, facts),
      recordExposure: (...args) => this.recordExposure(...args),
    });
    ctx.on("agent/inbox/claimed", ({ agent, message }) => this.claimPrompt(agent, message));
    ctx.on("agent/status", ({ agent, status }) => {
      if (status === "idle") this.releasePrompt(agent);
    });
    ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
      const decision = await next();
      if (decision.kind === "reject") return decision;
      await this.experienceContext.prune(agent, decision.messages, signal);
      return decision;
    });
    const service = this;
    ctx.on("llm/stream", async function* (request, next) {
      const agent = isAgentLoopRequest(request) && request.sessionId ? ctx.get("agents")?.get(request.sessionId) : undefined;
      if (agent) {
        const step = agent.session.snapshotEvents().findLast(event => event.type === "step/start");
        const snapshot = service.latestRuntimeSnapshot(agent.session);
        if (snapshot?.type === "user/message" && !request.messages.some(message => message.id === snapshot.data.id)) {
          throw new Error("Current runtime context is missing from the outgoing request");
        }
        if (step) {
          await service.recordContextSelection(agent.session, step);
          await service.recordContextSnapshot(agent.session, step);
        }
      }
      yield* next();
    });
    ctx.inject(["tools"], (scope) => {
      scope.tools.guard((execution) => execution.agent !== undefined && execution.name.startsWith("evolution_")
        && this.maintenanceBudgetReached(execution.agent)
        ? "Maintenance budget exhausted for this request; finish with a summary instead of retrying." : undefined);
    });
  }

  registerFactProvider(provider: EvolutionFactProvider): () => void {
    this.providers.add(provider);
    return () => this.providers.delete(provider);
  }

  registerImprover(reference: ImproverReference, run: ImproverRunner): () => void {
    if (reference.kind !== "artifact") throw new Error("registered improver requires an artifact identity");
    const registration = { reference, run };
    this.improvers.set(reference.id, registration);
    return () => { if (this.improvers.get(reference.id) === registration) this.improvers.delete(reference.id); };
  }

  registerImprovementWork(provider: (agent: Agent) => ImprovementWork[]): () => void {
    this.improvementWork.add(provider);
    return () => this.improvementWork.delete(provider);
  }

  registerContextSelector(reference: ImproverReference, run: ContextSelector["run"]): () => void {
    if (reference.kind !== "artifact") throw new Error("context selector requires an artifact identity");
    const registration = { reference, run };
    const registrations = this.contextSelectors.get(reference.id) ?? new Set<ContextSelector>();
    registrations.add(registration);
    this.contextSelectors.set(reference.id, registrations);
    return () => {
      registrations.delete(registration);
      if (registrations.size === 0 && this.contextSelectors.get(reference.id) === registrations) this.contextSelectors.delete(reference.id);
    };
  }

  private selectedContextSelector(projection: EvolutionProjection, facts?: TriggerFacts): ContextSelector | undefined {
    const artifact = selectRoleArtifact(projection, CONTEXT_SELECTOR_TOOL, facts ?? normalizeTriggerFacts({}));
    const selected = artifact === undefined ? undefined : [...this.contextSelectors.get(artifact.id) ?? []].at(-1);
    return selected?.reference.contentDigest === artifact?.contentDigest ? selected : undefined;
  }

  private applicableImprover(projection: EvolutionProjection, agent?: Agent): ArtifactProjection | undefined {
    const facts = agent ? this.factsNowFor(agent, this.contextPrompt(agent)?.prompt ?? "") : normalizeTriggerFacts({});
    return selectRoleArtifact(projection, IMPROVER_TOOL, facts);
  }

  private selectedImprover(projection: EvolutionProjection, agent: Agent): RegisteredImprover | undefined {
    if (this.useBaselineImprover) return undefined;
    const artifact = this.applicableImprover(projection, agent);
    const registered = artifact === undefined ? undefined : this.improvers.get(artifact.id);
    return registered?.reference.contentDigest === artifact?.contentDigest ? registered : undefined;
  }

  async planImprovement(agent: Agent, includeSelf = false, signal?: AbortSignal, offered?: ImprovementWork[],
    experiment?: { prompt: PromptIdentity; strategy: RegisteredImprover; scope?: { workspace: string; model: string } }): Promise<ImprovementRecord> {
    const prompt = experiment?.prompt ?? this.contextPrompt(agent);
    if (prompt === undefined) throw new Error("improvement planning requires an owning request");
    let projection = (await this.events.snapshot()).projection;
    let selected = experiment?.strategy ?? this.selectedImprover(projection, agent);
    if (experiment) {
      const source = agent.session.snapshotEvents().find((event) => event.type === "user/message" && event.data.id === prompt.requestId);
      if (source?.type !== "user/message" || source.data.source.kind !== "user") throw new Error("experiment has no owning user request");
      if (source.data.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") !== prompt.prompt
        || new Date(source.time).toISOString() !== prompt.occurredAt) throw new Error("experiment request provenance changed");
      if (selected!.reference.kind === "artifact" && !projection.artifacts.some((artifact) =>
        artifact.id === selected!.reference.id && artifact.contentDigest === selected!.reference.contentDigest)) {
        throw new Error("experimental strategy has no archived source");
      }
    }
    let input = improvementInput(projection, prompt.prompt, selected?.reference ?? baselineImprover(), includeSelf);
    const assigned = offered ?? [...this.improvementWork].flatMap((provider) => provider(agent));
    input.work = (includeSelf ? input.work.filter((item) => item.key === "self") : assigned.length > 0 ? assigned : input.work).slice(0, 50);
    input.budget.maxActions = experiment === undefined && maintenanceCallCount(agent.session) >= this.maxMaintenanceCalls ? 0 : 1;
    assertImprovementInput(input);
    const idFor = (value: ImprovementInput) => `improve-${improvementDigest({ sessionId: String(agent.session.id), requestId: prompt.requestId, input: value }).slice(7, 47)}`;
    const existing = projection.improvements?.find((item) => item.id === idFor(input));
    if (existing !== undefined) return existing;
    let plan;
    try {
      plan = await runImprover(input, selected?.run, signal);
    } catch (error) {
      if (signal?.aborted || selected === undefined || experiment !== undefined) throw error;
      const failed = selected.reference;
      await this.events.transact((current) => {
        const artifact = current.artifacts.find((item) => item.id === failed.id && item.contentDigest === failed.contentDigest && item.enabled);
        if (artifact === undefined) return { events: [], value: undefined };
        const meta = { artifactId: artifact.id, actor: { kind: "system" as const, id: "chopin-improver" } };
        const events: EvolutionEvent[] = [artifactQuarantined(meta, `improver failed: ${scrub(String(error)).slice(0, 500)}`, [`session:${agent.session.id}:user-message:${prompt.requestId}`])];
        for (const candidate of current.candidates.filter((item) => artifact.manifest.lineage.candidateIds.includes(item.id) && item.state === "resolved")) {
          events.push(candidateClassified({ candidateId: candidate.id, actor: meta.actor }, candidate.proposals));
        }
        return { events, value: undefined };
      });
      projection = (await this.events.snapshot()).projection;
      selected = undefined;
      input = improvementInput(projection, prompt.prompt, baselineImprover(), includeSelf);
      input.work = (includeSelf ? input.work.filter((item) => item.key === "self") : assigned.length > 0 ? assigned : input.work).slice(0, 50);
      input.budget.maxActions = maintenanceCallCount(agent.session) >= this.maxMaintenanceCalls ? 0 : 1;
      plan = await runImprover(input);
    }
    const record: ImprovementRecord = {
      id: idFor(input), sessionId: String(agent.session.id), requestId: prompt.requestId,
      input, inputDigest: improvementDigest(input), plan, planDigest: improvementDigest(plan), createdAt: new Date().toISOString(),
    };
    await this.events.append(improvementPlanned(record));
    return record;
  }

  async improvementContextFor(agent: Agent): Promise<string> {
    if (!this.autonomous || this.contextPrompt(agent) === undefined) return "";
    const projection = (await this.events.snapshot()).projection;
    if (this.improvementWork.size === 0 && improvementInput(projection, "Plan eligible work.").work.length === 0) return "";
    return renderImprovement(await this.planImprovement(agent));
  }

  async readImprover(agent?: Agent, facts?: TriggerFacts): Promise<{ reference: ImproverReference; source: string }> {
    const projection = (await this.events.snapshot()).projection;
    const selected = this.useBaselineImprover ? undefined : facts ? selectRoleArtifact(projection, IMPROVER_TOOL, facts) : this.applicableImprover(projection, agent);
    if (selected === undefined) return { reference: baselineImprover(), source: baselineImprovementPlan.toString() };
    const staged = await this.artifacts.inspect(selected.contentDigest);
    const source = await readFile(join(staged.path, staged.manifest.entry), "utf8");
    if (source.length > 64_000) throw new Error("improver source exceeds the full-read budget");
    return { reference: { kind: "artifact", id: selected.id, contentDigest: selected.contentDigest }, source };
  }

  async proposeImprover(agent: Agent, callId: ToolCallId, summary: string,
    experiment?: { prompt: PromptIdentity; strategy: RegisteredImprover; scope?: { workspace: string; model: string } }) {
    return this.proposeStrategy(agent, callId, summary, "improver", experiment);
  }

  async readContextStrategy(agent?: Agent) {
    const selected = this.selectedContextSelector((await this.events.snapshot()).projection, agent ? this.factsNowFor(agent) : undefined);
    const staged = selected === undefined ? undefined : await this.artifacts.inspect(selected.reference.contentDigest);
    const source = staged === undefined ? baselineContextSelection.toString() : await readFile(join(staged.path, staged.manifest.entry), "utf8");
    if (source.length > 64_000) throw new Error("context selector source exceeds the full-read budget");
    return { reference: selected?.reference ?? baselineContextSelector(), source,
      inputSchema: CONTEXT_SELECTION_INPUT_SCHEMA, outputSchema: CONTEXT_SELECTION_OUTPUT_SCHEMA };
  }

  async proposeContextStrategy(agent: Agent, callId: ToolCallId, summary: string) {
    return this.proposeStrategy(agent, callId, summary, "context-selector");
  }

  private async proposeStrategy(agent: Agent, callId: ToolCallId, summary: string, role: "improver" | "context-selector",
    experiment?: { prompt: PromptIdentity; strategy: RegisteredImprover; scope?: { workspace: string; model: string } }) {
    if (experiment === undefined && this.maintenanceBudgetReached(agent)) throw new Error("maintenance budget exhausted");
    const prompt = experiment?.prompt ?? latestHumanPrompt(agent.session);
    if (prompt === undefined) throw new Error("improver proposal requires a direct user request");
    const lesson = scrub(summary).trim();
    if (!lesson || lesson.length > 500) throw new Error("improver summary must contain 1-500 characters");
    const isContext = role === "context-selector";
    const scopeKey = experiment?.scope ? `-${improvementDigest(experiment.scope).slice(7, 23)}` : "";
    const capabilityId = isContext ? "learned-context-selector" : `learned-improver${scopeKey}`;
    const record = isContext ? await this.planImprovement(agent, false, undefined, [{ key: "context-selector", action: "improve-context-selection",
      targetId: capabilityId, detail: lesson, evidenceUnits: 1 }]) : await this.planImprovement(agent, true, undefined, undefined, experiment);
    if (!record.plan.actions.some((action) => action.key === (isContext ? "context-selector" : "self"))) throw new Error("the current strategy selected other work; follow its recorded plan first");
    const operation = improvementDigest({ sessionId: String(agent.session.id), callId: String(callId) }).slice(7, 39);
    const key = `${role}-request:${agent.session.id}:${prompt.requestId}${experiment ? `:${operation}` : ""}`;
    const candidateId = candidateIdFor(key);
    const proposalId = `strategy-${operation}`;
    const version = `1.0.0-r${operation}`;
    const projection = (await this.events.snapshot()).projection;
    const prior = selectProductionArtifacts(projection).find((item) => item.manifest.id === capabilityId);
    const manifest: CapabilityManifest = {
      schemaVersion: 1, id: capabilityId, version, kind: "tool", runtime: "dsh-plugin", intendedEffect: "advisory",
      summary: lesson, entry: "index.mjs", trigger: { when: isContext ? "selecting eligible experience for the current request" : "planning improvements to capabilities or to the improvement strategy itself",
        ...(experiment?.scope ? { repos: [experiment.scope.workspace], environments: [experiment.scope.model] } : {}) },
      provides: { contexts: [], skills: [], guards: [], tools: [isContext ? CONTEXT_SELECTOR_TOOL : IMPROVER_TOOL], services: [], workflows: [] },
      permissions: ["tools:register"], dependencies: [], conflicts: [], requires: { chopinPluginApi: "^1.0.0", dsh: this.dshVersion },
      lineage: { candidateIds: [candidateId], proposalIds: [proposalId], improvementId: record.id,
        ...(prior === undefined ? {} : { supersedes: artifactReferenceOf(prior) }) },
    };
    await this.events.transact((current) => {
      const candidate = current.candidates.find((item) => item.id === candidateId);
      if (candidate?.proposals.some((item) => item.proposalId === proposalId)) return { events: [], value: undefined };
      const events: EvolutionEvent[] = [];
      const host = { kind: "system" as const, id: "chopin-improver" };
      if (candidate === undefined) {
        events.push(candidateObserved({ candidateId, actor: { kind: "user", id: prompt.requestId } }, {
          signalKey: key, lesson,
          evidence: { evidenceId: `request-${operation}`, class: "user-request", independenceKey: key, independentUnits: 1,
            observedAt: prompt.occurredAt, contentHash: improvementDigest(prompt.prompt), summary: "User-requested improvement proposal; not evidence of benefit.",
            sourceSessionId: String(agent.session.id), sourceRef: `session:${agent.session.id}:user-message:${prompt.requestId}` },
        }));
        events.push(candidateCorroborated({ candidateId, actor: host }, {
          rootCause: lesson, trigger: manifest.trigger,
          boundaries: { includes: [isContext ? "experience selection and placement" : "the improvement strategy"], excludes: ["host permissions", "budgets", "evaluators", "audit history", "user instructions"] },
        }));
      }
      events.push(candidateClassified({ candidateId, actor: host }, [...(candidate?.proposals ?? []), {
        proposalId, kind: manifest.kind, intendedEffect: manifest.intendedEffect, summary: lesson,
        trigger: manifest.trigger, requiredPermissions: manifest.permissions, improvementId: record.id,
      }]));
      return { events, value: undefined };
    });
    return { candidateId, proposalId, improvementId: record.id, manifest,
      template: isContext ? contextSelectorTemplate(manifest) : improverTemplate(manifest),
      fixtures: isContext ? contextSelectorFixtures() : improverContractFixtures() };
  }

  async factsFor(agent: Agent, prompt: string): Promise<TriggerFacts> {
    const extras = await Promise.all([...this.providers].map((provider) => provider(agent)));
    this.extraFacts.set(agent, { requestId: this.contextPrompt(agent)?.requestId ?? "", facts: mergeFacts(extras) });
    return this.factsNowFor(agent, prompt);
  }

  factsNowFor(agent: Agent, prompt = this.contextPrompt(agent)?.prompt ?? ""): TriggerFacts {
    const claimed = this.claimedPrompts.get(agent);
    const includeHistory = claimed === undefined || claimed.requestId === latestHumanPrompt(agent.session)?.requestId;
    const extra = this.extraFacts.get(agent);
    return mergeFacts([defaultTriggerFacts(agent, prompt, includeHistory),
      ...(extra !== undefined && extra.requestId === this.contextPrompt(agent)?.requestId ? [extra.facts] : [])]);
  }

  claimPrompt(agent: Agent, message: UserMessage): void {
    if (message.source.kind !== "user") return;
    const prompt = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    this.claimedPrompts.set(agent, { requestId: message.id, prompt, occurredAt: new Date().toISOString() });
  }

  releasePrompt(agent: Agent): void {
    this.claimedPrompts.delete(agent);
  }

  contextPrompt(agent: Agent): PromptIdentity | undefined {
    return this.claimedPrompts.get(agent) ?? latestHumanPrompt(agent.session);
  }

  async contextFor(agent: Agent): Promise<ExperienceContextResult> {
    return this.experienceContext.contextFor(agent);
  }

  async prepareExperienceContext(agent: Agent, signal?: AbortSignal): Promise<PreparedExperienceContext> {
    return this.experienceContext.prepareExperienceContext(agent, signal);
  }

  maintenanceBudgetReached(agent: Agent): boolean {
    return this.autonomous && maintenanceCallCount(agent.session) > this.maxMaintenanceCalls;
  }

  async inlineContextsFor(agent: Agent): Promise<InlineExperience[]> {
    return this.experienceContext.inlineContextsFor(agent);
  }

  private latestRuntimeSnapshot(session: Session): SessionEvent | undefined {
    return this.experienceContext.latestRuntimeSnapshot(session);
  }

  private async recordContextSelection(session: Session, step: SessionEvent): Promise<void> {
    return this.experienceContext.recordContextSelection(session, step);
  }

  async inspectContext(agent: Agent) {
    return this.experienceContext.inspectContext(agent);
  }

  clearPreparedContexts(agent: Agent, owner: "memory" | "plugin"): void {
    this.experienceContext.clearPreparedContexts(agent, owner);
  }

  prepareContext(agent: Agent, item: InlineExperience, facts: TriggerFacts, owner: "memory" | "plugin"): void {
    this.experienceContext.prepareContext(agent, item, facts, owner);
  }

  /** Record an automatic load only when the full context the host submitted contains the body text. */
  async recordContextSnapshot(session: Session, event: SessionEvent): Promise<void> {
    return this.experienceContext.recordContextSnapshot(session, event);
  }

  async maintenanceContextFor(agent: Agent): Promise<string> {
    if (!this.autonomous) return "";
    const claimed = this.claimedPrompts.get(agent);
    if (claimed !== undefined && claimed.requestId !== latestHumanPrompt(agent.session)?.requestId) return "";
    const lines: string[] = [];
    const completion = completedTask(agent.session, this.ctx.get("chopinGates")?.guardedTools() ?? []);
    const calls = currentRequestEvents(agent.session);
    const alreadyReviewed = calls.some((event) =>
      (event.type === "tool/call" || event.type === "tool/ptc-dispatch-start") && event.data.name === "evolution_experience_record");
    if (completion !== undefined && !alreadyReviewed && maintenanceCallCount(agent.session) < this.maxMaintenanceCalls) {
      lines.push(`A real gated task completed (${completion.tool}). Before finishing, save at most one reusable lesson with evolution_experience_record, or skip if nothing generalizes. Reuse an existing lesson slug; record procedures, not an incident log. Do not start extra work or delegate for this review.`);
    }
    const prompt = latestHumanPrompt(agent.session);
    if (prompt === undefined) return lines.join("\n");
    if (completion === undefined && maintenanceCallCount(agent.session) === 0) return "";
    const { events: history, projection } = await this.events.snapshot();
    const owned = new Set(history.filter((event) => event.type === "artifact.drafted"
      && event.actor?.kind === "agent" && event.actor.id === agent.id
      && event.occurredAt >= prompt.occurredAt).map((event) => event.entityId));
    const changed = projection.artifacts.filter((artifact) => owned.has(artifact.id) || artifact.approvalReceipts.some((receipt) =>
      receipt.sessionId === String(agent.session.id) && receipt.decidedAt >= prompt.occurredAt));
    if (changed.length > 0) lines.push("Actual maintenance results; summarize these once in the final reply, without requesting confirmation:",
      ...changed.slice(-8).map((artifact) => `${artifact.id}: ${artifact.state}, enabled=${artifact.enabled}`));
    return lines.join("\n");
  }

  /** The model reads an experience body. The read itself is recorded as an injected exposure -- it is the trace of "used". */
  async readExperience(agent: Agent, callId: ToolCallId, artifactId: string): Promise<ExperienceReadResult> {
    return this.experienceContext.readExperience(agent, callId, artifactId);
  }

  /**
   * Ask once through the dsh approval seam and require the paired asked / decided
   * events to appear in the session log. In a composition without an approval
   * service the outcome is unavailable, which counts as denial.
   */
  private async requestAuditedApproval(
    agent: Agent,
    callId: ToolCallId,
    toolName: string,
    reason: string,
  ): Promise<{ outcome: ApprovalOutcome; auditId?: string; decidedAt?: string }> {
    const before = agent.session.snapshotEvents().length;
    const service = this.ctx.get("approval");
    if (service === undefined) return { outcome: "unavailable" };
    const outcome = await service.request({ agent, toolName, callId, reason });
    const audit = agent.session.snapshotEvents().slice(before);
    let asked: Extract<SessionEvent, { type: "approval/asked" }> | undefined;
    for (const event of audit) {
      if (event.type === "approval/asked" && event.data.callId === callId) {
        asked = event;
        break;
      }
    }
    let decided: Extract<SessionEvent, { type: "approval/decided" }> | undefined;
    if (asked !== undefined) {
      for (const event of audit) {
        if (event.type === "approval/decided" && event.data.id === asked.data.id) {
          decided = event;
          break;
        }
      }
    }
    if (asked === undefined || decided === undefined || decided.data.outcome !== outcome) {
      throw new Error("approval seam returned without a matching durable audit pair");
    }
    if (outcome !== "allowed-once") return { outcome };
    return { outcome, auditId: String(asked.data.id), decidedAt: new Date(decided.time).toISOString() };
  }

  /** The user's words are source evidence; the experience body is the model's distillation, so the approved source is recorded separately. */
  recordUserCorrection(agent: Agent, callId: ToolCallId, input: UserCorrectionInput): Promise<UserCorrectionResult> {
    return this.recordExperience(agent, callId, { ...input, source: "correction" });
  }

  async recordExperience(agent: Agent, callId: ToolCallId, input: ExperienceRecordInput): Promise<UserCorrectionResult> {
    return this.authoring.recordExperience(agent, callId, input);
  }

  /**
   * Whatever the host can advance itself, it does: built -> verified, approved -> live
   * (data finishes in this process, code capabilities go to the target generation),
   * quarantined -> rollback, data superseded by a newer version retires, candidates with
   * every artifact live resolve. Repeats until nothing changes; steps needing a person
   * or the model are in evolutionQueue.
   */
  advance(): Promise<AdvanceResult> {
    return this.lifecycle.advance();
  }

  async verifyArtifact(artifactId: string): Promise<VerificationReceipt> {
    return this.lifecycle.verifyArtifact(artifactId);
  }

  async approveArtifact(
    agent: Agent,
    callId: ToolCallId,
    artifactId: string,
    contentDigest: string,
  ): Promise<{ outcome: ApprovalOutcome; receipt?: ApprovalReceipt }> {
    return this.lifecycle.approveArtifact(agent, callId, artifactId, contentDigest);
  }

  async requestDeployment(
    artifactId: string,
    mode: DeploymentMode,
    requestedBy: string,
    actor: EvolutionActor = { kind: "agent", id: requestedBy },
  ): Promise<{ request: DeploymentRequest; receipt?: DeploymentReceipt }> {
    return this.lifecycle.requestDeployment(artifactId, mode, requestedBy, actor);
  }

  async retryDeployment(
    agent: Agent,
    callId: ToolCallId,
    artifactId: string,
    contentDigest: string,
    failureReceiptId: string,
  ): Promise<{ outcome: ApprovalOutcome; request?: DeploymentRequest; receipt?: DeploymentReceipt }> {
    return this.lifecycle.retryDeployment(agent, callId, artifactId, contentDigest, failureReceiptId);
  }

  async pendingForCurrentGeneration(): Promise<Array<{ artifactId: string; request: DeploymentRequest }>> {
    return this.lifecycle.pendingForCurrentGeneration();
  }

  async completeDeploymentRequest(
    requestId: string,
    health: "pass" | "fail",
    loadedSurfaceDigest: string,
    detail?: string,
  ): Promise<DeploymentReceipt> {
    return this.lifecycle.completeDeploymentRequest(requestId, health, loadedSurfaceDigest, detail);
  }

  async reconcileDataGeneration(): Promise<void> {
    return this.lifecycle.reconcileDataGeneration();
  }

  async recordRuntimeLoaded(artifactId: string, mode: "canary" | "active", loadedSurfaceDigest: string): Promise<void> {
    return this.lifecycle.recordRuntimeLoaded(artifactId, mode, loadedSurfaceDigest);
  }

  async recordFeedback(
    window: FeedbackWindow,
    provenance: HostFeedbackProvenance,
    options: HostFeedbackOptions = {},
  ): Promise<FeedbackVerdict> {
    if (window.evidenceRefs.length === 0) throw new Error("host feedback requires evidenceRefs");
    if (!STABLE_ID.test(provenance.actorId)) throw new Error("feedback provenance actorId is invalid");
    const observedAt = canonicalTimestamp(provenance.observedAt, "feedback provenance observedAt");
    if (Date.parse(observedAt) < Date.parse(window.endedAt)) throw new Error("feedback was observed before its window ended");
    const verdict = evaluateFeedbackWindow(window);
    return this.events.transact((projection) => {
      const artifact = projection.artifacts.find((item) => item.id === window.artifactId);
      if (artifact === undefined) throw new Error(`unknown artifact ${window.artifactId}`);
      if (!selectFeedbackArtifacts(projection).some((item) => item.id === artifact.id)) {
        throw new Error(`artifact ${artifact.id} is not an effective deployed version`);
      }
      if (window.contentDigest !== artifact.contentDigest) throw new Error(`feedback digest differs from artifact ${artifact.id}`);
      if (window.intendedEffect !== artifact.manifest.intendedEffect) {
        throw new Error(`feedback effect ${window.intendedEffect} differs from ${artifact.manifest.intendedEffect}`);
      }
      const deployment = latestFeedbackDeployment(artifact);
      if (deployment === undefined || deployment.receiptId !== window.deploymentReceiptId) {
        throw new Error("feedback does not reference the current exact feedback deployment");
      }
      if (Date.parse(window.startedAt) < Date.parse(deployment.endedAt)) {
        throw new Error("feedback window starts before its deployment completed");
      }
      const meta = {
        artifactId: artifact.id,
        occurredAt: observedAt,
        actor: { kind: "system" as const, id: provenance.actorId },
      };
      const events: EvolutionEvent[] = [artifactFeedbackRecorded(meta, window)];
      if (options.applyVerdict !== false) {
        if (verdict === "confirm") {
          events.push(artifactTrusted(meta, window.windowId));
        } else if (verdict === "contradict") {
          events.push(artifactDemoted(meta, window.windowId, "eligible executions still failed"));
          events.push(artifactQuarantined(meta, "host feedback contradicted the capability", window.evidenceRefs));
        } else if (verdict === "quarantine") {
          events.push(artifactQuarantined(meta, "feedback observed a false block", window.evidenceRefs));
        }
        if (verdict === "contradict" || verdict === "quarantine") {
          for (const candidateId of artifact.manifest.lineage.candidateIds) {
            const candidate = projection.candidates.find((item) => item.id === candidateId);
            if (candidate?.state !== "resolved") continue;
            events.push(candidateClassified({ candidateId, occurredAt: observedAt, actor: meta.actor }, candidate.proposals));
          }
        }
      }
      return { events, value: verdict };
    });
  }

  /** The plugin SDK adapter records tool-called / gate-evaluated through this same entry. */
  recordExposure(
    artifactId: string,
    input: ArtifactExposureData,
    dedupeKey: string,
    occurredAt: string,
  ): Promise<void> {
    const write = this.recordExposureOnce(artifactId, input, dedupeKey, occurredAt);
    this.exposureWrites.set(write, input.sessionId);
    void write.then(() => this.exposureWrites.delete(write), () => this.exposureWrites.delete(write));
    return write;
  }

  /** Session outcomes read only the usage records that session has finished writing. */
  async flushExposures(sessionId: string): Promise<void> {
    await Promise.allSettled([...this.exposureWrites]
      .filter(([, owner]) => owner === sessionId)
      .map(([write]) => write));
  }

  private async recordExposureOnce(
    artifactId: string,
    input: ArtifactExposureData,
    dedupeKey: string,
    occurredAt: string,
  ): Promise<void> {
    const projection = (await this.events.snapshot()).projection;
    const artifact = projection.artifacts.find((item) => item.id === artifactId);
    if (artifact === undefined) throw new Error(`unknown artifact ${artifactId}`);
    // The lifecycle can enter quarantine / retire while an already-started call is
    // executing. That call is still a real exposure, and a rollback to the retired LKG
    // must be recordable too; admission is therefore based on it having once passed an
    // exact deployment, not on the mutable state at append time. Whether a new call may
    // enter is decided by the plugin-adapter step lease and effective production selection.
    if (
      latestSuccessfulDeployment(artifact, "active") === undefined
      && latestSuccessfulDeployment(artifact, "canary") === undefined
    ) {
      throw new Error(`artifact ${artifactId} has no successful deployment for exposure`);
    }
    const stableOccurredAt = canonicalTimestamp(occurredAt, "exposure occurredAt");
    const randomEventId = `exposure-${randomUUID().replaceAll("-", "")}`;
    const deduplicatedEventId = `exposure-${createHash("sha256").update(dedupeKey).digest("hex")}`;
    const eventId = dedupeKey.trim() === "" ? randomEventId : deduplicatedEventId;
    const previous = ((await this.events.snapshot()).events).find((event) => event.eventId === eventId);
    const event: EvolutionEvent = artifactExposureRecorded({
      artifactId,
      eventId,
      occurredAt: previous?.occurredAt ?? stableOccurredAt,
      actor: { kind: "system", id: "chopin-plugin-sdk-adapter" },
    }, input);
    if (previous !== undefined) {
      if (
        previous.entityKind !== event.entityKind
        || previous.entityId !== event.entityId
        || previous.type !== event.type
        || canonicalJson(previous.data) !== canonicalJson(event.data)
        || canonicalJson(previous.actor ?? null) !== canonicalJson(event.actor ?? null)
      ) {
        throw new Error(`exposure event ${eventId} changed content`);
      }
      return;
    }
    await this.events.append(event);
  }
}

export { artifactReferenceOf, referenceMatchesArtifact, latestSuccessfulDeployment, latestFeedbackDeployment, selectProductionArtifacts, selectFeedbackArtifacts, assertLastKnownGood, resolveLastKnownGood, hasPostCanaryBehavior } from "./deployment.js";

export default ChopinEvolution;

export {
  EXPERIENCE_INDEX_HEADER,
  EXPERIENCE_INDEX_INSTRUCTION,
  EXPERIENCE_READ_TOOL,
  buildExperienceContext,
  experienceIndexLine,
  readExperienceBody,
} from "./render.js";
export type { ExperienceContextOptions, ExperienceContextResult } from "./render.js";
export {
  CUMULATIVE_WINDOW_PREFIX,
  SESSION_WINDOW_PREFIX,
  acceptedSubmissionRef,
  cumulativeWindow,
  sessionOutcomeWindow,
} from "./outcomes.js";
export type { SessionOutcomeInput } from "./outcomes.js";
export { currentStepRequestId, defaultTriggerFacts, latestHumanPrompt } from "./facts.js";
export { currentRequestEvents } from "./maintenance.js";
export { literalContext } from "./literal-context.js";
export { EVOLUTION_QUEUE_HEADER, evolutionQueue, renderEvolutionQueue } from "./queue.js";
export type { EvolutionQueueAction, EvolutionQueueItem } from "./queue.js";
export { matchApplicabilityTrigger, normalizeTriggerFacts, selectContextArtifacts, selectEffectiveDataArtifacts, triggerFactsDigest } from "./selection.js";
export type { SelectedArtifact, TriggerFacts, TriggerMatch } from "./selection.js";
