import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContextFormed, ToolCallId } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent, UserMessage } from "@deepseek-ai/dsh-session";
import type {  } from "@deepseek-ai/dsh-user-approval";
import type {  } from "@deepseek-ai/dsh-tools";
import { joinContextSections } from "@deepseek-ai/dsh-system-prompt";
import {
  baselineContextSelector,
  contextSelectionRecorded,
  improvementDigest,
  artifactQuarantined,
  candidateClassified,
  feedbackDeploymentReceipt,
  foldEvolutionEvents,
} from "@chopin/evolution";
import { scrub } from "@chopin/ledger";
import type {
  ArtifactExposureData,
  EvolutionEvent,
  EvolutionProjection,
  ContextSelectionRecord,
  ArtifactStore,
  EvolutionEventStore,
} from "@chopin/evolution";

import { selectProductionArtifacts } from "./deployment.js";
import { currentStepRequestId, latestHumanPrompt } from "./facts.js";
import type { PromptIdentity } from "./facts.js";
import { EXPERIENCE_READ_TOOL, EXPERIENCE_INDEX_PREFIX, buildExperienceContext, readExperienceBody } from "./render.js";
import type { ExperienceContextResult } from "./render.js";
import { matchApplicabilityTrigger, selectEffectiveDataArtifacts, selectContextArtifacts, triggerFactsDigest } from "./selection.js";
import type { TriggerFacts } from "./selection.js";
import type { InlineExperience } from "./inline.js";
import { contextCandidates, contextSelectionKey, pruneExperienceHistory, runContextSelector } from "./context-selection.js";
import { readExperienceEvents } from "./status.js";
import type { ContextSelector, PreparedExperienceContext } from "./context-selection.js";
import type { ExperienceReadResult } from "./index.js";

interface ExperienceContextHost {
  readonly events: EvolutionEventStore;
  readonly artifacts: ArtifactStore;
  readonly options: { maxIndexItems: number; maxIndexChars: number; maxBodyChars: number };
  readonly maxInlineChars: number;
  readonly maxInlineItems: number;
  contextPrompt(agent: Agent): PromptIdentity | undefined;
  factsFor(agent: Agent, prompt: string): Promise<TriggerFacts>;
  selectedContextSelector(projection: EvolutionProjection, facts?: TriggerFacts): ContextSelector | undefined;
  recordExposure(artifactId: string, input: ArtifactExposureData, dedupeKey: string, occurredAt: string): Promise<void>;
}

const CONTEXT_SOURCE = "runtime-context";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    // The runtime context snapshot is produced by the base's execution loop; its source registration is not in the public entry.
    "runtime-context": { kind: "runtime-context" } & ContextFormed;
    "chopin-context-selector": { kind: "chopin-context-selector" } & ContextFormed;
  }
}

export class ExperienceContext {
  private readonly preparedContexts = new WeakMap<Session, Map<string, {
    item: InlineExperience; factsDigest: string; requestId: string; owner: "memory" | "plugin";
  }>>();
  private readonly experienceContexts = new WeakMap<Agent, { key: string; promise: Promise<PreparedExperienceContext> }>();
  private readonly preparedSelections = new WeakMap<Session, { requestId: string; value: PreparedExperienceContext }>();

  constructor(private readonly host: ExperienceContextHost) {}

  async prune(agent: Agent, messages: UserMessage[], signal: AbortSignal): Promise<void> {
    const { projection } = await this.host.events.snapshot();
    signal.throwIfAborted();
    const prepared = this.preparedSelections.get(agent.session);
    const ownedNames = new Set(["chopin:experience", ...projection.artifacts
      .filter(item => item.manifest.runtime === "data" && (item.manifest.kind === "memory" || item.manifest.kind === "skill"))
      .map(item => `chopin:experience:${item.id}`)]);
    pruneExperienceHistory(agent.session, messages, ownedNames,
      prepared?.requestId === this.host.contextPrompt(agent)?.requestId ? prepared?.value : undefined);
  }

  async contextFor(agent: Agent): Promise<ExperienceContextResult> {
    return (await this.prepareExperienceContext(agent)).index;
  }

  async prepareExperienceContext(agent: Agent, signal?: AbortSignal): Promise<PreparedExperienceContext> {
    signal?.throwIfAborted();
    const prompt = this.host.contextPrompt(agent);
    this.preparedSelections.delete(agent.session);
    this.clearPreparedContexts(agent, "memory");
    const budget = { indexChars: this.host.options.maxIndexChars, indexItems: this.host.options.maxIndexItems,
      inlineChars: this.host.maxInlineChars, inlineItems: this.host.maxInlineItems, indexHeaderChars: EXPERIENCE_INDEX_PREFIX.length };
    if (prompt === undefined) return { index: { text: "", listed: [] }, inline: [], strategy: baselineContextSelector(), fallback: null,
      input: { schemaVersion: 1, objective: "Select relevant experience.", budget, candidates: [] }, plan: { schemaVersion: 1, items: [] } };
    const { events: history, projection } = await this.host.events.snapshot();
    const facts = await this.host.factsFor(agent, prompt.prompt);
    const candidates = await contextCandidates({ projection, artifacts: this.host.artifacts, facts, objective: prompt.prompt,
      budget, maxBodyChars: this.host.options.maxBodyChars });
    const selector = this.host.selectedContextSelector(projection, facts);
    const effective = new Set([...selectEffectiveDataArtifacts(projection), ...selectProductionArtifacts(projection)].map((item) => item.id));
    const withdrawn = [...new Set(history.filter((event) => event.type === "artifact.exposure-recorded"
      && event.data.phase === "injected" && event.data.sessionId === String(agent.session.id)
      && !effective.has(event.entityId)).map((event) => event.entityId))];
    const key = improvementDigest({ selection: contextSelectionKey(candidates.input, selector?.reference),
      requestId: prompt.requestId, step: currentStepRequestId(agent, prompt), withdrawn });
    const cached = this.experienceContexts.get(agent);
    if (cached?.key === key) {
      const value = await cached.promise;
      signal?.throwIfAborted();
      if (this.experienceContexts.get(agent)?.key !== key) throw new Error("context preparation was superseded");
      for (const item of value.inline) this.prepareContext(agent, item, facts, "memory");
      this.preparedSelections.set(agent.session, { requestId: prompt.requestId, value });
      return value;
    }
    const promise = (async (): Promise<PreparedExperienceContext> => {
      let strategy = selector?.reference ?? baselineContextSelector();
      let fallback: ContextSelectionRecord["fallback"] = null;
      let plan;
      try { plan = await runContextSelector(candidates.input, selector, signal); }
      catch (error) {
        if (!selector || signal?.aborted) throw error;
        const reason = scrub(String(error)).slice(0, 500);
        fallback = { strategy, reason };
        await this.host.events.transact((current) => {
          const artifact = current.artifacts.find((item) => item.id === strategy.id && item.contentDigest === strategy.contentDigest && item.enabled);
          if (!artifact) return { events: [], value: undefined };
          const meta = { artifactId: artifact.id, actor: { kind: "system" as const, id: "chopin-context-selector" } };
          const events: EvolutionEvent[] = [artifactQuarantined(meta, reason, [`session:${agent.session.id}:user-message:${prompt.requestId}`])];
          for (const candidate of current.candidates.filter((item) => item.state === "resolved" && artifact.manifest.lineage.candidateIds.includes(item.id))) {
            events.push(candidateClassified({ candidateId: candidate.id, actor: meta.actor }, candidate.proposals));
          }
          return { events, value: undefined };
        });
        strategy = baselineContextSelector();
        plan = await runContextSelector(candidates.input);
      }
      const live = new Map(selectContextArtifacts((await this.host.events.snapshot()).projection, facts, Number.MAX_SAFE_INTEGER)
        .map((item) => [item.artifact.id, item.artifact.contentDigest]));
      if (plan.items.some((item) => live.get(item.id) !== candidates.selected.get(item.id)!.artifact.contentDigest)) {
        throw new Error("context source changed during selection; no stale selection was applied");
      }
      const index = await buildExperienceContext({ eventStore: this.host.events, projection, facts,
        sessionId: String(agent.session.id), requestId: currentStepRequestId(agent, prompt), occurredAt: prompt.occurredAt,
        options: this.host.options, selected: plan.items.filter((item) => item.mode !== "inline").map((item) => candidates.selected.get(item.id)!) });
      if (withdrawn.length > 0) index.text += `\nPreviously loaded experiences are no longer effective: ${withdrawn.slice(-20).join(", ")}. Do not follow their earlier bodies. Only effective versions may be used; user instructions remain authoritative.`;
      const inline = plan.items.filter((item) => item.mode !== "index").map((item) => candidates.inline.get(item.id)!);
      const value = { index, inline, input: candidates.input, plan, strategy, fallback };
      signal?.throwIfAborted();
      if (this.experienceContexts.get(agent)?.key !== key) throw new Error("context preparation was superseded");
      this.clearPreparedContexts(agent, "memory");
      for (const item of inline) this.prepareContext(agent, item, facts, "memory");
      this.preparedSelections.set(agent.session, { requestId: prompt.requestId, value });
      return value;
    })();
    this.experienceContexts.set(agent, { key, promise });
    try { return await promise; }
    catch (error) { if (this.experienceContexts.get(agent)?.promise === promise) this.experienceContexts.delete(agent); throw error; }
  }

  async inlineContextsFor(agent: Agent): Promise<InlineExperience[]> {
    return (await this.prepareExperienceContext(agent)).inline;
  }

  latestRuntimeSnapshot(session: Session): SessionEvent | undefined {
    const events = new Map(session.snapshotEvents().map((event) => [event.seq, event]));
    for (const seq of [...session.surface.nodes].reverse()) {
      const event = events.get(seq);
      if (event?.type === "user/message" && event.data.source.kind === CONTEXT_SOURCE
        && event.data.source.form === "snapshot") return event;
    }
    return undefined;
  }

  async recordContextSelection(session: Session, step: SessionEvent): Promise<void> {
    if (step.type !== "step/start") return;
    const prepared = this.preparedSelections.get(session);
    if (!prepared || prepared.requestId !== latestHumanPrompt(session)?.requestId) return;
    const snapshot = this.latestRuntimeSnapshot(session);
    let sections: ReadonlyArray<{ name: string; text: string }> = [];
    if (snapshot !== undefined) {
      if (snapshot.type !== "user/message" || snapshot.data.source.kind !== CONTEXT_SOURCE || snapshot.data.source.form !== "snapshot") return;
      sections = snapshot.data.source.sections;
      const [content] = snapshot.data.content;
      if (snapshot.data.content.length !== 1 || content?.type !== "text" || content.text !== joinContextSections(sections)) return;
    }
    const { value } = prepared;
    const indexPresent = sections.some((section) => section.name === "chopin:experience" && section.text === value.index.text);
    const applied: ContextSelectionRecord["applied"] = [];
    for (const choice of value.plan.items) {
      const candidate = value.input.candidates.find((item) => item.id === choice.id)!;
      const body = value.inline.find((item) => item.artifact.id === choice.id);
      const index = indexPresent && choice.mode !== "inline" && value.index.listed.includes(choice.id);
      const inline = body !== undefined && sections.some((section) => section.name === body.name && section.text === body.text);
      if ((choice.mode !== "inline" && !index) || (choice.mode !== "index" && !inline)) {
        throw new Error("Selected experience is missing from the committed context");
      }
      if (index || inline) applied.push({ id: choice.id, contentDigest: candidate.contentDigest, index, inline,
        chars: (index ? candidate.indexChars : 0) + (inline ? body!.text.length : 0) });
    }
    const id = `context-${improvementDigest({ sessionId: String(session.id), step: step.seq }).slice(7, 47)}`;
    await this.host.events.transact((projection) => {
      if (projection.contextSelections?.some((record) => record.id === id)) return { events: [], value: undefined };
      const record: ContextSelectionRecord = { id, sessionId: String(session.id), requestId: prepared.requestId,
        stepSeq: step.seq, snapshotSeq: snapshot?.seq ?? null, strategy: value.strategy, fallback: value.fallback,
        inputDigest: improvementDigest(value.input), plan: value.plan, applied, omitted: value.input.candidates.length - applied.length,
        sections: sections.map((section) => ({ name: section.name, chars: section.text.length, digest: improvementDigest(section.text) })),
        createdAt: new Date(step.time).toISOString() };
      return { events: [contextSelectionRecorded(record)], value: undefined };
    });
  }

  async inspectContext(agent: Agent) {
    const projection = foldEvolutionEvents(await readExperienceEvents(this.host.events.path));
    const events = agent.session.snapshotEvents();
    const latestStep = events.findLast((event) => event.type === "step/start");
    const record = projection.contextSelections?.findLast((item) => item.sessionId === String(agent.session.id) && item.stepSeq === latestStep?.seq);
    if (!record) return { status: "No committed context selection for this session.", usage: null };
    const step = events.find((event) => event.seq === record.stepSeq);
    const response = step?.type === "step/start" ? events.findLast((event) => event.type === "assistant/message"
      && event.data.turn === step.data.turn && event.data.step === step.data.step) : undefined;
    const failedAttempts = step?.type === "step/start" ? events.filter((event) => event.type === "assistant/attempt"
      && event.data.turn === step.data.turn && event.data.step === step.data.step).length : 0;
    return { selection: record, usage: response?.type === "assistant/message" ? response.data.usage ?? null : null,
      failedAttempts,
      note: "Section sizes are characters. Usage belongs to the completed assistant response, not individual experiences. Failed attempts may have additional unreported usage; null means unreported or pending." };
  }

  clearPreparedContexts(agent: Agent, owner: "memory" | "plugin"): void {
    const contexts = this.preparedContexts.get(agent.session);
    if (contexts === undefined) return;
    for (const [name, prepared] of contexts) if (prepared.owner === owner) contexts.delete(name);
  }

  prepareContext(agent: Agent, item: InlineExperience, facts: TriggerFacts, owner: "memory" | "plugin"): void {
    const prompt = this.host.contextPrompt(agent);
    if (prompt === undefined) return;
    let contexts = this.preparedContexts.get(agent.session);
    if (contexts === undefined) this.preparedContexts.set(agent.session, contexts = new Map());
    contexts.set(item.name, { item, factsDigest: triggerFactsDigest(facts), requestId: prompt.requestId, owner });
  }

  async recordContextSnapshot(session: Session, event: SessionEvent): Promise<void> {
    const snapshot = event.type === "step/start"
      ? this.latestRuntimeSnapshot(session) : event;
    if (snapshot?.type !== "user/message" || snapshot.data.source.kind !== CONTEXT_SOURCE
      || snapshot.data.source.form !== "snapshot") return;
    const prepared = this.preparedContexts.get(session);
    if (prepared === undefined) return;
    const sections = snapshot.data.source.sections;
    const [content] = snapshot.data.content;
    if (snapshot.data.content.length !== 1 || content?.type !== "text" || content.text !== joinContextSections(sections)) return;
    const history = (await this.host.events.snapshot()).events;
    const requestId = latestHumanPrompt(session)?.requestId;
    for (const entry of prepared.values()) {
      const { item } = entry;
      if (entry.requestId !== requestId) continue;
      if (!sections.some((section) => section.name === item.name && section.text === item.text)) continue;
      if (history.some((entry) => entry.type === "artifact.exposure-recorded" && entry.entityId === item.artifact.id
        && entry.data.phase === "injected" && entry.data.toolName === undefined
        && entry.data.sessionId === String(session.id) && entry.data.requestId === requestId
        && entry.data.contextName === item.name
        && entry.occurredAt >= (feedbackDeploymentReceipt(item.artifact)?.endedAt ?? ""))) continue;
      await this.host.recordExposure(item.artifact.id, {
        phase: "injected", sessionId: String(session.id), requestId: entry.requestId,
        contentDigest: item.artifact.contentDigest, factsDigest: entry.factsDigest,
        matchedSelectors: item.matchedSelectors, injectedChars: item.bodyChars, sourceEventSeq: event.seq, contextName: item.name,
      }, `context:${session.id}:${entry.requestId}:${item.name}:${feedbackDeploymentReceipt(item.artifact)?.receiptId ?? ""}`,
      new Date(event.time).toISOString());
    }
  }

  async readExperience(agent: Agent, callId: ToolCallId, artifactId: string): Promise<ExperienceReadResult> {
    const projection = (await this.host.events.snapshot()).projection;
    const prompt = this.host.contextPrompt(agent);
    const prepared = this.preparedSelections.get(agent.session);
    const exposed = prepared?.requestId === prompt?.requestId ? prepared?.value : undefined;
    const matches = projection.artifacts.filter((item) => item.id === artifactId
      || (item.manifest.id === artifactId && exposed?.plan.items.some((choice) => choice.id === item.id)
        && exposed.input.candidates.some((source) => source.id === item.id && source.contentDigest === item.contentDigest)));
    if (matches.length > 1) throw new Error(`ambiguous experience reference ${artifactId}`);
    const artifact = matches[0];
    if (artifact === undefined) throw new Error(`unknown artifact ${artifactId}`);
    if (artifact.manifest.kind !== "memory" && artifact.manifest.kind !== "skill") {
      throw new Error(`artifact ${artifactId} is ${artifact.manifest.kind}, not readable experience`);
    }
    if (!selectEffectiveDataArtifacts(projection).some((item) => item.id === artifact.id)) {
      throw new Error(`artifact ${artifactId} is not the effective deployed experience`);
    }
    const facts = await this.host.factsFor(agent, prompt?.prompt ?? "");
    const match = matchApplicabilityTrigger(artifact.manifest.trigger, facts);
    if (!match.matches) throw new Error(`artifact ${artifactId} is outside this request's scope`);
    const body = await readExperienceBody(this.host.artifacts, artifact, this.host.options.maxBodyChars);
    const sessionId = String(agent.session.id);
    await this.host.recordExposure(artifact.id, {
      phase: "injected",
      sessionId,
      requestId: String(callId),
      contentDigest: artifact.contentDigest,
      factsDigest: triggerFactsDigest(facts),
      matchedSelectors: match.matchedSelectors,
      toolName: EXPERIENCE_READ_TOOL,
      callId: String(callId),
      injectedChars: body.length,
    }, `${artifact.id}\0${sessionId}\0${String(callId)}\0injected`, new Date().toISOString());
    return {
      artifactId: artifact.id,
      contentDigest: artifact.contentDigest,
      kind: artifact.manifest.kind,
      ...(artifact.manifest.trigger.when === undefined ? {} : { when: artifact.manifest.trigger.when }),
      summary: artifact.manifest.summary,
      body,
    };
  }

}
