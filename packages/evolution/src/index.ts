export { canonicalJson, assertEvolutionEvent, createEvolutionEvent, InvalidEvolutionEventError } from "./events.js";
export { IMPROVER_TOOL, improvementDigest, improvementPlanned, assertImprovementInput, assertImprovementPlan,
  assertImprovementRecord, baselineImprovementPlan, baselineImprover } from "./improvement.js";
export type { ImprovementInput, ImprovementPlan, ImprovementRecord, ImprovementWork, ImproverReference } from "./improvement.js";
export { assertExecutionContext } from "./execution-context.js";
export type { ExecutionContext } from "./execution-context.js";
export type { CapabilityDispatch, CapabilityDispatchStep, CapabilityDispatchDecision } from "./types.js";
export { assertCapabilityDispatch, assertDispatchDecision, dispatchInterface,
  DISPATCH_SCHEMA, DISPATCH_STEP_SCHEMA, DISPATCH_DECISION_SCHEMA } from "./dispatch-contract.js";
export { CONTEXT_SELECTOR_TOOL, baselineContextSelection, baselineContextSelector, assertContextSelectionInput,
  assertContextSelectionPlan, assertContextSelectionRecord, contextSelectionRecorded } from "./context-selection.js";
export type { ContextPlacement, ContextSelectionInput, ContextSelectionPlan, ContextSelectionRecord } from "./context-selection.js";
export {
  InvalidArtifactEventError,
  applyArtifactData,
  artifactBuilt,
  artifactActivated,
  artifactApproved,
  artifactCanaryActivated,
  artifactDrafted,
  artifactDeploymentRequested,
  artifactDeploymentFailed,
  artifactExposureRecorded,
  artifactInstalledDisabled,
  artifactQuarantined,
  artifactRejected,
  artifactRetired,
  artifactRolledBack,
  artifactRuntimeLoaded,
  artifactVerificationFailed,
  artifactVerified,
  feedbackDeploymentReceipt,
  assertArtifactBuiltData,
  assertArtifactDraftData,
  assertArtifactExposureData,
  assertArtifactReasonData,
} from "./artifact.js";
export { ArtifactStore, ArtifactStoreError } from "./artifact-store.js";
export { MANAGED_POLICY, MAX_AUTOMATIC_FIXTURES, automaticCapabilityDenial, automaticRetryAvailable } from "./policy.js";
export type { StagedArtifact } from "./artifact-store.js";
export {
  CandidateInvariantError,
  InvalidCandidateEventError,
  TRIGGER_WHEN_MAX_CHARS,
  applyCandidateData,
  candidateIdFor,
  candidateCanBeCorroborated,
  assertApplicabilityTrigger,
  assertCandidateEventData,
  assertCandidateEvidence,
  candidateClassified,
  candidateCorroborated,
  candidateMerged,
  candidateObserved,
  candidateRejected,
  candidateResolved,
  trustedIndependentUnits,
} from "./candidate.js";
export { EvolutionEventConflictError, EvolutionTransitionError, foldEvolutionEvents } from "./fold.js";
export {
  InvalidCapabilityFixtureError,
  assertCapabilityFixtureSuite,
  assertFixtureCoverage,
  capabilityFixtureDigest,
} from "./fixtures.js";
export { importLegacyPending, planLegacyPendingImport } from "./legacy.js";
export type { LegacyImportPlan, LegacyImportResult } from "./legacy.js";
export { artifactKindDistribution, renderEvolutionProjection } from "./projection.js";
export {
  InvalidFeedbackWindowError,
  artifactDemoted,
  artifactFeedbackRecorded,
  artifactTrusted,
  assertFeedbackWindow,
  evaluateFeedbackWindow,
} from "./feedback.js";
export {
  InvalidReceiptError,
  assertApprovalReceipt,
  assertDeploymentReceipt,
  assertDeploymentRequest,
  assertReceiptMatchesArtifact,
  assertVerificationReceipt,
} from "./receipts.js";
export {
  ARTIFACT_KIND_AUTHORITY_ORDER,
  CAPABILITY_MANIFEST_SCHEMA_VERSION,
  InvalidCapabilityManifestError,
  artifactVersionId,
  assertCapabilityManifest,
  capabilityManifestDigest,
  capabilityPermissionDigest,
  capabilityProvidesDigest,
  capabilitySurfaceDigest,
  compareArtifactAuthority,
  leastPowerfulArtifactKind,
} from "./manifest.js";
export { EvolutionEventStore, EvolutionLogCorruptError, EvolutionLogLockError } from "./store.js";
export type { EvolutionEventStoreOptions, EvolutionTransaction, EvolutionSnapshot } from "./store.js";
export {
  ARTIFACT_EVENT_TYPES,
  ARTIFACT_KINDS,
  CANDIDATE_EVENT_TYPES,
  CANDIDATE_EVIDENCE_CLASSES,
  EVOLUTION_EVENT_SCHEMA_VERSION,
} from "./types.js";
export type {
  ArtifactEventType,
  ArtifactEffect,
  ArtifactExposureCounts,
  ArtifactExposureData,
  ArtifactExposurePhase,
  ArtifactKind,
  ArtifactReference,
  ArtifactProposal,
  ArtifactProjection,
  ArtifactState,
  ArtifactTrust,
  CandidateEventType,
  CandidateBoundaries,
  CandidateEvidence,
  CandidateEvidenceClass,
  CandidateProjection,
  CandidateState,
  CapabilityDependency,
  CapabilityFixtureCase,
  CapabilityFixtureSuite,
  CapabilityContextFixture,
  CapabilityGuardFixture,
  CapabilityToolFixture,
  CapabilityLineage,
  CapabilityManifest,
  CapabilityProvides,
  CapabilityRuntime,
  ApprovalReceipt,
  DeploymentMode,
  DeploymentRequest,
  DeploymentReceipt,
  EvolutionActor,
  EvolutionActorKind,
  EvolutionEntityKind,
  EvolutionEvent,
  EvolutionEventType,
  EvolutionProjection,
  FeedbackVerdict,
  FeedbackWindow,
  ApplicabilityTrigger,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ProposalOutcome,
  VerificationCheck,
  VerificationCheckKind,
  VerificationCheckStatus,
  VerificationReceipt,
  VerificationVerdict,
} from "./types.js";
export { CAPABILITY_FIXTURE_FILE, verifyStagedArtifact } from "./verifier.js";
export type { StaticVerificationOptions } from "./verifier.js";
