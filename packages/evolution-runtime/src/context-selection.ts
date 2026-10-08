import { assertContextSelectionInput, assertContextSelectionPlan, baselineContextSelection, baselineContextSelector, improvementDigest } from "@chopin/evolution";
import type { ArtifactStore, ContextSelectionInput, ContextSelectionPlan, ContextSelectionRecord, EvolutionProjection, ImproverReference } from "@chopin/evolution";
import { scrub } from "@chopin/ledger";
import { prepareInlineExperience } from "./inline.js";
import type { InlineExperience } from "./inline.js";
import { EXPERIENCE_INDEX_PREFIX, experienceIndexLine } from "./render.js";
import type { ExperienceContextResult } from "./render.js";
import type { Session, UserMessage } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { joinContextSections } from "@deepseek-ai/dsh-system-prompt";
import { selectContextArtifacts } from "./selection.js";
import type { SelectedArtifact, TriggerFacts } from "./selection.js";

export interface ContextSelector {
  reference: ImproverReference;
  run: (input: ContextSelectionInput, signal?: AbortSignal) => Promise<unknown>;
}
export interface PreparedExperienceContext {
  index: ExperienceContextResult;
  inline: InlineExperience[];
  input: ContextSelectionInput;
  plan: ContextSelectionPlan;
  strategy: ImproverReference;
  fallback: ContextSelectionRecord["fallback"];
}

/** A strategy sees only admitted descriptions and host-computed lengths; it cannot return or rewrite bodies. */
export async function contextCandidates(input: {
  projection: EvolutionProjection; artifacts: ArtifactStore; facts: TriggerFacts; objective: string;
  budget: ContextSelectionInput["budget"]; maxBodyChars: number;
}): Promise<{ input: ContextSelectionInput; selected: Map<string, SelectedArtifact>; inline: Map<string, InlineExperience> }> {
  const selected = new Map<string, SelectedArtifact>();
  const inline = new Map<string, InlineExperience>();
  const candidates: ContextSelectionInput["candidates"] = [];
  for (const item of selectContextArtifacts(input.projection, input.facts, Math.max(200, input.budget.indexItems))) {
    const body = await prepareInlineExperience(input.artifacts, item, input.budget.inlineChars, input.maxBodyChars);
    selected.set(item.artifact.id, item);
    if (body) inline.set(item.artifact.id, body);
    candidates.push({ id: item.artifact.id, contentDigest: item.artifact.contentDigest,
      kind: item.artifact.manifest.kind as "memory" | "skill",
      summary: scrub(item.artifact.manifest.summary).slice(0, 500),
      when: scrub(item.artifact.manifest.trigger.when ?? "the matched structured scope").slice(0, 1_000),
      indexChars: experienceIndexLine(item.artifact).length + 1, inlineChars: body?.text.length ?? null,
      matchedSelectors: item.matchedSelectors });
  }
  const value: ContextSelectionInput = { schemaVersion: 1, objective: scrub(input.objective).slice(0, 2_000) || "Select relevant experience.",
    budget: { ...input.budget, indexHeaderChars: EXPERIENCE_INDEX_PREFIX.length }, candidates };
  assertContextSelectionInput(value);
  return { input: value, selected, inline };
}

export async function runContextSelector(input: ContextSelectionInput, strategy?: ContextSelector, signal?: AbortSignal): Promise<ContextSelectionPlan> {
  signal?.throwIfAborted();
  const result = strategy ? await strategy.run(structuredClone(input), signal) : baselineContextSelection(input);
  assertContextSelectionPlan(result, input);
  const plan: ContextSelectionPlan = { schemaVersion: 1, items: result.items.map((item) => ({ ...item, reason: scrub(item.reason) })) };
  assertContextSelectionPlan(plan, input);
  return plan;
}

export function contextSelectionKey(input: ContextSelectionInput, strategy = baselineContextSelector()): string {
  return improvementDigest({ input, strategy });
}

/** Only appends a model-view replacement record; the original session, user messages and other components' context are kept. */
export function pruneExperienceHistory(session: Session, pending: readonly UserMessage[],
  ownedNames: ReadonlySet<string>, prepared?: PreparedExperienceContext): void {
  const managedSection = (name: string) => ownedNames.has(name);
  const desired = new Map(prepared?.inline.map((item) => [item.name, item.text]) ?? []);
  if (prepared?.index.text) desired.set("chopin:experience", prepared.index.text);
  const seen = new Set<string>();
  const inspect = (message: UserMessage) => {
    if (message.source.kind !== "runtime-context" || message.source.form !== "snapshot") return undefined;
    const sections = message.source.sections;
    if (!sections.some((section) => managedSection(section.name))) return undefined;
    if (message.content.length !== 1 || message.content[0]?.type !== "text" || message.content[0].text !== joinContextSections(sections)) {
      throw new Error("managed context snapshot does not match its declared sections");
    }
    return sections;
  };
  for (const message of pending) {
    for (const section of inspect(message) ?? []) {
      if (!managedSection(section.name)) continue;
      if (seen.has(section.name) || desired.get(section.name) !== section.text) throw new Error("assembled experience differs from the host-selected source");
      seen.add(section.name);
    }
  }
  const events = new Map(session.snapshotEvents().map((event) => [event.seq, event]));
  const replacements: Array<{ seq: (typeof session.surface.nodes)[number]; message: UserMessage }> = [];
  for (const seq of [...session.surface.nodes].reverse()) {
    const event = events.get(seq);
    if (event?.type !== "user/message") continue;
    const sections = inspect(event.data);
    if (!sections) continue;
    const kept = sections.filter((section) => {
      if (!managedSection(section.name)) return true;
      const duplicate = seen.has(section.name);
      seen.add(section.name);
      return !duplicate && desired.get(section.name) === section.text;
    });
    if (kept.length === sections.length) continue;
    const source = event.data.source;
    if (source.kind !== "runtime-context" || source.form !== "snapshot") continue;
    const message = kept.length > 0 ? createUserMessage({ source: { ...source, sections: kept },
      content: [{ type: "text", text: joinContextSections(kept) }] }) : createUserMessage({
      source: { kind: "chopin-context-selector", form: "notice", summary: "Obsolete experience context withdrawn." },
      content: [{ type: "text", text: "Obsolete experience context withdrawn." }],
    });
    replacements.push({ seq, message });
  }
  for (const { seq, message } of replacements) session.append("user/message", message, {
    surfaceOp: { op: "replace", startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
  });
}
