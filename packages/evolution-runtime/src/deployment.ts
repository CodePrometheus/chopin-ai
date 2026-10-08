import type {
  ArtifactProjection,
  DeploymentMode,
  ArtifactReference,
  EvolutionEventStore,
  EvolutionProjection,
  DeploymentReceipt,
} from "@chopin/evolution";
import { feedbackDeploymentReceipt } from "@chopin/evolution";

import { selectEffectiveDataArtifacts } from "./selection.js";
import { matchApplicabilityTrigger } from "./selection.js";
import type { TriggerFacts } from "./selection.js";

export function selectRoleArtifact(projection: EvolutionProjection, role: string, facts: TriggerFacts): ArtifactProjection | undefined {
  return selectProductionArtifacts(projection).filter(artifact => artifact.manifest.provides.tools.includes(role))
    .map(artifact => ({ artifact, match: matchApplicabilityTrigger(artifact.manifest.trigger, facts) })).filter(item => item.match.matches)
    .sort((a, b) => b.match.matchedSelectors.length - a.match.matchedSelectors.length
      || b.artifact.stateChangedEventIndex - a.artifact.stateChangedEventIndex)[0]?.artifact;
}

export function artifactReferenceOf(artifact: ArtifactProjection): ArtifactReference {
  return {
    artifactId: artifact.id,
    contentDigest: artifact.contentDigest,
    surfaceDigest: artifact.surfaceDigest,
  };
}

export function referenceMatchesArtifact(reference: ArtifactReference, artifact: ArtifactProjection): boolean {
  return reference.artifactId === artifact.id
    && reference.contentDigest === artifact.contentDigest
    && reference.surfaceDigest === artifact.surfaceDigest;
}

function successfulDeploymentReceipts(artifact: ArtifactProjection, mode: "canary" | "active"): DeploymentReceipt[] {
  return artifact.deploymentReceipts.filter((receipt) => {
    if (receipt.health !== "pass" || receipt.mode !== mode) return false;
    return artifact.deploymentRequests.some((request) =>
      request.requestId === receipt.operationId
      && request.mode === mode
      && request.targetGeneration === receipt.processGeneration);
  });
}

export function latestSuccessfulDeployment(
  artifact: ArtifactProjection,
  mode: "canary" | "active",
): DeploymentReceipt | undefined {
  return successfulDeploymentReceipts(artifact, mode).at(-1);
}

/** Feedback binds to the current enablement epoch; a process load only starts a new epoch after a rollback restore. */
export function latestFeedbackDeployment(artifact: ArtifactProjection): DeploymentReceipt | undefined {
  return feedbackDeploymentReceipt(artifact);
}

export function hasExactApproval(artifact: ArtifactProjection): boolean {
  return artifact.approvalReceipts.some((receipt) =>
    receipt.decision === "allowed-once"
    && receipt.artifactId === artifact.id
    && receipt.contentDigest === artifact.contentDigest
    && receipt.manifestDigest === artifact.manifestDigest
    && receipt.surfaceDigest === artifact.surfaceDigest);
}

export function hasEffectiveReplacement(projection: EvolutionProjection, artifact: ArtifactProjection): boolean {
  return projection.artifacts.some((other) => other.id !== artifact.id
    && other.manifest.id === artifact.manifest.id && other.manifest.runtime === artifact.manifest.runtime
    && other.enabled && (other.state === "active" || other.state === "retired"));
}

/** Production versions follow the event projection's effectiveness decision and re-check their approval and deployment receipts. */
export function selectProductionArtifacts(projection: EvolutionProjection): ArtifactProjection[] {
  return projection.artifacts.filter((artifact) =>
    artifact.manifest.runtime === "dsh-plugin"
    && artifact.enabled
    && (artifact.state === "active" || artifact.state === "retired")
    && hasExactApproval(artifact)
    && latestSuccessfulDeployment(artifact, "active") !== undefined)
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}

/** Versions that may currently produce real exposures/outcomes: production, canary, and the data effective version. */
export function selectFeedbackArtifacts(projection: EvolutionProjection): ArtifactProjection[] {
  const selected = new Map<string, ArtifactProjection>();
  for (const artifact of selectProductionArtifacts(projection)) selected.set(artifact.id, artifact);
  for (const artifact of selectEffectiveDataArtifacts(projection)) selected.set(artifact.id, artifact);
  for (const artifact of projection.artifacts) {
    if (artifact.enabled && (artifact.state === "canary-active" || (artifact.manifest.runtime === "mcp" && artifact.state === "active"))) {
      selected.set(artifact.id, artifact);
    }
  }
  return [...selected.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function assertLastKnownGood(
  projection: EvolutionProjection,
  current: ArtifactProjection,
  reference: ArtifactReference,
): ArtifactProjection {
  const target = projection.artifacts.find((artifact) => artifact.id === reference.artifactId);
  if (target === undefined) throw new Error(`rollback target ${reference.artifactId} does not exist`);
  if (!referenceMatchesArtifact(reference, target)) throw new Error(`rollback target ${reference.artifactId} digest changed`);
  if (target.id === current.id || target.manifest.id !== current.manifest.id) {
    throw new Error(`rollback target ${target.id} is not an earlier version of ${current.manifest.id}`);
  }
  if (target.manifest.kind !== current.manifest.kind || target.manifest.runtime !== current.manifest.runtime) {
    throw new Error(`rollback target ${target.id} changed capability kind or runtime`);
  }
  if (target.state !== "active" && target.state !== "retired") {
    throw new Error(`rollback target ${target.id} is ${target.state}, not active or retired`);
  }
  if (!hasExactApproval(target)) throw new Error(`rollback target ${target.id} has no exact approval`);
  if (latestSuccessfulDeployment(target, "active") === undefined) {
    throw new Error(`rollback target ${target.id} has no successful active deployment`);
  }
  return target;
}

export function resolveLastKnownGood(projection: EvolutionProjection, current: ArtifactProjection): ArtifactReference {
  const declared = [current.manifest.lineage.rollbackTo, current.manifest.lineage.supersedes]
    .filter((reference): reference is ArtifactReference => reference !== undefined);
  if (declared.length > 0) {
    const target = assertLastKnownGood(projection, current, declared[0] as ArtifactReference);
    return artifactReferenceOf(target);
  }

  const candidates = projection.artifacts
    .filter((artifact) => artifact.id !== current.id && artifact.manifest.id === current.manifest.id)
    .flatMap((artifact) => {
      try {
        const target = assertLastKnownGood(projection, current, artifactReferenceOf(artifact));
        const receipt = latestSuccessfulDeployment(target, "active") as DeploymentReceipt;
        return [{ target, receipt }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.receipt.endedAt.localeCompare(left.receipt.endedAt) || right.target.id.localeCompare(left.target.id));
  const selected = candidates[0]?.target;
  if (selected === undefined) throw new Error(`artifact ${current.id} has no approved last-known-good version`);
  return artifactReferenceOf(selected);
}

export async function hasPostCanaryBehavior(
  _eventStore: EvolutionEventStore,
  artifact: ArtifactProjection,
): Promise<boolean> {
  const canary = latestSuccessfulDeployment(artifact, "canary");
  // canary-active can only be written by the target generation's host controller
  // after the exact fixture contract passes; the current successful canary receipt
  // is itself the behavioral evidence.
  return canary !== undefined;
}

export function nextDeploymentMode(artifact: ArtifactProjection): DeploymentMode | undefined {
  if (artifact.state === "approved") return "disabled";
  if (artifact.state === "installed-disabled") return "canary";
  if (artifact.state === "canary-active") return "active";
  if (artifact.state === "quarantined") return "rollback";
  return undefined;
}

export function latestFailedDeployment(artifact: ArtifactProjection, mode = nextDeploymentMode(artifact)) {
  if (mode === undefined) return undefined;
  const request = artifact.deploymentRequests.findLast((item) => item.mode === mode);
  if (request === undefined) return undefined;
  const receipt = artifact.deploymentReceipts.find((item) => item.operationId === request.requestId);
  return receipt?.health === "fail" ? { request, receipt } : undefined;
}
