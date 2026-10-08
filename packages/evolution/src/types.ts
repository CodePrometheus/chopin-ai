import type { ExecutionContext } from "./execution-context.js";

/** The JSONL event log accepts only values that serialize to JSON losslessly. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export const EVOLUTION_EVENT_SCHEMA_VERSION = 1 as const;

export const CANDIDATE_EVENT_TYPES = [
  "candidate.observed",
  "candidate.corroborated",
  "candidate.classified",
  "candidate.resolved",
  "candidate.rejected",
  "candidate.merged",
] as const;

export const ARTIFACT_EVENT_TYPES = [
  "artifact.drafted",
  "artifact.built",
  "artifact.verification-failed",
  "artifact.verified",
  "artifact.approved",
  "artifact.installed-disabled",
  "artifact.deployment-requested",
  "artifact.deployment-failed",
  "artifact.canary-active",
  "artifact.active",
  "artifact.quarantined",
  "artifact.rolled-back",
  "artifact.retired",
  "artifact.rejected",
  "artifact.trusted",
  "artifact.demoted",
  "artifact.runtime-loaded",
  "artifact.exposure-recorded",
  "artifact.feedback-recorded",
] as const;

export type CandidateEventType = (typeof CANDIDATE_EVENT_TYPES)[number];
export type ArtifactEventType = (typeof ARTIFACT_EVENT_TYPES)[number];
export type EvolutionEventType = CandidateEventType | ArtifactEventType | "improvement.planned" | "context.selection-recorded";
export type EvolutionEntityKind = "candidate" | "artifact" | "improvement" | "context-selection";
export type EvolutionActorKind = "system" | "user" | "agent" | "import";

export const CANDIDATE_EVIDENCE_CLASSES = [
  "user-correction",
  "user-request",
  "task-completion",
  "session-signal",
  "host-verification",
  "gate-receipt",
  "tool-receipt",
  "assistant-claim",
  "contrast",
] as const;
export type CandidateEvidenceClass = (typeof CANDIDATE_EVIDENCE_CLASSES)[number];

export const ARTIFACT_KINDS = ["memory", "skill", "gate", "tool", "plugin"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type ArtifactEffect = "advisory" | "preventive";
export type CapabilityRuntime = "data" | "dsh-plugin" | "mcp";
export type ArtifactExposurePhase = "selected" | "injected" | "tool-called" | "gate-evaluated";

export interface ArtifactExposureData {
  phase: ArtifactExposurePhase;
  sessionId: string;
  requestId: string;
  contentDigest: string;
  factsDigest: string;
  matchedSelectors: string[];
  toolName?: string;
  callId?: string;
  injectedChars?: number;
  sourceEventSeq?: number;
  contextName?: string;
}

export interface ArtifactExposureCounts {
  selected: number;
  injected: number;
  "tool-called": number;
  "gate-evaluated": number;
}

export interface CapabilityProvides {
  contexts: string[];
  skills: string[];
  guards: string[];
  tools: string[];
  services: string[];
  workflows: string[];
}

export interface CapabilityDependency {
  id: string;
  version: string;
}

export interface ArtifactReference {
  artifactId: string;
  contentDigest: string;
  surfaceDigest: string;
}

export interface CapabilityLineage {
  candidateIds: string[];
  proposalIds: string[];
  supersedes?: ArtifactReference;
  rollbackTo?: ArtifactReference;
  improvementId?: string;
}

export interface CapabilityManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  kind: ArtifactKind;
  runtime: CapabilityRuntime;
  intendedEffect: ArtifactEffect;
  summary: string;
  entry: string;
  trigger: ApplicabilityTrigger;
  provides: CapabilityProvides;
  permissions: string[];
  dependencies: CapabilityDependency[];
  conflicts: string[];
  requires: {
    chopinPluginApi: string;
    dsh?: string;
  };
  lineage: CapabilityLineage;
}

export interface CapabilityContextFixture {
  id: string;
  kind: "context";
  name: string;
  input: { workspace: string; prompt: string; environment?: ExecutionContext };
  expect: { equals: string } | { contains: string } | { maxChars: number };
}

export interface CapabilityGuardFixture {
  id: string;
  kind: "guard";
  name: string;
  input: {
    toolName: string;
    arguments: JsonObject;
    successfulCalls: Array<{ name: string; arguments: JsonObject }>;
    environment?: ExecutionContext;
  };
  expect: { decision: string | null };
}

export interface CapabilityDispatch {
  tools: string[];
  maxSteps: number;
}

export interface CapabilityDispatchStep {
  tool: string;
  arguments: JsonObject;
  value: JsonValue;
}

export type CapabilityDispatchDecision =
  | { kind: "call"; tool: string; arguments: JsonObject }
  | { kind: "done"; value: JsonValue };

export interface CapabilityToolFixture {
  id: string;
  kind: "tool";
  name: string;
  input: { callId: string; arguments: JsonObject; environment?: ExecutionContext; steps?: CapabilityDispatchStep[] };
  expect: { equals: JsonValue };
}

export type CapabilityFixtureCase = CapabilityContextFixture | CapabilityGuardFixture | CapabilityToolFixture;

export interface CapabilityFixtureSuite {
  schemaVersion: 1;
  cases: CapabilityFixtureCase[];
}

export interface CandidateEvidence {
  evidenceId: string;
  class: CandidateEvidenceClass;
  independenceKey: string;
  independentUnits: number;
  observedAt: string;
  contentHash: string;
  summary: string;
  sourceSessionId?: string;
  sourceAttemptId?: string;
  sourceRef?: string;
}

export interface ApplicabilityTrigger {
  /**
   * Natural-language trigger, phrased as "action + surface" (e.g. "deploying to staging or creating a deploy branch").
   * Structured fields do the hard filtering; this one is left to the model to judge against the current task at the start of work.
   */
  when?: string;
  repos?: string[];
  taskKinds?: string[];
  pathGlobs?: string[];
  tools?: string[];
  errorKeys?: string[];
  languages?: string[];
  environments?: string[];
}

export interface CandidateBoundaries {
  includes: string[];
  excludes: string[];
}

export interface ArtifactProposal {
  proposalId: string;
  kind: ArtifactKind;
  intendedEffect: ArtifactEffect;
  summary: string;
  trigger: ApplicabilityTrigger;
  requiredPermissions: string[];
  improvementId?: string;
}

export type ProposalOutcome =
  | {
      proposalId: string;
      status: "activated";
      artifactId: string;
      contentDigest: string;
      deploymentEventId: string;
    }
  | {
      proposalId: string;
      status: "rejected";
      reason: string;
    };

export interface EvolutionActor {
  kind: EvolutionActorKind;
  id?: string;
}

/** The stable envelope of every JSONL line; all domain content goes in data. */
export interface EvolutionEvent {
  schemaVersion: typeof EVOLUTION_EVENT_SCHEMA_VERSION;
  eventId: string;
  occurredAt: string;
  entityKind: EvolutionEntityKind;
  entityId: string;
  type: EvolutionEventType;
  data: JsonObject;
  actor?: EvolutionActor;
}

export type CandidateState = "observed" | "corroborated" | "classified" | "resolved" | "rejected" | "merged";
export type ArtifactState =
  | "draft"
  | "built"
  | "verified"
  | "approved"
  | "installed-disabled"
  | "canary-active"
  | "active"
  | "quarantined"
  | "rolled-back"
  | "retired"
  | "rejected";
export type ArtifactTrust = "untrusted" | "verified" | "approved" | "provisional" | "trusted" | "quarantined" | "retired";

export type VerificationCheckKind = "schema" | "content" | "syntax" | "contract" | "composition" | "e2e";
export type VerificationCheckStatus = "pass" | "fail" | "skipped";
export type VerificationVerdict = "pass" | "fail" | "inconclusive";

export interface VerificationCheck {
  name: string;
  kind: VerificationCheckKind;
  status: VerificationCheckStatus;
  startedAt: string;
  endedAt: string;
  command?: string[];
  exitCode?: number;
  detail?: string;
}

export interface VerificationReceipt {
  receiptId: string;
  artifactId: string;
  contentDigest: string;
  manifestDigest: string;
  surfaceDigest: string;
  sourceRevision: string;
  fixtureDigest: string;
  policyId: string;
  policyVersion: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  verdict: VerificationVerdict;
  checks: VerificationCheck[];
  environment: {
    chopinVersion: string;
    dshVersion: string;
    nodeVersion: string;
    platform: string;
    arch: string;
  };
  durableOutputRef: string;
  durableOutputHash: string;
}

export interface ApprovalReceipt {
  receiptId: string;
  artifactId: string;
  contentDigest: string;
  manifestDigest: string;
  surfaceDigest: string;
  permissionDigest: string;
  capabilityDigest: string;
  decision: "allowed-once" | "rejected" | "cancelled" | "unavailable";
  actor: string;
  sessionId?: string;
  approvalAuditId?: string;
  policy?: { id: string; digest: string };
  decidedAt: string;
}

export type DeploymentMode = "disabled" | "canary" | "active" | "rollback";
export interface DeploymentReceipt {
  receiptId: string;
  artifactId: string;
  contentDigest: string;
  manifestDigest: string;
  surfaceDigest: string;
  mode: DeploymentMode;
  operationId: string;
  processGeneration: string;
  dshVersion: string;
  chopinVersion: string;
  loadedSurfaceDigest: string;
  health: "pass" | "fail";
  startedAt: string;
  endedAt: string;
  rollbackTarget?: ArtifactReference;
  detail?: string;
}

export interface DeploymentRequest {
  requestId: string;
  artifactId: string;
  contentDigest: string;
  manifestDigest: string;
  surfaceDigest: string;
  mode: DeploymentMode;
  targetGeneration: string;
  approvalReceiptId: string;
  requestedAt: string;
  requestedBy: string;
  rollbackTarget?: ArtifactReference;
  retryOf?: string;
  retryApproval?: ApprovalReceipt;
}

export interface FeedbackWindow {
  windowId: string;
  deploymentReceiptId: string;
  artifactId: string;
  contentDigest: string;
  intendedEffect: ArtifactEffect;
  startedAt: string;
  endedAt: string;
  eligible: number;
  activated: number;
  recurrence: number;
  prevented: number;
  falseTrigger: number;
  falseBlock: number;
  independentSuccesses: number;
  taskPass: number;
  taskFail: number;
  retryDelta: number;
  costDeltaUsd: number;
  latencyDeltaMs: number;
  evidenceRefs: string[];
}

export type FeedbackVerdict = "inactive" | "confirm" | "contradict" | "quarantine";

export interface CandidateProjection {
  id: string;
  state: CandidateState;
  eventCount: number;
  firstEventId: string;
  lastEventId: string;
  updatedAt: string;
  signalKey: string;
  lesson: string;
  evidence: CandidateEvidence[];
  trustedIndependentUnits: number;
  proposals: ArtifactProposal[];
  rootCause?: string;
  trigger?: ApplicabilityTrigger;
  boundaries?: CandidateBoundaries;
  outcomes?: ProposalOutcome[];
  rejectionReason?: string;
  mergedInto?: string;
}

export interface ArtifactProjection {
  id: string;
  state: ArtifactState;
  /** Timestamp of the event that most recently changed `state`; non-state receipts do not move it. */
  stateChangedAt: string;
  /** One-based position of that state transition in the authoritative JSONL history. */
  stateChangedEventIndex: number;
  eventCount: number;
  firstEventId: string;
  lastEventId: string;
  updatedAt: string;
  manifest: CapabilityManifest;
  contentDigest: string;
  manifestDigest: string;
  surfaceDigest: string;
  sourceRevision?: string;
  exposures: ArtifactExposureCounts;
  lastExposureAt?: string;
  trust: ArtifactTrust;
  enabled: boolean;
  verificationReceipts: VerificationReceipt[];
  approvalReceipts: ApprovalReceipt[];
  deploymentReceipts: DeploymentReceipt[];
  deploymentRequests: DeploymentRequest[];
  /** The exact deployment/runtime-load receipt currently allowed to carry new feedback windows. */
  feedbackDeploymentReceiptId?: string;
  feedbackWindows: FeedbackWindow[];
}

export interface EvolutionProjection {
  schemaVersion: typeof EVOLUTION_EVENT_SCHEMA_VERSION;
  eventCount: number;
  lastEventId?: string;
  candidates: CandidateProjection[];
  artifacts: ArtifactProjection[];
  improvements?: import("./improvement.js").ImprovementRecord[];
  contextSelections?: import("./context-selection.js").ContextSelectionRecord[];
}
