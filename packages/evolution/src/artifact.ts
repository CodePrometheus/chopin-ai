import { canonicalJson, createEvolutionEvent } from "./events.js";
import {
  artifactVersionId,
  assertCapabilityManifest,
  capabilityManifestDigest,
  capabilityPermissionDigest,
  capabilityProvidesDigest,
  capabilitySurfaceDigest,
  InvalidCapabilityManifestError,
} from "./manifest.js";
import {
  assertApprovalReceipt,
  assertDeploymentReceipt,
  assertDeploymentRequest,
  assertReceiptMatchesArtifact,
  assertVerificationReceipt,
} from "./receipts.js";
import { assertFeedbackWindow, evaluateFeedbackWindow } from "./feedback.js";
import { automaticCapabilityDenial, automaticRetryAvailable } from "./policy.js";
import type {
  ApprovalReceipt,
  ArtifactExposureData,
  ArtifactProjection,
  CapabilityManifest,
  DeploymentReceipt,
  DeploymentRequest,
  EvolutionActor,
  EvolutionEvent,
  JsonObject,
  VerificationReceipt,
  FeedbackWindow,
} from "./types.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const EXPOSURE_PHASES = new Set(["selected", "injected", "tool-called", "gate-evaluated"]);

export class InvalidArtifactEventError extends Error {
  constructor(message: string) {
    super(`invalid artifact event: ${message}`);
    this.name = "InvalidArtifactEventError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const keys = new Set(expected);
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new InvalidArtifactEventError(`${path}.${key} is not allowed`);
  for (const key of expected) if (!Object.hasOwn(value, key)) throw new InvalidArtifactEventError(`${path}.${key} is required`);
}

function digest(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new InvalidArtifactEventError(`${path} must be sha256:<hex>`);
}

function nonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new InvalidArtifactEventError(`${path} must be non-empty`);
}

export function assertArtifactDraftData(event: EvolutionEvent): void {
  if (event.type !== "artifact.drafted") throw new InvalidArtifactEventError("expected artifact.drafted");
  const data = event.data as Record<string, unknown>;
  exactKeys(data, ["manifest", "contentDigest", "manifestDigest", "surfaceDigest"], "data");
  try {
    assertCapabilityManifest(data.manifest);
  } catch (error) {
    if (error instanceof InvalidCapabilityManifestError) throw new InvalidArtifactEventError(error.message);
    throw error;
  }
  const manifest = data.manifest;
  if (event.entityId !== artifactVersionId(manifest)) throw new InvalidArtifactEventError("entityId must equal <manifest id>:<version>");
  digest(data.contentDigest, "data.contentDigest");
  digest(data.manifestDigest, "data.manifestDigest");
  digest(data.surfaceDigest, "data.surfaceDigest");
  if (data.manifestDigest !== capabilityManifestDigest(manifest)) throw new InvalidArtifactEventError("manifestDigest does not match manifest");
  if (data.surfaceDigest !== capabilitySurfaceDigest(manifest)) throw new InvalidArtifactEventError("surfaceDigest does not match manifest capability surface");
}

export function assertArtifactBuiltData(event: EvolutionEvent): void {
  if (event.type !== "artifact.built") throw new InvalidArtifactEventError("expected artifact.built");
  const data = event.data as Record<string, unknown>;
  exactKeys(data, ["contentDigest", "manifestDigest", "surfaceDigest", "sourceRevision"], "data");
  digest(data.contentDigest, "data.contentDigest");
  digest(data.manifestDigest, "data.manifestDigest");
  digest(data.surfaceDigest, "data.surfaceDigest");
  nonEmpty(data.sourceRevision, "data.sourceRevision");
}

export function assertArtifactExposureData(event: EvolutionEvent): void {
  if (event.type !== "artifact.exposure-recorded") throw new InvalidArtifactEventError("expected artifact.exposure-recorded");
  const data = event.data as Record<string, unknown>;
  const required = ["phase", "sessionId", "requestId", "contentDigest", "factsDigest", "matchedSelectors"];
  const allowed = new Set([...required, "toolName", "callId", "injectedChars", "sourceEventSeq", "contextName"]);
  for (const key of Object.keys(data)) if (!allowed.has(key)) throw new InvalidArtifactEventError(`data.${key} is not allowed`);
  for (const key of required) if (!Object.hasOwn(data, key)) throw new InvalidArtifactEventError(`data.${key} is required`);
  if (typeof data.phase !== "string" || !EXPOSURE_PHASES.has(data.phase)) throw new InvalidArtifactEventError("data.phase is unknown");
  nonEmpty(data.sessionId, "data.sessionId");
  nonEmpty(data.requestId, "data.requestId");
  digest(data.contentDigest, "data.contentDigest");
  digest(data.factsDigest, "data.factsDigest");
  if (!Array.isArray(data.matchedSelectors)) throw new InvalidArtifactEventError("data.matchedSelectors must be an array");
  const selectors = new Set<string>();
  for (const selector of data.matchedSelectors) {
    nonEmpty(selector, "data.matchedSelectors[]");
    if (selectors.has(selector)) throw new InvalidArtifactEventError(`duplicate matched selector ${selector}`);
    selectors.add(selector);
  }
  if (data.toolName !== undefined) nonEmpty(data.toolName, "data.toolName");
  if (data.callId !== undefined) nonEmpty(data.callId, "data.callId");
  if (data.contextName !== undefined) nonEmpty(data.contextName, "data.contextName");
  if (data.injectedChars !== undefined && (!Number.isSafeInteger(data.injectedChars) || (data.injectedChars as number) < 0)) {
    throw new InvalidArtifactEventError("data.injectedChars must be a non-negative safe integer");
  }
  if (data.sourceEventSeq !== undefined && (!Number.isSafeInteger(data.sourceEventSeq) || (data.sourceEventSeq as number) < 0)) {
    throw new InvalidArtifactEventError("data.sourceEventSeq must be a non-negative safe integer");
  }
  if ((data.phase === "tool-called" || data.phase === "gate-evaluated") && data.toolName === undefined) {
    throw new InvalidArtifactEventError(`${data.phase} requires toolName`);
  }
}

export function assertArtifactReasonData(event: EvolutionEvent): void {
  if (event.type !== "artifact.quarantined" && event.type !== "artifact.retired" && event.type !== "artifact.rejected") {
    throw new InvalidArtifactEventError("expected artifact reason event");
  }
  const data = event.data as Record<string, unknown>;
  exactKeys(data, ["reason", "evidenceRefs"], "data");
  nonEmpty(data.reason, "data.reason");
  if (!Array.isArray(data.evidenceRefs)) throw new InvalidArtifactEventError("data.evidenceRefs must be an array");
  const refs = new Set<string>();
  for (const ref of data.evidenceRefs) {
    nonEmpty(ref, "data.evidenceRefs[]");
    if (refs.has(ref)) throw new InvalidArtifactEventError(`duplicate evidence ref ${ref}`);
    refs.add(ref);
  }
}

function receiptData(event: EvolutionEvent): unknown {
  const data = event.data as Record<string, unknown>;
  exactKeys(data, ["receipt"], "data");
  return data.receipt;
}

function artifactIdentity(artifact: ArtifactProjection) {
  return {
    artifactId: artifact.id,
    contentDigest: artifact.contentDigest,
    manifestDigest: artifact.manifestDigest,
    surfaceDigest: artifact.surfaceDigest,
  };
}

function assertVerificationEvent(event: EvolutionEvent, artifact: ArtifactProjection): VerificationReceipt {
  const receipt = receiptData(event);
  assertVerificationReceipt(receipt);
  assertReceiptMatchesArtifact(receipt, artifactIdentity(artifact), "verification event");
  if (artifact.sourceRevision === undefined || receipt.sourceRevision !== artifact.sourceRevision) {
    throw new InvalidArtifactEventError("verification sourceRevision differs from built artifact");
  }
  if (event.type === "artifact.verified" && receipt.verdict !== "pass") throw new InvalidArtifactEventError("artifact.verified requires pass receipt");
  if (event.type === "artifact.verification-failed" && receipt.verdict === "pass") throw new InvalidArtifactEventError("artifact.verification-failed cannot carry pass receipt");
  return receipt;
}

function assertApprovalEvent(event: EvolutionEvent, artifact: ArtifactProjection): ApprovalReceipt {
  const receipt = receiptData(event);
  assertApprovalReceipt(receipt);
  assertReceiptMatchesArtifact(receipt, artifactIdentity(artifact), "approval event");
  if (receipt.permissionDigest !== capabilityPermissionDigest(artifact.manifest)) {
    throw new InvalidArtifactEventError("approval permissionDigest differs from manifest");
  }
  if (receipt.capabilityDigest !== capabilityProvidesDigest(artifact.manifest)) {
    throw new InvalidArtifactEventError("approval capabilityDigest differs from manifest provides");
  }
  if (receipt.decision !== "allowed-once") throw new InvalidArtifactEventError("artifact.approved requires allowed-once receipt");
  if (receipt.policy !== undefined) {
    if (event.actor?.kind !== "system" || event.actor.id !== "host-policy") throw new InvalidArtifactEventError("policy authorization requires the host policy actor");
    const denial = automaticCapabilityDenial(artifact.manifest);
    if (denial !== undefined) throw new InvalidArtifactEventError(denial);
  }
  return receipt;
}

function expectedDeploymentMode(event: EvolutionEvent): DeploymentReceipt["mode"] {
  if (event.type === "artifact.installed-disabled") return "disabled";
  if (event.type === "artifact.canary-active") return "canary";
  if (event.type === "artifact.active") return "active";
  if (event.type === "artifact.rolled-back") return "rollback";
  throw new InvalidArtifactEventError(`${event.type} is not a deployment event`);
}

function assertDeploymentEvent(event: EvolutionEvent, artifact: ArtifactProjection): DeploymentReceipt {
  const receipt = receiptData(event);
  assertDeploymentReceipt(receipt);
  assertReceiptMatchesArtifact(receipt, artifactIdentity(artifact), "deployment event");
  const expected = expectedDeploymentMode(event);
  if (receipt.mode !== expected) throw new InvalidArtifactEventError(`${event.type} requires ${expected} deployment receipt`);
  if (receipt.health !== "pass") throw new InvalidArtifactEventError(`${event.type} requires passing deployment health`);
  const request = artifact.deploymentRequests.find((item) => item.requestId === receipt.operationId);
  if (request === undefined) throw new InvalidArtifactEventError(`${event.type} has no matching deployment request`);
  if (request.mode !== receipt.mode || request.targetGeneration !== receipt.processGeneration) {
    throw new InvalidArtifactEventError("deployment receipt does not match requested mode/generation");
  }
  if (canonicalJson(request.rollbackTarget ?? null) !== canonicalJson(receipt.rollbackTarget ?? null)) {
    throw new InvalidArtifactEventError("deployment receipt rollback target differs from request");
  }
  const expectedSurface = receipt.mode === "rollback" ? receipt.rollbackTarget?.surfaceDigest : artifact.surfaceDigest;
  if (expectedSurface === undefined || receipt.loadedSurfaceDigest !== expectedSurface) {
    throw new InvalidArtifactEventError("loaded surface differs from approved deployment target");
  }
  return receipt;
}

function appendReceipt<T extends { receiptId: string }>(existing: readonly T[], receipt: T, artifactId: string): T[] {
  const previous = existing.find((item) => item.receiptId === receipt.receiptId);
  if (previous !== undefined && canonicalJson(previous) !== canonicalJson(receipt)) {
    throw new InvalidArtifactEventError(`${artifactId} receipt ${receipt.receiptId} changed content`);
  }
  return previous === undefined ? [...existing, receipt] : [...existing];
}

interface ArtifactEventMeta {
  eventId?: string;
  occurredAt?: string;
  artifactId: string;
  actor?: EvolutionActor;
}

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function artifactDrafted(meta: ArtifactEventMeta, input: {
  manifest: CapabilityManifest;
  contentDigest: string;
  manifestDigest?: string;
  surfaceDigest?: string;
}): EvolutionEvent {
  const event = createEvolutionEvent({
    eventId: meta.eventId,
    occurredAt: meta.occurredAt,
    entityKind: "artifact",
    entityId: meta.artifactId,
    type: "artifact.drafted",
    actor: meta.actor,
    data: jsonObject({
      manifest: input.manifest,
      contentDigest: input.contentDigest,
      manifestDigest: input.manifestDigest ?? capabilityManifestDigest(input.manifest),
      surfaceDigest: input.surfaceDigest ?? capabilitySurfaceDigest(input.manifest),
    }),
  });
  assertArtifactDraftData(event);
  return event;
}

export function artifactBuilt(meta: ArtifactEventMeta, input: {
  contentDigest: string;
  manifestDigest: string;
  surfaceDigest: string;
  sourceRevision: string;
}): EvolutionEvent {
  const event = createEvolutionEvent({
    eventId: meta.eventId,
    occurredAt: meta.occurredAt,
    entityKind: "artifact",
    entityId: meta.artifactId,
    type: "artifact.built",
    actor: meta.actor,
    data: jsonObject(input),
  });
  assertArtifactBuiltData(event);
  return event;
}

export function artifactExposureRecorded(meta: ArtifactEventMeta, input: ArtifactExposureData): EvolutionEvent {
  const event = createEvolutionEvent({
    eventId: meta.eventId,
    occurredAt: meta.occurredAt,
    entityKind: "artifact",
    entityId: meta.artifactId,
    type: "artifact.exposure-recorded",
    actor: meta.actor,
    data: jsonObject(input),
  });
  assertArtifactExposureData(event);
  return event;
}

function receiptEvent(meta: ArtifactEventMeta, type: EvolutionEvent["type"], receipt: unknown): EvolutionEvent {
  return createEvolutionEvent({
    eventId: meta.eventId,
    occurredAt: meta.occurredAt,
    entityKind: "artifact",
    entityId: meta.artifactId,
    type,
    actor: meta.actor,
    data: jsonObject({ receipt }),
  });
}

export function artifactVerificationFailed(meta: ArtifactEventMeta, receipt: VerificationReceipt): EvolutionEvent {
  assertVerificationReceipt(receipt);
  if (receipt.verdict === "pass") throw new InvalidArtifactEventError("verification failure cannot carry pass receipt");
  return receiptEvent(meta, "artifact.verification-failed", receipt);
}

export function artifactVerified(meta: ArtifactEventMeta, receipt: VerificationReceipt): EvolutionEvent {
  assertVerificationReceipt(receipt);
  if (receipt.verdict !== "pass") throw new InvalidArtifactEventError("verified artifact requires pass receipt");
  return receiptEvent(meta, "artifact.verified", receipt);
}

export function artifactApproved(meta: ArtifactEventMeta, receipt: ApprovalReceipt): EvolutionEvent {
  assertApprovalReceipt(receipt);
  if (receipt.decision !== "allowed-once") throw new InvalidArtifactEventError("approved artifact requires allowed-once receipt");
  return receiptEvent(meta, "artifact.approved", receipt);
}

export function artifactInstalledDisabled(meta: ArtifactEventMeta, receipt: DeploymentReceipt): EvolutionEvent {
  return receiptEvent(meta, "artifact.installed-disabled", receipt);
}

export function artifactCanaryActivated(meta: ArtifactEventMeta, receipt: DeploymentReceipt): EvolutionEvent {
  return receiptEvent(meta, "artifact.canary-active", receipt);
}

export function artifactActivated(meta: ArtifactEventMeta, receipt: DeploymentReceipt): EvolutionEvent {
  return receiptEvent(meta, "artifact.active", receipt);
}

export function artifactRolledBack(meta: ArtifactEventMeta, receipt: DeploymentReceipt): EvolutionEvent {
  return receiptEvent(meta, "artifact.rolled-back", receipt);
}

export function artifactDeploymentRequested(meta: ArtifactEventMeta, request: DeploymentRequest): EvolutionEvent {
  assertDeploymentRequest(request);
  return createEvolutionEvent({
    eventId: meta.eventId,
    occurredAt: meta.occurredAt,
    entityKind: "artifact",
    entityId: meta.artifactId,
    type: "artifact.deployment-requested",
    actor: meta.actor,
    data: jsonObject({ request }),
  });
}

export function artifactRuntimeLoaded(meta: ArtifactEventMeta, receipt: DeploymentReceipt): EvolutionEvent {
  return receiptEvent(meta, "artifact.runtime-loaded", receipt);
}

export function artifactDeploymentFailed(meta: ArtifactEventMeta, receipt: DeploymentReceipt): EvolutionEvent {
  if (receipt.health !== "fail") throw new InvalidArtifactEventError("deployment failure requires failed health receipt");
  return receiptEvent(meta, "artifact.deployment-failed", receipt);
}

function reasonEvent(meta: ArtifactEventMeta, type: EvolutionEvent["type"], reason: string, evidenceRefs: string[] = []): EvolutionEvent {
  nonEmpty(reason, "reason");
  if (evidenceRefs.some((value) => value.trim() === "")) throw new InvalidArtifactEventError("evidenceRefs must be non-empty strings");
  const event = createEvolutionEvent({
    eventId: meta.eventId,
    occurredAt: meta.occurredAt,
    entityKind: "artifact",
    entityId: meta.artifactId,
    type,
    actor: meta.actor,
    data: { reason, evidenceRefs },
  });
  assertArtifactReasonData(event);
  return event;
}

export function feedbackDeploymentReceipt(artifact: ArtifactProjection): DeploymentReceipt | undefined {
  if (!artifact.enabled) return undefined;
  const receiptId = artifact.feedbackDeploymentReceiptId;
  if (receiptId === undefined) return undefined;
  const mode = artifact.state === "canary-active"
    ? "canary"
    : artifact.state === "active" || artifact.state === "retired"
      ? "active"
      : undefined;
  if (mode === undefined) return undefined;
  return artifact.deploymentReceipts.find((receipt) =>
    receipt.receiptId === receiptId && receipt.mode === mode && receipt.health === "pass");
}

function assertFeedbackMatchesCurrentDeployment(window: FeedbackWindow, artifact: ArtifactProjection): void {
  if (window.intendedEffect !== artifact.manifest.intendedEffect) {
    throw new InvalidArtifactEventError("feedback intendedEffect differs from manifest");
  }
  const deployment = feedbackDeploymentReceipt(artifact);
  if (deployment === undefined || deployment.receiptId !== window.deploymentReceiptId) {
    throw new InvalidArtifactEventError("feedback window does not reference the current successful deployment");
  }
}

export function artifactQuarantined(meta: ArtifactEventMeta, reason: string, evidenceRefs: string[] = []): EvolutionEvent {
  return reasonEvent(meta, "artifact.quarantined", reason, evidenceRefs);
}

export function artifactRetired(meta: ArtifactEventMeta, reason: string): EvolutionEvent {
  return reasonEvent(meta, "artifact.retired", reason);
}

export function artifactRejected(meta: ArtifactEventMeta, reason: string): EvolutionEvent {
  return reasonEvent(meta, "artifact.rejected", reason);
}

export function applyArtifactData(
  previous: ArtifactProjection | undefined,
  event: EvolutionEvent,
): Omit<ArtifactProjection, "state" | "stateChangedAt" | "stateChangedEventIndex" | "eventCount" | "firstEventId" | "lastEventId" | "updatedAt"> {
  if (event.type === "artifact.drafted") {
    assertArtifactDraftData(event);
    const data = event.data as unknown as {
      manifest: CapabilityManifest;
      contentDigest: string;
      manifestDigest: string;
      surfaceDigest: string;
    };
    return {
      id: event.entityId,
      ...data,
      exposures: { selected: 0, injected: 0, "tool-called": 0, "gate-evaluated": 0 },
      trust: "untrusted",
      enabled: false,
      verificationReceipts: [],
      approvalReceipts: [],
      deploymentReceipts: [],
      deploymentRequests: [],
      feedbackWindows: [],
    };
  }
  if (previous === undefined) throw new InvalidArtifactEventError(`${event.type} has no drafted artifact`);
  const withoutFeedbackDeployment = () => {
    const { feedbackDeploymentReceiptId: _feedbackDeploymentReceiptId, ...rest } = previous;
    return rest;
  };
  if (event.type === "artifact.built") {
    assertArtifactBuiltData(event);
    const data = event.data as unknown as { contentDigest: string; manifestDigest: string; surfaceDigest: string; sourceRevision: string };
    if (data.contentDigest !== previous.contentDigest || data.manifestDigest !== previous.manifestDigest || data.surfaceDigest !== previous.surfaceDigest) {
      throw new InvalidArtifactEventError("built digests differ from drafted artifact");
    }
    return { ...previous, sourceRevision: data.sourceRevision };
  }
  if (event.type === "artifact.verification-failed" || event.type === "artifact.verified") {
    const receipt = assertVerificationEvent(event, previous);
    return {
      ...previous,
      verificationReceipts: appendReceipt(previous.verificationReceipts, receipt, previous.id),
      trust: event.type === "artifact.verified" ? "verified" : previous.trust,
    };
  }
  if (event.type === "artifact.approved") {
    const receipt = assertApprovalEvent(event, previous);
    return {
      ...previous,
      approvalReceipts: appendReceipt(previous.approvalReceipts, receipt, previous.id),
      trust: "approved",
    };
  }
  if (event.type === "artifact.installed-disabled" || event.type === "artifact.canary-active" || event.type === "artifact.active" || event.type === "artifact.rolled-back") {
    const receipt = assertDeploymentEvent(event, previous);
    const base = event.type === "artifact.canary-active" || event.type === "artifact.active"
      ? previous
      : withoutFeedbackDeployment();
    return {
      ...base,
      deploymentReceipts: appendReceipt(previous.deploymentReceipts, receipt, previous.id),
      enabled: event.type === "artifact.canary-active" || event.type === "artifact.active",
      trust: event.type === "artifact.canary-active" || event.type === "artifact.active" ? "provisional" : previous.trust,
      ...(event.type === "artifact.canary-active" || event.type === "artifact.active"
        ? { feedbackDeploymentReceiptId: receipt.receiptId }
        : {}),
    };
  }
  if (event.type === "artifact.deployment-requested") {
    const data = event.data as Record<string, unknown>;
    exactKeys(data, ["request"], "data");
    assertDeploymentRequest(data.request);
    const request = data.request as DeploymentRequest;
    assertReceiptMatchesArtifact(request, artifactIdentity(previous), "deployment request");
    if (!previous.approvalReceipts.some((receipt) => receipt.receiptId === request.approvalReceiptId)) {
      throw new InvalidArtifactEventError("deployment request references unknown approval receipt");
    }
    const expectedMode = previous.state === "approved"
      ? "disabled"
      : previous.state === "installed-disabled"
        ? "canary"
        : previous.state === "canary-active"
          ? "active"
          : previous.state === "quarantined"
            ? "rollback"
            : undefined;
    if (request.mode !== expectedMode) throw new InvalidArtifactEventError(`cannot request ${request.mode} from ${previous.state}`);
    const existing = previous.deploymentRequests.find((item) => item.requestId === request.requestId);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(request)) {
      throw new InvalidArtifactEventError(`deployment request ${request.requestId} changed content`);
    }
    if (existing === undefined) {
      if (previous.deploymentRequests.some((item) => !previous.deploymentReceipts.some((receipt) => receipt.operationId === item.requestId))) {
        throw new InvalidArtifactEventError("artifact already has an open deployment request");
      }
      const lastRequest = previous.deploymentRequests.findLast((item) => item.mode === request.mode);
      const failure = lastRequest === undefined ? undefined : previous.deploymentReceipts.find((receipt) => receipt.operationId === lastRequest.requestId);
      if (lastRequest !== undefined && failure?.health !== "fail") {
        throw new InvalidArtifactEventError("deployment request cannot repeat a completed successful operation");
      }
      if (failure === undefined && request.retryOf !== undefined) {
        throw new InvalidArtifactEventError("deployment retry has no preceding failure");
      }
      if (failure !== undefined) {
        const approval = request.retryApproval;
        if (request.retryOf !== failure.receiptId || approval === undefined) {
          throw new InvalidArtifactEventError("deployment retry requires approval for the latest exact failure");
        }
        if (canonicalJson(request.rollbackTarget ?? null) !== canonicalJson(lastRequest?.rollbackTarget ?? null)) {
          throw new InvalidArtifactEventError("deployment retry rollback target differs from the failed request");
        }
        assertReceiptMatchesArtifact(approval, artifactIdentity(previous), "deployment retry approval");
        if (approval.policy !== undefined && !automaticRetryAvailable(previous, request.mode)) {
          throw new InvalidArtifactEventError("automatic retry budget exhausted");
        }
        if (approval.permissionDigest !== capabilityPermissionDigest(previous.manifest)
          || approval.capabilityDigest !== capabilityProvidesDigest(previous.manifest)
          || approval.decision !== "allowed-once") {
          throw new InvalidArtifactEventError("deployment retry approval does not authorize the exact capability");
        }
        if (event.actor?.kind !== "system" || event.actor.id !== "chopin-deployment-retry"
          || (approval.policy === undefined ? approval.actor !== "host-approval-seam" : automaticCapabilityDenial(previous.manifest) !== undefined)) {
          throw new InvalidArtifactEventError("deployment retry approval must be recorded by the host approval seam");
        }
        if (Date.parse(approval.decidedAt) < Date.parse(failure.endedAt)
          || Date.parse(approval.decidedAt) > Date.parse(request.requestedAt)) {
          throw new InvalidArtifactEventError("deployment retry approval must follow its failure and precede its request");
        }
        const usedApprovals = [...previous.approvalReceipts, ...previous.deploymentRequests.flatMap((item) => item.retryApproval === undefined ? [] : [item.retryApproval])];
        if (usedApprovals.some((item) => item.receiptId === approval.receiptId
          || (approval.approvalAuditId !== undefined && item.approvalAuditId === approval.approvalAuditId))) {
          throw new InvalidArtifactEventError("deployment retry approval has already been used");
        }
      }
    }
    return { ...previous, deploymentRequests: existing === undefined ? [...previous.deploymentRequests, request] : previous.deploymentRequests };
  }
  if (event.type === "artifact.runtime-loaded") {
    const receipt = receiptData(event);
    assertDeploymentReceipt(receipt);
    assertReceiptMatchesArtifact(receipt, artifactIdentity(previous), "runtime load");
    if (receipt.health !== "pass" || (receipt.mode !== "canary" && receipt.mode !== "active")) {
      throw new InvalidArtifactEventError("runtime-loaded requires passing canary or active receipt");
    }
    if (receipt.loadedSurfaceDigest !== previous.surfaceDigest) throw new InvalidArtifactEventError("runtime loaded surface drifted");
    const allowedState = receipt.mode === "canary"
      ? previous.state === "canary-active"
      : previous.state === "active" || previous.state === "retired";
    if (!allowedState) {
      throw new InvalidArtifactEventError(`cannot record ${receipt.mode} runtime load while artifact is ${previous.state}`);
    }
    return {
      ...previous,
      deploymentReceipts: appendReceipt(previous.deploymentReceipts, receipt, previous.id),
      feedbackDeploymentReceiptId: previous.feedbackDeploymentReceiptId ?? receipt.receiptId,
      trust: previous.feedbackDeploymentReceiptId === undefined ? "provisional" : previous.trust,
    };
  }
  if (event.type === "artifact.deployment-failed") {
    const receipt = receiptData(event);
    assertDeploymentReceipt(receipt);
    assertReceiptMatchesArtifact(receipt, artifactIdentity(previous), "deployment failure");
    if (receipt.health !== "fail") throw new InvalidArtifactEventError("deployment-failed requires failed health");
    const request = previous.deploymentRequests.find((item) => item.requestId === receipt.operationId);
    if (request === undefined || request.mode !== receipt.mode || request.targetGeneration !== receipt.processGeneration) {
      throw new InvalidArtifactEventError("deployment failure does not match a request");
    }
    return { ...previous, deploymentReceipts: appendReceipt(previous.deploymentReceipts, receipt, previous.id) };
  }
  if (event.type === "artifact.quarantined") {
    assertArtifactReasonData(event);
    return { ...withoutFeedbackDeployment(), trust: "quarantined", enabled: false };
  }
  if (event.type === "artifact.retired") {
    assertArtifactReasonData(event);
    return { ...withoutFeedbackDeployment(), trust: "retired", enabled: false };
  }
  if (event.type === "artifact.rejected") {
    assertArtifactReasonData(event);
    return { ...withoutFeedbackDeployment(), enabled: false };
  }
  if (event.type === "artifact.exposure-recorded") {
    assertArtifactExposureData(event);
    const exposure = event.data as unknown as ArtifactExposureData;
    if (exposure.contentDigest !== previous.contentDigest) throw new InvalidArtifactEventError("exposure contentDigest differs from artifact");
    return {
      ...previous,
      exposures: { ...previous.exposures, [exposure.phase]: previous.exposures[exposure.phase] + 1 },
      lastExposureAt: event.occurredAt,
    };
  }
  if (event.type === "artifact.feedback-recorded") {
    const data = event.data as Record<string, unknown>;
    exactKeys(data, ["window"], "data");
    assertFeedbackWindow(data.window);
    const window = data.window as FeedbackWindow;
    if (window.artifactId !== previous.id || window.contentDigest !== previous.contentDigest) {
      throw new InvalidArtifactEventError("feedback window does not match artifact");
    }
    assertFeedbackMatchesCurrentDeployment(window, previous);
    const existing = previous.feedbackWindows.find((item) => item.windowId === window.windowId);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(window)) {
      throw new InvalidArtifactEventError(`feedback window ${window.windowId} changed content`);
    }
    return { ...previous, feedbackWindows: existing === undefined ? [...previous.feedbackWindows, window] : previous.feedbackWindows };
  }
  if (event.type === "artifact.trusted" || event.type === "artifact.demoted") {
    const data = event.data as Record<string, unknown>;
    const allowed = event.type === "artifact.trusted" ? ["windowId"] : ["windowId", "reason"];
    exactKeys(data, allowed, "data");
    nonEmpty(data.windowId, "data.windowId");
    if (event.type === "artifact.demoted") nonEmpty(data.reason, "data.reason");
    const window = previous.feedbackWindows.find((item) => item.windowId === data.windowId);
    if (window === undefined) throw new InvalidArtifactEventError(`unknown feedback window ${String(data.windowId)}`);
    assertFeedbackMatchesCurrentDeployment(window, previous);
    const verdict = evaluateFeedbackWindow(window);
    if (event.type === "artifact.trusted" && verdict !== "confirm") throw new InvalidArtifactEventError(`feedback verdict is ${verdict}, not confirm`);
    if (event.type === "artifact.demoted" && verdict !== "contradict") throw new InvalidArtifactEventError(`feedback verdict is ${verdict}, not contradict`);
    return { ...previous, trust: event.type === "artifact.trusted" ? "trusted" : "provisional" };
  }
  return {
    id: previous.id,
    manifest: previous.manifest,
    contentDigest: previous.contentDigest,
    manifestDigest: previous.manifestDigest,
    surfaceDigest: previous.surfaceDigest,
    exposures: previous.exposures,
    trust: previous.trust,
    enabled: previous.enabled,
    verificationReceipts: previous.verificationReceipts,
    approvalReceipts: previous.approvalReceipts,
    deploymentReceipts: previous.deploymentReceipts,
    deploymentRequests: previous.deploymentRequests,
    feedbackWindows: previous.feedbackWindows,
    ...(previous.feedbackDeploymentReceiptId === undefined ? {} : { feedbackDeploymentReceiptId: previous.feedbackDeploymentReceiptId }),
    ...(previous.sourceRevision === undefined ? {} : { sourceRevision: previous.sourceRevision }),
    ...(previous.lastExposureAt === undefined ? {} : { lastExposureAt: previous.lastExposureAt }),
  };
}
