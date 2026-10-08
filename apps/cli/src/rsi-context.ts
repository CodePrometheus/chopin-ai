import { CONTEXT_SELECTOR_TOOL, assertContextSelectionInput, assertContextSelectionPlan, baselineContextSelection } from "@chopin/evolution";
import type { ContextSelectionInput } from "@chopin/evolution";
import type { ChopinEvolution } from "@chopin/evolution-runtime";
import { normalizeTriggerFacts, selectContextArtifacts, selectEffectiveDataArtifacts } from "@chopin/evolution-runtime/selection";
import { experienceIndexLine, EXPERIENCE_INDEX_PREFIX, readExperienceBody } from "@chopin/evolution-runtime/render";
import { prepareInlineExperience } from "@chopin/evolution-runtime/inline";
import { PluginExecutionError } from "@chopin/plugin-sandbox";
import type { SandboxedPlugin } from "@chopin/plugin-sandbox";

export interface TrialContextSnapshot {
  input: ContextSelectionInput;
  entries: Array<{ id: string; index: string; inline: string | null; body: string }>;
}

export function assertTrialContext(snapshot: TrialContextSnapshot): void {
  if (!snapshot || !Array.isArray(snapshot.entries)) throw new Error("Missing sealed trial context");
  assertContextSelectionInput(snapshot.input);
  if (snapshot.entries.length !== snapshot.input.candidates.length || new Set(snapshot.entries.map(entry => entry.id)).size !== snapshot.entries.length) {
    throw new Error("Trial context sources differ from admitted candidates");
  }
  for (const candidate of snapshot.input.candidates) {
    const entry = snapshot.entries.find(entry => entry.id === candidate.id);
    if (!entry || typeof entry.body !== "string" || typeof entry.index !== "string" || entry.index.length + 1 !== candidate.indexChars
      || (entry.inline === null ? candidate.inlineChars !== null : typeof entry.inline !== "string" || entry.inline.length !== candidate.inlineChars)) {
      throw new Error("Trial context source lengths differ from their sealed budget");
    }
  }
}

export async function assertTrialSources(snapshot: TrialContextSnapshot, host: ChopinEvolution): Promise<void> {
  if (!snapshot.input.candidates.length) return;
  const effective = new Map(selectEffectiveDataArtifacts((await host.events.snapshot()).projection).map(artifact => [artifact.id, artifact.contentDigest]));
  if (snapshot.input.candidates.some(candidate => effective.get(candidate.id) !== candidate.contentDigest)) {
    throw new Error("An admitted experience was changed or withdrawn during the sealed experiment");
  }
}

/** Freeze only the experience admitted within the current scope; trial reads never touch the formal usage statistics. */
export async function captureTrialContext(host: ChopinEvolution, workspace: string, model: string, objective: string): Promise<TrialContextSnapshot> {
  const { projection } = await host.events.snapshot();
  const input: ContextSelectionInput = { schemaVersion: 1, objective: objective.slice(0, 2_000),
    budget: { indexChars: 8_000, indexItems: 20, inlineChars: host.maxInlineChars, inlineItems: 20,
      indexHeaderChars: EXPERIENCE_INDEX_PREFIX.length }, candidates: [] };
  const entries: TrialContextSnapshot["entries"] = [];
  let remaining = 128_000;
  for (const item of selectContextArtifacts(projection, normalizeTriggerFacts({ repos: [workspace], environments: [model] }), 20)) {
    const inline = await prepareInlineExperience(host.artifacts, item, input.budget.inlineChars, 16_000);
    const body = await readExperienceBody(host.artifacts, item.artifact, 16_000);
    remaining -= body.length;
    if (remaining < 0) break;
    const artifact = item.artifact;
    const index = experienceIndexLine(artifact);
    input.candidates.push({ id: artifact.id, contentDigest: artifact.contentDigest, kind: artifact.manifest.kind as "memory" | "skill",
      summary: artifact.manifest.summary, when: artifact.manifest.trigger.when ?? "the declared project scope",
      indexChars: index.length + 1, inlineChars: inline?.text.length ?? null, matchedSelectors: item.matchedSelectors });
    entries.push({ id: artifact.id, index, inline: inline?.text ?? null, body });
  }
  return { input, entries };
}

export async function selectTrialContext(snapshot: TrialContextSnapshot, plugin?: SandboxedPlugin, signal?: AbortSignal) {
  assertTrialContext(snapshot);
  const selection = plugin?.inspection.definitions.tools.some(tool => tool.name === CONTEXT_SELECTOR_TOOL)
    ? await plugin.executeTool(CONTEXT_SELECTOR_TOOL, { callId: "trial-context", arguments: JSON.parse(JSON.stringify(snapshot.input)) }, signal)
    : baselineContextSelection(snapshot.input);
  try { assertContextSelectionPlan(selection, snapshot.input); }
  catch (error) { throw new PluginExecutionError(`Context selection violated its contract: ${String(error)}`); }
  const index: string[] = []; const inline: string[] = [];
  for (const choice of selection.items) {
    const entry = snapshot.entries.find(entry => entry.id === choice.id);
    if (!entry) throw new Error("Selected context is not in the sealed source snapshot");
    if (choice.mode !== "inline") index.push(entry.index);
    if (choice.mode !== "index") {
      if (entry.inline === null) throw new Error("Selected context has no complete inline body");
      inline.push(entry.inline);
    }
  }
  return { selection, text: [...(index.length ? [EXPERIENCE_INDEX_PREFIX, ...index] : []), ...inline].join("\n") };
}
