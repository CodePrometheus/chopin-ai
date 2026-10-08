import { automaticCapabilityDenial, automaticRetryAvailable, candidateCanBeCorroborated } from "@chopin/evolution";
import type { ArtifactProjection, CandidateProjection, EvolutionProjection } from "@chopin/evolution";
import { scrub } from "@chopin/ledger";
import { latestFailedDeployment } from "./deployment.js";

/**
 * Evolution queue: the things only the model (or a person) can do, not the host.
 *
 * Normal deployment is advanced by the host; candidate judgment, artifact authoring,
 * user approval and failure recovery are listed here.
 */

export type EvolutionQueueAction = "corroborate" | "classify" | "stage" | "approve" | "fix" | "retry";

export interface EvolutionQueueItem {
  action: EvolutionQueueAction;
  id: string;
  detail: string;
  /** Independent sessions behind a candidate item; artifact items carry none. */
  support?: number;
}

const ACTION_ORDER: Record<EvolutionQueueAction, number> = { approve: 0, retry: 1, fix: 2, stage: 3, classify: 4, corroborate: 5 };

function artifactsFor(projection: EvolutionProjection, candidate: CandidateProjection): ArtifactProjection[] {
  return projection.artifacts.filter((artifact) => artifact.manifest.lineage.candidateIds.includes(candidate.id));
}

export function evolutionQueue(projection: EvolutionProjection): EvolutionQueueItem[] {
  const items: EvolutionQueueItem[] = [];
  for (const candidate of projection.candidates) {
    if (candidate.state === "observed" && candidateCanBeCorroborated(candidate)) {
      items.push({
        action: "corroborate",
        id: candidate.id,
        detail: `${candidate.trustedIndependentUnits} independent unit(s); ${candidate.lesson}`,
        support: candidate.trustedIndependentUnits,
      });
    } else if (candidate.state === "corroborated") {
      items.push({ action: "classify", id: candidate.id, detail: candidate.rootCause ?? candidate.lesson, support: candidate.trustedIndependentUnits });
    } else if (candidate.state === "classified") {
      const artifacts = artifactsFor(projection, candidate);
      const failedProposals = new Set(artifacts
        .filter((artifact) => artifact.state === "quarantined" || artifact.state === "rolled-back" || artifact.state === "rejected")
        .flatMap((artifact) => artifact.manifest.lineage.proposalIds));
      const staged = new Set(artifacts
        .filter((artifact) => artifact.state !== "quarantined" && artifact.state !== "rolled-back" && artifact.state !== "rejected")
        .flatMap((artifact) => artifact.manifest.lineage.proposalIds.filter((id) =>
          !failedProposals.has(id) || artifact.enabled || (artifact.state !== "active" && artifact.state !== "retired"))));
      for (const proposal of candidate.proposals) {
        if (staged.has(proposal.proposalId)) continue;
        const previous = artifacts
          .filter((artifact) => artifact.manifest.lineage.proposalIds.includes(proposal.proposalId))
          .sort((left, right) => right.stateChangedEventIndex - left.stateChangedEventIndex)[0];
        const revision = previous === undefined ? "" : `; replace ${previous.id} with a new version; previous state=${previous.state}`;
        items.push({ action: "stage", id: candidate.id, detail: `proposal ${proposal.proposalId} (${proposal.kind}): ${proposal.summary}${revision}` });
      }
    }
  }
  for (const artifact of projection.artifacts) {
    const failure = latestFailedDeployment(artifact);
    if (failure !== undefined) {
      const exhausted = !automaticRetryAvailable(artifact, failure.request.mode);
      items.push({
        action: exhausted ? "fix" : "retry", id: artifact.id,
        detail: `${failure.request.mode} failed: ${scrub(failure.receipt.detail ?? "see failure receipt").slice(0, 300)}; contentDigest=${artifact.contentDigest}; failureReceiptId=${failure.receipt.receiptId}; candidates=${artifact.manifest.lineage.candidateIds.join(",")}; proposals=${artifact.manifest.lineage.proposalIds.join(",")}; ${exhausted ? "automatic retry exhausted; stage a corrected version" : "one policy retry is allowed for managed capabilities"}`,
      });
    }
    if (artifact.state === "verified") {
      const denial = automaticCapabilityDenial(artifact.manifest);
      items.push({ action: "approve", id: artifact.id, detail: `${artifact.manifest.kind} at ${artifact.contentDigest}${denial === undefined ? "" : `; needs explicit authorization: ${denial}`}` });
    } else if (artifact.state === "built" && artifact.verificationReceipts.some((receipt) => receipt.verdict !== "pass")) {
      const failed = artifact.verificationReceipts.at(-1)?.checks.filter((check) => check.status === "fail").map((check) => check.name) ?? [];
      items.push({ action: "fix", id: artifact.id, detail: `verification failed: ${failed.join(", ") || "see receipt"}; restage a corrected version` });
    }
  }
  // Within one action, the work backed by more independent sessions comes first.
  return items.sort((left, right) => ACTION_ORDER[left.action] - ACTION_ORDER[right.action]
    || (right.support ?? 0) - (left.support ?? 0) || left.id.localeCompare(right.id));
}

export const EVOLUTION_QUEUE_HEADER = "[CHOPIN EVOLUTION QUEUE — self-improvement work only you can do]";
const QUEUE_TOOLS: Record<EvolutionQueueAction, string> = {
  corroborate: "evolution_candidate_corroborate",
  classify: "evolution_candidate_classify",
  stage: "evolution_artifact_stage",
  approve: "evolution_approve",
  fix: "evolution_artifact_stage",
  retry: "evolution_deployment_retry",
};

/** The queue rendered into context: one item and its tool per line; beyond the line cap only a count is reported. */
export function renderEvolutionQueue(items: readonly EvolutionQueueItem[], maxLines = 10): string {
  if (items.length === 0) return "";
  const lines = items.slice(0, maxLines).map((item) => `- ${item.action} ${item.id} via ${QUEUE_TOOLS[item.action]} — ${item.detail}`);
  if (items.length > maxLines) lines.push(`- …and ${items.length - maxLines} more; evolution_queue lists all`);
  return [EVOLUTION_QUEUE_HEADER, "Do these when the project queue is drained or the user is not waiting on you.", ...lines].join("\n");
}
