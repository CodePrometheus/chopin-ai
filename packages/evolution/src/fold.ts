import { applyCandidateData, CandidateInvariantError } from "./candidate.js";
import { applyArtifactData } from "./artifact.js";
import { canonicalJson } from "./events.js";
import type {
  ArtifactProjection,
  ArtifactState,
  CandidateProjection,
  CandidateState,
  DeploymentReceipt,
  EvolutionEvent,
  EvolutionProjection,
  ProposalOutcome,
} from "./types.js";
import { EVOLUTION_EVENT_SCHEMA_VERSION } from "./types.js";
import { assertImprovementRecord, IMPROVER_TOOL } from "./improvement.js";
import type { ImprovementRecord } from "./improvement.js";
import { assertContextSelectionRecord, CONTEXT_SELECTOR_TOOL } from "./context-selection.js";
import type { ContextSelectionRecord } from "./context-selection.js";

export class EvolutionTransitionError extends Error {
  constructor(event: EvolutionEvent, current: string | undefined, expected: string) {
    super(`${event.type} cannot transition ${event.entityKind} ${event.entityId} from ${current ?? "absent"}; expected ${expected}`);
    this.name = "EvolutionTransitionError";
  }
}

export class EvolutionEventConflictError extends Error {
  constructor(eventId: string) {
    super(`eventId ${eventId} appears with different content`);
    this.name = "EvolutionEventConflictError";
  }
}

interface SuccessfulDeployment {
  artifactId: string;
  contentDigest: string;
}

function assertResolvedDeployments(
  event: EvolutionEvent,
  deployments: ReadonlyMap<string, SuccessfulDeployment>,
): void {
  if (event.type !== "candidate.resolved") return;
  const outcomes = event.data.outcomes as unknown as ProposalOutcome[];
  for (const outcome of outcomes) {
    if (outcome.status !== "activated") continue;
    const deployment = deployments.get(outcome.deploymentEventId);
    if (deployment === undefined) {
      throw new CandidateInvariantError(event.entityId, `activated proposal ${outcome.proposalId} references no prior successful deployment ${outcome.deploymentEventId}`);
    }
    if (deployment.artifactId !== outcome.artifactId || deployment.contentDigest !== outcome.contentDigest) {
      throw new CandidateInvariantError(event.entityId, `activated proposal ${outcome.proposalId} does not match deployment ${outcome.deploymentEventId}`);
    }
  }
}

function candidateNext(event: EvolutionEvent, current: CandidateState | undefined): CandidateState {
  switch (event.type) {
    case "candidate.observed":
      if (current === undefined) return "observed";
      // Observed again after resolved is a recurrence -- exactly the evidence the feedback loop counts, so it must not be turned away.
      if (current === "observed" || current === "corroborated" || current === "classified" || current === "resolved") return current;
      throw new EvolutionTransitionError(event, current, "an unrejected, unmerged candidate");
    case "candidate.corroborated":
      if (current === "observed" || current === "corroborated") return "corroborated";
      throw new EvolutionTransitionError(event, current, "observed or corroborated");
    case "candidate.classified":
      // Classifying after resolved is a new version of the same experience; resolved is rewritten once the new artifact is live.
      if (current === "corroborated" || current === "classified" || current === "resolved") return "classified";
      throw new EvolutionTransitionError(event, current, "corroborated, classified or resolved");
    case "candidate.resolved":
      if (current === "classified") return "resolved";
      throw new EvolutionTransitionError(event, current, "classified");
    case "candidate.rejected":
      if (current === "observed" || current === "corroborated" || current === "classified") return "rejected";
      throw new EvolutionTransitionError(event, current, "a non-terminal candidate");
    case "candidate.merged":
      if (current === "observed" || current === "corroborated" || current === "classified") return "merged";
      throw new EvolutionTransitionError(event, current, "a non-terminal candidate");
    default:
      throw new EvolutionTransitionError(event, current, "a candidate event");
  }
}

function artifactNext(event: EvolutionEvent, current: ArtifactState | undefined): ArtifactState {
  switch (event.type) {
    case "artifact.drafted":
      if (current === undefined) return "draft";
      throw new EvolutionTransitionError(event, current, "absent");
    case "artifact.built":
      if (current === "draft") return "built";
      throw new EvolutionTransitionError(event, current, "draft");
    case "artifact.verification-failed":
      if (current === "built") return current;
      throw new EvolutionTransitionError(event, current, "built");
    case "artifact.verified":
      if (current === "built") return "verified";
      throw new EvolutionTransitionError(event, current, "built");
    case "artifact.approved":
      if (current === "verified") return "approved";
      throw new EvolutionTransitionError(event, current, "verified");
    case "artifact.installed-disabled":
      if (current === "approved") return "installed-disabled";
      throw new EvolutionTransitionError(event, current, "approved");
    case "artifact.deployment-requested":
    case "artifact.deployment-failed":
      if (current === "approved" || current === "installed-disabled" || current === "canary-active" || current === "quarantined") return current;
      throw new EvolutionTransitionError(event, current, "approved, installed-disabled, canary-active or quarantined");
    case "artifact.canary-active":
      if (current === "installed-disabled") return "canary-active";
      throw new EvolutionTransitionError(event, current, "installed-disabled");
    case "artifact.active":
      if (current === "canary-active") return "active";
      throw new EvolutionTransitionError(event, current, "canary-active");
    case "artifact.quarantined":
      if (current === "canary-active" || current === "active" || current === "retired") return "quarantined";
      throw new EvolutionTransitionError(event, current, "canary-active, active or retired");
    case "artifact.rolled-back":
      if (current === "quarantined") return "rolled-back";
      throw new EvolutionTransitionError(event, current, "quarantined");
    case "artifact.retired":
      if (current === "active" || current === "retired") return "retired";
      throw new EvolutionTransitionError(event, current, "active or retired");
    case "artifact.rejected":
      if (current === "draft" || current === "built" || current === "verified" || current === "approved" || current === "installed-disabled") {
        return "rejected";
      }
      throw new EvolutionTransitionError(event, current, "a pre-activation state");
    case "artifact.exposure-recorded":
    case "artifact.feedback-recorded":
    case "artifact.runtime-loaded":
      if (current === "canary-active" || current === "active" || current === "quarantined" || current === "rolled-back" || current === "retired") {
        return current;
      }
      throw new EvolutionTransitionError(event, current, "a deployed state");
    case "artifact.trusted":
    case "artifact.demoted":
      if (current === "canary-active" || current === "active" || current === "retired") return current;
      throw new EvolutionTransitionError(event, current, "canary-active, active or retired");
    default:
      throw new EvolutionTransitionError(event, current, "an artifact event");
  }
}

/** Fold the current state from the full event history; the log order is the transition order. */
export function foldEvolutionEvents(events: readonly EvolutionEvent[]): EvolutionProjection {
  const candidates = new Map<string, CandidateProjection>();
  const artifacts = new Map<string, ArtifactProjection>();
  const improvements = new Map<string, ImprovementRecord>();
  const contextSelections = new Map<string, ContextSelectionRecord>();
  const deployments = new Map<string, SuccessfulDeployment>();
  const seenEvents = new Map<string, string>();
  let applied = 0;
  let lastEventId: string | undefined;

  for (const event of events) {
    const canonical = canonicalJson(event);
    const seen = seenEvents.get(event.eventId);
    if (seen !== undefined) {
      if (seen !== canonical) throw new EvolutionEventConflictError(event.eventId);
      continue;
    }
    seenEvents.set(event.eventId, canonical);
    applied += 1;
    lastEventId = event.eventId;

    if (event.entityKind === "context-selection") {
      if (event.type !== "context.selection-recorded" || event.actor?.kind !== "system" || event.actor.id !== "chopin-context-selector"
        || Object.keys(event.data).length !== 1) throw new Error("context selection requires the host recorder");
      const record = event.data.record;
      assertContextSelectionRecord(record);
      if (record.id !== event.entityId || record.createdAt !== event.occurredAt) throw new Error("context selection identity differs");
      for (const reference of [record.strategy, ...(record.fallback === null ? [] : [record.fallback.strategy])]) {
        if (reference.kind === "builtin") continue;
        const source = artifacts.get(reference.id);
        if (!source || source.contentDigest !== reference.contentDigest || !source.manifest.provides.tools.includes(CONTEXT_SELECTOR_TOOL)
          || !source.deploymentReceipts.some((receipt) => receipt.health === "pass" && receipt.mode === "active")) throw new Error("context strategy has no exact deployed source");
      }
      for (const item of record.applied) {
        const artifact = artifacts.get(item.id);
        if (!artifact || artifact.contentDigest !== item.contentDigest || !["memory", "skill"].includes(artifact.manifest.kind)
          || (item.inline && artifact.manifest.kind !== "memory")) throw new Error("applied context source differs");
      }
      contextSelections.set(record.id, record);
      continue;
    }
    if (event.entityKind === "improvement") {
      if (event.type !== "improvement.planned" || event.actor?.kind !== "system" || event.actor.id !== "chopin-improver"
        || Object.keys(event.data).length !== 1) throw new Error("improvement record requires the host planner");
      const record = event.data.record;
      assertImprovementRecord(record);
      if (record.id !== event.entityId || record.createdAt !== event.occurredAt) throw new Error("improvement record identity differs");
      if (record.input.strategy.kind === "artifact") {
        const source = artifacts.get(record.input.strategy.id);
        if (source === undefined || source.contentDigest !== record.input.strategy.contentDigest
          || !source.manifest.provides.tools.includes(IMPROVER_TOOL)
          || !source.deploymentReceipts.some((receipt) => receipt.health === "pass" && receipt.mode === "active")) {
          throw new Error("improvement strategy has no exact deployed source");
        }
      }
      const existing = improvements.get(record.id);
      if (existing !== undefined && canonicalJson(existing) !== canonicalJson(record)) throw new Error("improvement record changed");
      improvements.set(record.id, record);
      continue;
    }

    if (event.entityKind === "candidate") {
      const previous = candidates.get(event.entityId);
      const state = candidateNext(event, previous?.state);
      const data = applyCandidateData(previous, event);
      for (const proposal of data.proposals) {
        if (proposal.improvementId !== undefined && !improvements.has(proposal.improvementId)) throw new Error("proposal references an unknown improvement");
      }
      assertResolvedDeployments(event, deployments);
      candidates.set(event.entityId, {
        ...data,
        id: event.entityId,
        state,
        eventCount: (previous?.eventCount ?? 0) + 1,
        firstEventId: previous?.firstEventId ?? event.eventId,
        lastEventId: event.eventId,
        updatedAt: event.occurredAt,
      });
      continue;
    }

    const previous = artifacts.get(event.entityId);
    const state = artifactNext(event, previous?.state);
    const data = applyArtifactData(previous, event);
    if (data.manifest.lineage.improvementId !== undefined && !improvements.has(data.manifest.lineage.improvementId)) throw new Error("capability references an unknown improvement");
    artifacts.set(event.entityId, {
      ...data,
      id: event.entityId,
      state,
      stateChangedAt: previous === undefined || state !== previous.state ? event.occurredAt : previous.stateChangedAt,
      stateChangedEventIndex: previous === undefined || state !== previous.state ? applied : previous.stateChangedEventIndex,
      eventCount: (previous?.eventCount ?? 0) + 1,
      firstEventId: previous?.firstEventId ?? event.eventId,
      lastEventId: event.eventId,
      updatedAt: event.occurredAt,
    });
    const current = artifacts.get(event.entityId) as ArtifactProjection;
    const activates = event.type === "artifact.active"
      || (event.type === "artifact.canary-active" && current.manifest.runtime === "data");
    if (activates || event.type === "artifact.rolled-back") {
      for (const [id, artifact] of artifacts) {
        if (artifact.manifest.id !== current.manifest.id || artifact.manifest.runtime !== current.manifest.runtime) continue;
        if (artifact.manifest.runtime !== "data" && artifact.state === "canary-active") continue;
        if (activates && id === current.id) {
          artifacts.set(id, { ...artifact, enabled: true });
        } else {
          const { feedbackDeploymentReceiptId: _feedbackDeploymentReceiptId, ...disabled } = artifact;
          artifacts.set(id, { ...disabled, enabled: false });
        }
      }
      if (event.type === "artifact.rolled-back") {
        const receipt = event.data.receipt as unknown as DeploymentReceipt;
        const reference = receipt.rollbackTarget;
        const target = reference === undefined ? undefined : artifacts.get(reference.artifactId);
        if (
          target !== undefined && reference !== undefined
          && (target.state === "active" || target.state === "retired")
          && target.manifest.id === current.manifest.id
          && target.manifest.kind === current.manifest.kind
          && target.manifest.runtime === current.manifest.runtime
          && target.contentDigest === reference.contentDigest
          && target.surfaceDigest === reference.surfaceDigest
          && target.approvalReceipts.some((approval) => approval.decision === "allowed-once"
            && approval.contentDigest === target.contentDigest && approval.surfaceDigest === target.surfaceDigest)
          && target.deploymentReceipts.some((deployment) => deployment.mode === "active" && deployment.health === "pass"
            && target.deploymentRequests.some((request) => request.requestId === deployment.operationId
              && request.targetGeneration === deployment.processGeneration))
        ) artifacts.set(target.id, { ...target, enabled: true });
      }
    }
    if (event.type === "artifact.canary-active" || event.type === "artifact.active") {
      deployments.set(event.eventId, {
        artifactId: event.entityId,
        contentDigest: data.contentDigest,
      });
    }
  }

  return {
    schemaVersion: EVOLUTION_EVENT_SCHEMA_VERSION,
    eventCount: applied,
    ...(lastEventId === undefined ? {} : { lastEventId }),
    candidates: [...candidates.values()].sort((left, right) => left.id.localeCompare(right.id)),
    artifacts: [...artifacts.values()].sort((left, right) => left.id.localeCompare(right.id)),
    ...(improvements.size === 0 ? {} : { improvements: [...improvements.values()] }),
    ...(contextSelections.size === 0 ? {} : { contextSelections: [...contextSelections.values()] }),
  };
}
