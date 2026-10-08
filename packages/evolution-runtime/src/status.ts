import { readFile } from "node:fs/promises";

import { assertEvolutionEvent, evaluateFeedbackWindow, feedbackDeploymentReceipt, foldEvolutionEvents } from "@chopin/evolution";
import type { EvolutionEvent, EvolutionProjection } from "@chopin/evolution";
import { scrub } from "@chopin/ledger";

import { selectEffectiveDataArtifacts } from "./selection.js";
import { CUMULATIVE_WINDOW_PREFIX, SESSION_WINDOW_PREFIX } from "./outcomes.js";

export interface ExperienceStatus {
  id: string;
  familyId: string;
  kind: string;
  summary: string;
  when?: string;
  state: string;
  enabled: boolean;
  listed: number;
  loaded: number;
  read: number;
  executed: number;
  effect: "pending" | "supported" | "contradicted" | "unproductive";
  evidenceRefs: string[];
  observationRefs: string[];
  sourceRefs: string[];
}

/** Viewing is pure replay: no write lock, no directory creation, no lifecycle advance. */
export async function readExperienceEvents(path: string): Promise<EvolutionEvent[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter((line) => line.trim() !== "")
      .map((line) => {
        const event: unknown = JSON.parse(line);
        assertEvolutionEvent(event);
        return event;
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Cumulative eligible exposures after which a capability with no task pass counts as unproductive. */
const UNPRODUCTIVE_EXPOSURES = 6;

export function experienceStatuses(
  events: readonly EvolutionEvent[],
  sessionId?: string,
  projection: EvolutionProjection = foldEvolutionEvents(events),
): ExperienceStatus[] {
  const effective = new Set(selectEffectiveDataArtifacts(projection).map((artifact) => artifact.id));
  return projection.artifacts.map((artifact) => {
    const deployment = feedbackDeploymentReceipt(artifact);
    const exposures = events.filter((event) => event.type === "artifact.exposure-recorded"
      && event.entityId === artifact.id && event.data.contentDigest === artifact.contentDigest
      && (sessionId === undefined || event.data.sessionId === sessionId)
      && (deployment === undefined || event.occurredAt >= deployment.endedAt));
    const windows = artifact.feedbackWindows.filter((window) => window.deploymentReceiptId === deployment?.receiptId);
    const independent = windows.filter((window) => !window.windowId.startsWith(SESSION_WINDOW_PREFIX)
      && !window.windowId.startsWith(CUMULATIVE_WINDOW_PREFIX));
    const supported = artifact.trust === "trusted" && independent.some((window) => evaluateFeedbackWindow(window) === "confirm");
    const contradicted = artifact.trust === "quarantined" || windows.some((window) =>
      ["contradict", "quarantine"].includes(evaluateFeedbackWindow(window)));
    // Enough eligible exposures with no measured gain: a pruning signal, never a verdict.
    const unproductive = windows.some((window) => window.windowId.startsWith(CUMULATIVE_WINDOW_PREFIX)
      && window.eligible >= UNPRODUCTIVE_EXPOSURES && window.taskPass === 0);
    const candidates = projection.candidates.filter((candidate) => artifact.manifest.lineage.candidateIds.includes(candidate.id));
    return {
      id: artifact.id, kind: artifact.manifest.kind, summary: artifact.manifest.summary,
      familyId: artifact.manifest.id,
      ...(artifact.manifest.trigger.when === undefined ? {} : { when: artifact.manifest.trigger.when }),
      state: artifact.state,
      enabled: artifact.manifest.runtime === "data" ? effective.has(artifact.id) : artifact.enabled,
      listed: exposures.filter((event) => event.data.phase === "selected").length,
      loaded: exposures.filter((event) => event.data.phase === "injected" && event.data.toolName === undefined).length,
      read: exposures.filter((event) => event.data.phase === "injected" && event.data.toolName !== undefined).length,
      executed: exposures.filter((event) => event.data.phase === "tool-called" || event.data.phase === "gate-evaluated").length,
      effect: contradicted ? "contradicted" : supported ? "supported" : unproductive ? "unproductive" : "pending",
      evidenceRefs: [...new Set(independent.flatMap((window) => window.evidenceRefs))],
      observationRefs: [...new Set(windows.filter((window) => !independent.includes(window)).flatMap((window) => window.evidenceRefs))],
      sourceRefs: [...new Set(candidates.flatMap((candidate) => candidate.evidence.flatMap((item) => item.sourceRef === undefined ? [] : [item.sourceRef])))],
    };
  });
}

function display(value: string): string {
  return scrub(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

export function experienceStatusLine(item: ExperienceStatus): string {
  const effect = item.effect === "supported" ? "effect evidence met" : item.effect === "contradicted" ? "negative feedback present"
    : item.effect === "unproductive" ? "no measured gain; review for retirement" : "effect unverified";
  return `${display(item.summary)} | ${item.enabled ? "enabled" : "disabled"} | loaded ${item.loaded} / read ${item.read} / executed ${item.executed} | ${effect}`;
}

export function renderExperienceStatus(items: readonly ExperienceStatus[], detail = false): string {
  if (items.length === 0) return "No saved experiences yet; a candidate observation is not a usable experience.";
  const shown = detail ? items : items.slice(-20);
  return [
    `${new Set(items.map(item => item.familyId)).size} experience(s) (${items.length} version(s)), ${items.filter((item) => item.enabled).length} enabled. Loading or reading does not mean any benefit was produced.`,
    ...shown.flatMap((item) => [
      experienceStatusLine(item),
      `  ${item.id} (${item.state})`,
      ...(detail ? [
        `  applies when: ${display(item.when ?? "bounded by structured scope")}`,
        `  sources: ${item.sourceRefs.join(", ") || "no source refs"}`,
        `  effect evidence: ${item.evidenceRefs.join(", ") || "none yet"}`,
        `  observations: ${item.observationRefs.join(", ") || "none yet"}`,
      ] : []),
    ]),
    ...(shown.length < items.length ? ["Showing the latest 20 only; pass a full experience id for details."] : []),
  ].join("\n");
}
