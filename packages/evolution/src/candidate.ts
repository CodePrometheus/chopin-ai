import { createHash } from "node:crypto";

import { canonicalJson, createEvolutionEvent } from "./events.js";
import { ARTIFACT_KINDS, CANDIDATE_EVIDENCE_CLASSES } from "./types.js";
import type {
  ApplicabilityTrigger,
  ArtifactProposal,
  CandidateBoundaries,
  CandidateEvidence,
  CandidateProjection,
  EvolutionActor,
  EvolutionEvent,
  JsonObject,
  ProposalOutcome,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTENT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const PERMISSION = /^[a-z][a-z0-9:-]{0,127}$/;
const EVIDENCE_CLASSES = new Set<string>(CANDIDATE_EVIDENCE_CLASSES);
const TRUSTED_EVIDENCE_CLASSES = new Set<string>(CANDIDATE_EVIDENCE_CLASSES.filter((value) => value !== "assistant-claim" && value !== "contrast"));
const RECEIPT_EVIDENCE_CLASSES = new Set<string>(["host-verification", "gate-receipt", "tool-receipt", "task-completion"]);
const ARTIFACT_KIND_SET = new Set<string>(ARTIFACT_KINDS);
const TRIGGER_KEYS = new Set(["when", "repos", "taskKinds", "pathGlobs", "tools", "errorKeys", "languages", "environments"]);
/** The trigger description is one index line and must stay within a few dozen tokens. */
export const TRIGGER_WHEN_MAX_CHARS = 240;

export class InvalidCandidateEventError extends Error {
  constructor(message: string) {
    super(`invalid candidate event: ${message}`);
    this.name = "InvalidCandidateEventError";
  }
}

export class CandidateInvariantError extends Error {
  constructor(candidateId: string, message: string) {
    super(`candidate ${candidateId}: ${message}`);
    this.name = "CandidateInvariantError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new InvalidCandidateEventError(`${path}.${key} is not allowed`);
  }
}

function nonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new InvalidCandidateEventError(`${path} must be non-empty`);
}

function identifier(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new InvalidCandidateEventError(`${path} is not a stable identifier`);
}

function canonicalTimestamp(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") throw new InvalidCandidateEventError(`${path} must be a canonical ISO timestamp`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new InvalidCandidateEventError(`${path} must be a canonical ISO timestamp`);
  }
}

function stringArray(value: unknown, path: string, allowEmpty = true): asserts value is string[] {
  if (!Array.isArray(value)) throw new InvalidCandidateEventError(`${path} must be an array`);
  const seen = new Set<string>();
  for (const item of value) {
    nonEmptyString(item, `${path}[]`);
    if (seen.has(item)) throw new InvalidCandidateEventError(`${path} contains duplicate ${item}`);
    seen.add(item);
  }
  if (!allowEmpty && value.length === 0) throw new InvalidCandidateEventError(`${path} must not be empty`);
}

export function assertApplicabilityTrigger(value: unknown, path = "trigger"): asserts value is ApplicabilityTrigger {
  if (!isRecord(value)) throw new InvalidCandidateEventError(`${path} must be an object`);
  let selectors = 0;
  for (const key of Object.keys(value)) {
    if (!TRIGGER_KEYS.has(key)) throw new InvalidCandidateEventError(`${path}.${key} is not allowed`);
    if (key === "when") {
      const when = value[key];
      nonEmptyString(when, `${path}.when`);
      if (when.includes("\n") || when.trim() !== when || when.length > TRIGGER_WHEN_MAX_CHARS) {
        throw new InvalidCandidateEventError(`${path}.when must be a single trimmed line of at most ${TRIGGER_WHEN_MAX_CHARS} characters`);
      }
      selectors += 1;
      continue;
    }
    stringArray(value[key], `${path}.${key}`);
    selectors += (value[key] as string[]).length;
  }
  if (selectors === 0) throw new InvalidCandidateEventError(`${path} must contain at least one selector`);
}

/** The candidate id is determined by the signature alone: the same signature lands on the same candidate in any session or process. */
export function candidateIdFor(signalKey: string): string {
  nonEmptyString(signalKey, "signalKey");
  return `candidate-${createHash("sha256").update(signalKey).digest("hex")}`;
}

function assertBoundaries(value: unknown): asserts value is CandidateBoundaries {
  if (!isRecord(value)) throw new InvalidCandidateEventError("boundaries must be an object");
  assertExactKeys(value, ["includes", "excludes"], "boundaries");
  stringArray(value.includes, "boundaries.includes", false);
  stringArray(value.excludes, "boundaries.excludes");
}

export function assertCandidateEvidence(value: unknown): asserts value is CandidateEvidence {
  if (!isRecord(value)) throw new InvalidCandidateEventError("evidence must be an object");
  assertExactKeys(value, [
    "evidenceId", "class", "independenceKey", "independentUnits", "observedAt", "contentHash", "summary",
    "sourceSessionId", "sourceAttemptId", "sourceRef",
  ], "evidence");
  identifier(value.evidenceId, "evidence.evidenceId");
  if (typeof value.class !== "string" || !EVIDENCE_CLASSES.has(value.class)) {
    throw new InvalidCandidateEventError("evidence.class is unknown");
  }
  nonEmptyString(value.independenceKey, "evidence.independenceKey");
  if (!Number.isSafeInteger(value.independentUnits) || (value.independentUnits as number) < 1) {
    throw new InvalidCandidateEventError("evidence.independentUnits must be a positive safe integer");
  }
  canonicalTimestamp(value.observedAt, "evidence.observedAt");
  if (typeof value.contentHash !== "string" || !CONTENT_DIGEST.test(value.contentHash)) {
    throw new InvalidCandidateEventError("evidence.contentHash must be sha256:<hex>");
  }
  nonEmptyString(value.summary, "evidence.summary");
  for (const key of ["sourceSessionId", "sourceAttemptId", "sourceRef"] as const) {
    if (value[key] !== undefined) nonEmptyString(value[key], `evidence.${key}`);
  }
}

function assertEvidenceProvenance(event: EvolutionEvent, evidence: CandidateEvidence): void {
  const legacyImport = event.actor?.kind === "import" && event.actor.id === "legacy-pending-yaml";
  if (legacyImport) {
    if (evidence.class !== "session-signal") {
      throw new InvalidCandidateEventError("legacy import may only provide session-signal evidence");
    }
    if (evidence.sourceRef === undefined) throw new InvalidCandidateEventError("legacy import evidence requires sourceRef");
    return;
  }
  if (event.actor?.kind === "import") throw new InvalidCandidateEventError("unknown evidence importer");
  if (TRUSTED_EVIDENCE_CLASSES.has(evidence.class) && evidence.independentUnits !== 1) {
    throw new InvalidCandidateEventError("non-legacy trusted evidence must represent exactly one independent unit");
  }
  if (RECEIPT_EVIDENCE_CLASSES.has(evidence.class) && evidence.sourceRef === undefined) {
    throw new InvalidCandidateEventError(`${evidence.class} evidence requires sourceRef`);
  }
  if (evidence.class === "session-signal" && evidence.sourceSessionId === undefined) {
    throw new InvalidCandidateEventError("session-signal evidence requires sourceSessionId");
  }
  if (evidence.class === "contrast" && (evidence.sourceSessionId === undefined || evidence.sourceRef === undefined)) {
    throw new InvalidCandidateEventError("contrast evidence requires sourceSessionId and sourceRef");
  }
  if (evidence.class === "user-request" && (evidence.sourceSessionId === undefined || event.actor?.id === undefined
    || evidence.sourceRef !== `session:${evidence.sourceSessionId}:user-message:${event.actor.id}`)) {
    throw new InvalidCandidateEventError("user-request evidence requires the exact source message");
  }

  const expectedActor = evidence.class === "user-correction" || evidence.class === "user-request"
    ? "user"
    : evidence.class === "assistant-claim"
      ? "agent"
      : "system";
  if (event.actor?.kind !== expectedActor) {
    throw new InvalidCandidateEventError(`${evidence.class} evidence requires ${expectedActor} actor`);
  }
}

function assertProposal(value: unknown): asserts value is ArtifactProposal {
  if (!isRecord(value)) throw new InvalidCandidateEventError("proposal must be an object");
  assertExactKeys(value, ["proposalId", "kind", "intendedEffect", "summary", "trigger", "requiredPermissions", "improvementId"], "proposal");
  identifier(value.proposalId, "proposal.proposalId");
  if (value.improvementId !== undefined) identifier(value.improvementId, "proposal.improvementId");
  if (typeof value.kind !== "string" || !ARTIFACT_KIND_SET.has(value.kind)) throw new InvalidCandidateEventError("proposal.kind is unknown");
  if (value.intendedEffect !== "advisory" && value.intendedEffect !== "preventive") {
    throw new InvalidCandidateEventError("proposal.intendedEffect must be advisory or preventive");
  }
  nonEmptyString(value.summary, "proposal.summary");
  assertApplicabilityTrigger(value.trigger, "proposal.trigger");
  stringArray(value.requiredPermissions, "proposal.requiredPermissions");
  for (const permission of value.requiredPermissions) {
    if (!PERMISSION.test(permission)) throw new InvalidCandidateEventError(`invalid permission ${permission}`);
  }
}

function assertOutcome(value: unknown): asserts value is ProposalOutcome {
  if (!isRecord(value)) throw new InvalidCandidateEventError("outcome must be an object");
  identifier(value.proposalId, "outcome.proposalId");
  if (value.status === "activated") {
    assertExactKeys(value, ["proposalId", "status", "artifactId", "contentDigest", "deploymentEventId"], "outcome");
    identifier(value.artifactId, "outcome.artifactId");
    if (typeof value.contentDigest !== "string" || !CONTENT_DIGEST.test(value.contentDigest)) {
      throw new InvalidCandidateEventError("outcome.contentDigest must be sha256:<hex>");
    }
    identifier(value.deploymentEventId, "outcome.deploymentEventId");
    return;
  }
  if (value.status === "rejected") {
    assertExactKeys(value, ["proposalId", "status", "reason"], "outcome");
    nonEmptyString(value.reason, "outcome.reason");
    return;
  }
  throw new InvalidCandidateEventError("outcome.status must be activated or rejected");
}

export function assertCandidateEventData(event: EvolutionEvent): void {
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case "candidate.observed":
      assertExactKeys(data, ["signalKey", "lesson", "evidence"], "data");
      nonEmptyString(data.signalKey, "data.signalKey");
      nonEmptyString(data.lesson, "data.lesson");
      assertCandidateEvidence(data.evidence);
      assertEvidenceProvenance(event, data.evidence);
      return;
    case "candidate.corroborated":
      assertExactKeys(data, ["rootCause", "trigger", "boundaries"], "data");
      nonEmptyString(data.rootCause, "data.rootCause");
      assertApplicabilityTrigger(data.trigger);
      assertBoundaries(data.boundaries);
      return;
    case "candidate.classified": {
      assertExactKeys(data, ["proposals"], "data");
      if (!Array.isArray(data.proposals) || data.proposals.length === 0) throw new InvalidCandidateEventError("data.proposals must be a non-empty array");
      const ids = new Set<string>();
      for (const proposal of data.proposals) {
        assertProposal(proposal);
        if (ids.has(proposal.proposalId)) throw new InvalidCandidateEventError(`duplicate proposal ${proposal.proposalId}`);
        ids.add(proposal.proposalId);
      }
      return;
    }
    case "candidate.resolved": {
      assertExactKeys(data, ["outcomes"], "data");
      if (!Array.isArray(data.outcomes) || data.outcomes.length === 0) throw new InvalidCandidateEventError("data.outcomes must be a non-empty array");
      const ids = new Set<string>();
      for (const outcome of data.outcomes) {
        assertOutcome(outcome);
        if (ids.has(outcome.proposalId)) throw new InvalidCandidateEventError(`duplicate outcome ${outcome.proposalId}`);
        ids.add(outcome.proposalId);
      }
      return;
    }
    case "candidate.rejected":
      assertExactKeys(data, ["reason"], "data");
      nonEmptyString(data.reason, "data.reason");
      return;
    case "candidate.merged":
      assertExactKeys(data, ["into"], "data");
      identifier(data.into, "data.into");
      if (data.into === event.entityId) throw new InvalidCandidateEventError("candidate cannot merge into itself");
      return;
    default:
      throw new InvalidCandidateEventError(`${event.type} is not a candidate event`);
  }
}

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

interface CandidateEventMeta {
  eventId?: string;
  occurredAt?: string;
  candidateId: string;
  actor?: EvolutionActor;
}

function event(meta: CandidateEventMeta, type: EvolutionEvent["type"], data: unknown): EvolutionEvent {
  const created = createEvolutionEvent({
    eventId: meta.eventId,
    occurredAt: meta.occurredAt,
    entityKind: "candidate",
    entityId: meta.candidateId,
    type,
    data: jsonObject(data),
    actor: meta.actor,
  });
  assertCandidateEventData(created);
  return created;
}

export function candidateObserved(meta: CandidateEventMeta, data: { signalKey: string; lesson: string; evidence: CandidateEvidence }): EvolutionEvent {
  return event(meta, "candidate.observed", data);
}

export function candidateCorroborated(meta: CandidateEventMeta, data: { rootCause: string; trigger: ApplicabilityTrigger; boundaries: CandidateBoundaries }): EvolutionEvent {
  return event(meta, "candidate.corroborated", data);
}

export function candidateClassified(meta: CandidateEventMeta, proposals: ArtifactProposal[]): EvolutionEvent {
  return event(meta, "candidate.classified", { proposals });
}

export function candidateResolved(meta: CandidateEventMeta, outcomes: ProposalOutcome[]): EvolutionEvent {
  return event(meta, "candidate.resolved", { outcomes });
}

export function candidateRejected(meta: CandidateEventMeta, reason: string): EvolutionEvent {
  return event(meta, "candidate.rejected", { reason });
}

export function candidateMerged(meta: CandidateEventMeta, into: string): EvolutionEvent {
  return event(meta, "candidate.merged", { into });
}

export function trustedIndependentUnits(evidence: readonly CandidateEvidence[]): number {
  const units = new Map<string, number>();
  for (const item of evidence) {
    if (!TRUSTED_EVIDENCE_CLASSES.has(item.class)) continue;
    units.set(item.independenceKey, Math.max(units.get(item.independenceKey) ?? 0, item.independentUnits));
  }
  return [...units.values()].reduce((total, value) => total + value, 0);
}

export function candidateCanBeCorroborated(candidate: Pick<CandidateProjection, "trustedIndependentUnits" | "evidence">): boolean {
  return candidate.trustedIndependentUnits >= 2
    || candidate.evidence.some((item) => item.class === "user-correction" || item.class === "user-request" || item.class === "task-completion");
}

export function applyCandidateData(
  previous: CandidateProjection | undefined,
  eventValue: EvolutionEvent,
): Omit<CandidateProjection, "state" | "eventCount" | "firstEventId" | "lastEventId" | "updatedAt"> {
  assertCandidateEventData(eventValue);
  const data = eventValue.data as Record<string, unknown>;
  if (eventValue.type === "candidate.observed") {
    const evidence = data.evidence as CandidateEvidence;
    const existing = previous?.evidence.find((item) => item.evidenceId === evidence.evidenceId);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(evidence)) {
      throw new CandidateInvariantError(eventValue.entityId, `evidence ${evidence.evidenceId} changed content`);
    }
    if (previous !== undefined && previous.signalKey !== data.signalKey) {
      throw new CandidateInvariantError(eventValue.entityId, `signalKey changed from ${previous.signalKey} to ${String(data.signalKey)}`);
    }
    const nextEvidence = existing === undefined ? [...(previous?.evidence ?? []), evidence] : [...(previous?.evidence ?? [])];
    return {
      id: eventValue.entityId,
      signalKey: data.signalKey as string,
      lesson: previous?.lesson ?? data.lesson as string,
      evidence: nextEvidence,
      trustedIndependentUnits: trustedIndependentUnits(nextEvidence),
      proposals: previous?.proposals ?? [],
      ...(previous?.rootCause === undefined ? {} : { rootCause: previous.rootCause }),
      ...(previous?.trigger === undefined ? {} : { trigger: previous.trigger }),
      ...(previous?.boundaries === undefined ? {} : { boundaries: previous.boundaries }),
      ...(previous?.outcomes === undefined ? {} : { outcomes: previous.outcomes }),
      ...(previous?.rejectionReason === undefined ? {} : { rejectionReason: previous.rejectionReason }),
      ...(previous?.mergedInto === undefined ? {} : { mergedInto: previous.mergedInto }),
    };
  }

  if (previous === undefined) throw new CandidateInvariantError(eventValue.entityId, `${eventValue.type} has no observed candidate`);
  const base = {
    id: previous.id,
    signalKey: previous.signalKey,
    lesson: previous.lesson,
    evidence: previous.evidence,
    trustedIndependentUnits: previous.trustedIndependentUnits,
    proposals: previous.proposals,
    ...(previous.rootCause === undefined ? {} : { rootCause: previous.rootCause }),
    ...(previous.trigger === undefined ? {} : { trigger: previous.trigger }),
    ...(previous.boundaries === undefined ? {} : { boundaries: previous.boundaries }),
    ...(previous.outcomes === undefined ? {} : { outcomes: previous.outcomes }),
    ...(previous.rejectionReason === undefined ? {} : { rejectionReason: previous.rejectionReason }),
    ...(previous.mergedInto === undefined ? {} : { mergedInto: previous.mergedInto }),
  };

  if (eventValue.type === "candidate.corroborated") {
    // Machine signals need two independent sessions to count as recurring; for a correction the user confirmed in person, the user is the corroborator.
    if (!candidateCanBeCorroborated(previous)) {
      throw new CandidateInvariantError(eventValue.entityId, "corroboration requires at least 2 independent trusted evidence units, one user correction, or a completed task");
    }
    return {
      ...base,
      rootCause: data.rootCause as string,
      trigger: data.trigger as ApplicabilityTrigger,
      boundaries: data.boundaries as unknown as CandidateBoundaries,
    };
  }
  if (eventValue.type === "candidate.classified") {
    const proposals = data.proposals as unknown as ArtifactProposal[];
    const byId = new Map(previous.proposals.map((proposal) => [proposal.proposalId, proposal]));
    for (const proposal of proposals) {
      const existing = byId.get(proposal.proposalId);
      if (existing !== undefined && canonicalJson(existing) !== canonicalJson(proposal)) {
        throw new CandidateInvariantError(eventValue.entityId, `proposal ${proposal.proposalId} changed content`);
      }
      byId.set(proposal.proposalId, proposal);
    }
    return { ...base, proposals: [...byId.values()].sort((left, right) => left.proposalId.localeCompare(right.proposalId)) };
  }
  if (eventValue.type === "candidate.resolved") {
    const outcomes = data.outcomes as unknown as ProposalOutcome[];
    const expected = new Set(previous.proposals.map((proposal) => proposal.proposalId));
    const actual = new Set(outcomes.map((outcome) => outcome.proposalId));
    if (expected.size === 0 || expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) {
      throw new CandidateInvariantError(eventValue.entityId, "resolution outcomes must cover every classified proposal exactly once");
    }
    return { ...base, outcomes };
  }
  if (eventValue.type === "candidate.rejected") return { ...base, rejectionReason: data.reason as string };
  if (eventValue.type === "candidate.merged") return { ...base, mergedInto: data.into as string };
  return base;
}
