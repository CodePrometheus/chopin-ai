import type {
  ApprovalReceipt,
  DeploymentRequest,
  DeploymentReceipt,
  VerificationCheck,
  VerificationReceipt,
} from "./types.js";
import { MANAGED_POLICY } from "./policy.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CHECK_KINDS = new Set(["schema", "content", "syntax", "contract", "composition", "e2e"]);
const CHECK_STATUSES = new Set(["pass", "fail", "skipped"]);
const VERDICTS = new Set(["pass", "fail", "inconclusive"]);
const APPROVAL_DECISIONS = new Set(["allowed-once", "rejected", "cancelled", "unavailable"]);
const DEPLOYMENT_MODES = new Set(["disabled", "canary", "active", "rollback"]);

export class InvalidReceiptError extends Error {
  constructor(kind: string, message: string) {
    super(`invalid ${kind} receipt: ${message}`);
    this.name = "InvalidReceiptError";
  }
}

function record(value: unknown, kind: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidReceiptError(kind, "must be an object");
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], kind: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new InvalidReceiptError(kind, `${key} is not allowed`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new InvalidReceiptError(kind, `${key} is required`);
}

function id(value: unknown, path: string, kind: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new InvalidReceiptError(kind, `${path} is not a stable identifier`);
}

function nonEmpty(value: unknown, path: string, kind: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new InvalidReceiptError(kind, `${path} must be non-empty`);
}

function digest(value: unknown, path: string, kind: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new InvalidReceiptError(kind, `${path} must be sha256:<hex>`);
}

function timestamp(value: unknown, path: string, kind: string): asserts value is string {
  if (typeof value !== "string") throw new InvalidReceiptError(kind, `${path} must be a canonical ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new InvalidReceiptError(kind, `${path} must be a canonical ISO timestamp`);
}

function orderedTimes(startedAt: unknown, endedAt: unknown, kind: string): void {
  timestamp(startedAt, "startedAt", kind);
  timestamp(endedAt, "endedAt", kind);
  if (Date.parse(endedAt) < Date.parse(startedAt)) throw new InvalidReceiptError(kind, "endedAt precedes startedAt");
}

function commonArtifact(value: Record<string, unknown>, kind: string): void {
  id(value.receiptId, "receiptId", kind);
  id(value.artifactId, "artifactId", kind);
  digest(value.contentDigest, "contentDigest", kind);
  digest(value.manifestDigest, "manifestDigest", kind);
  digest(value.surfaceDigest, "surfaceDigest", kind);
}

function check(value: unknown): asserts value is VerificationCheck {
  const kind = "verification check";
  const item = record(value, kind);
  exact(item, ["name", "kind", "status", "startedAt", "endedAt"], ["command", "exitCode", "detail"], kind);
  id(item.name, "name", kind);
  if (typeof item.kind !== "string" || !CHECK_KINDS.has(item.kind)) throw new InvalidReceiptError(kind, "kind is unknown");
  if (typeof item.status !== "string" || !CHECK_STATUSES.has(item.status)) throw new InvalidReceiptError(kind, "status is unknown");
  orderedTimes(item.startedAt, item.endedAt, kind);
  if (item.command !== undefined) {
    if (!Array.isArray(item.command) || item.command.length === 0 || item.command.some((part) => typeof part !== "string" || part === "")) {
      throw new InvalidReceiptError(kind, "command must be a non-empty argv array");
    }
  }
  if (item.exitCode !== undefined && !Number.isSafeInteger(item.exitCode)) throw new InvalidReceiptError(kind, "exitCode must be a safe integer");
  if (item.detail !== undefined) nonEmpty(item.detail, "detail", kind);
}

export function assertVerificationReceipt(value: unknown): asserts value is VerificationReceipt {
  const kind = "verification";
  const item = record(value, kind);
  exact(item, [
    "receiptId", "artifactId", "contentDigest", "manifestDigest", "surfaceDigest", "sourceRevision", "fixtureDigest",
    "policyId", "policyVersion", "cwd", "startedAt", "endedAt", "verdict", "checks", "environment",
    "durableOutputRef", "durableOutputHash",
  ], [], kind);
  commonArtifact(item, kind);
  nonEmpty(item.sourceRevision, "sourceRevision", kind);
  digest(item.fixtureDigest, "fixtureDigest", kind);
  id(item.policyId, "policyId", kind);
  nonEmpty(item.policyVersion, "policyVersion", kind);
  nonEmpty(item.cwd, "cwd", kind);
  orderedTimes(item.startedAt, item.endedAt, kind);
  if (typeof item.verdict !== "string" || !VERDICTS.has(item.verdict)) throw new InvalidReceiptError(kind, "verdict is unknown");
  if (!Array.isArray(item.checks) || item.checks.length === 0) throw new InvalidReceiptError(kind, "checks must be non-empty");
  for (const value of item.checks) check(value);
  const statuses = item.checks.map((value) => value.status);
  if (item.verdict === "pass" && (statuses.includes("fail") || !statuses.includes("pass"))) {
    throw new InvalidReceiptError(kind, "pass verdict requires at least one pass and no failed checks");
  }
  if (item.verdict === "fail" && !statuses.includes("fail")) throw new InvalidReceiptError(kind, "fail verdict requires a failed check");
  const environment = record(item.environment, "verification environment");
  exact(environment, ["chopinVersion", "dshVersion", "nodeVersion", "platform", "arch"], [], "verification environment");
  for (const key of ["chopinVersion", "dshVersion", "nodeVersion", "platform", "arch"]) nonEmpty(environment[key], key, "verification environment");
  nonEmpty(item.durableOutputRef, "durableOutputRef", kind);
  digest(item.durableOutputHash, "durableOutputHash", kind);
}

export function assertApprovalReceipt(value: unknown): asserts value is ApprovalReceipt {
  const kind = "approval";
  const item = record(value, kind);
  exact(item, [
    "receiptId", "artifactId", "contentDigest", "manifestDigest", "surfaceDigest", "permissionDigest", "capabilityDigest",
    "decision", "actor", "decidedAt",
  ], ["sessionId", "approvalAuditId", "policy"], kind);
  commonArtifact(item, kind);
  digest(item.permissionDigest, "permissionDigest", kind);
  digest(item.capabilityDigest, "capabilityDigest", kind);
  if (typeof item.decision !== "string" || !APPROVAL_DECISIONS.has(item.decision)) throw new InvalidReceiptError(kind, "decision is unknown");
  nonEmpty(item.actor, "actor", kind);
  if (item.policy !== undefined) {
    const policy = record(item.policy, kind);
    exact(policy, ["id", "digest"], [], kind);
    if (policy.id !== MANAGED_POLICY.id || policy.digest !== MANAGED_POLICY.digest
      || item.actor !== "host-policy" || item.decision !== "allowed-once"
      || item.approvalAuditId !== undefined) throw new InvalidReceiptError(kind, "invalid host policy authorization");
    if (item.sessionId !== undefined) nonEmpty(item.sessionId, "sessionId", kind);
  } else {
    if (item.actor === "host-policy") throw new InvalidReceiptError(kind, "host policy authorization needs a policy");
    nonEmpty(item.sessionId, "sessionId", kind);
    id(item.approvalAuditId, "approvalAuditId", kind);
  }
  timestamp(item.decidedAt, "decidedAt", kind);
}

export function assertDeploymentReceipt(value: unknown): asserts value is DeploymentReceipt {
  const kind = "deployment";
  const item = record(value, kind);
  exact(item, [
    "receiptId", "artifactId", "contentDigest", "manifestDigest", "surfaceDigest", "mode", "operationId",
    "processGeneration", "dshVersion", "chopinVersion", "loadedSurfaceDigest", "health", "startedAt", "endedAt",
  ], ["rollbackTarget", "detail"], kind);
  commonArtifact(item, kind);
  if (typeof item.mode !== "string" || !DEPLOYMENT_MODES.has(item.mode)) throw new InvalidReceiptError(kind, "mode is unknown");
  id(item.operationId, "operationId", kind);
  for (const key of ["processGeneration", "dshVersion", "chopinVersion"]) nonEmpty(item[key], key, kind);
  digest(item.loadedSurfaceDigest, "loadedSurfaceDigest", kind);
  if (item.health !== "pass" && item.health !== "fail") throw new InvalidReceiptError(kind, "health is unknown");
  orderedTimes(item.startedAt, item.endedAt, kind);
  if (item.rollbackTarget !== undefined) {
    const target = record(item.rollbackTarget, "rollback target");
    exact(target, ["artifactId", "contentDigest", "surfaceDigest"], [], "rollback target");
    id(target.artifactId, "artifactId", "rollback target");
    digest(target.contentDigest, "contentDigest", "rollback target");
    digest(target.surfaceDigest, "surfaceDigest", "rollback target");
  }
  if (item.detail !== undefined) nonEmpty(item.detail, "detail", kind);
}

export function assertDeploymentRequest(value: unknown): asserts value is DeploymentRequest {
  const kind = "deployment request";
  const item = record(value, kind);
  exact(item, [
    "requestId", "artifactId", "contentDigest", "manifestDigest", "surfaceDigest", "mode", "targetGeneration",
    "approvalReceiptId", "requestedAt", "requestedBy",
  ], ["rollbackTarget", "retryOf", "retryApproval"], kind);
  id(item.requestId, "requestId", kind);
  id(item.artifactId, "artifactId", kind);
  digest(item.contentDigest, "contentDigest", kind);
  digest(item.manifestDigest, "manifestDigest", kind);
  digest(item.surfaceDigest, "surfaceDigest", kind);
  if (typeof item.mode !== "string" || !DEPLOYMENT_MODES.has(item.mode)) throw new InvalidReceiptError(kind, "mode is unknown");
  nonEmpty(item.targetGeneration, "targetGeneration", kind);
  id(item.approvalReceiptId, "approvalReceiptId", kind);
  timestamp(item.requestedAt, "requestedAt", kind);
  nonEmpty(item.requestedBy, "requestedBy", kind);
  if ((item.retryOf === undefined) !== (item.retryApproval === undefined)) {
    throw new InvalidReceiptError(kind, "retryOf and retryApproval must be supplied together");
  }
  if (item.retryOf !== undefined) {
    id(item.retryOf, "retryOf", kind);
    assertApprovalReceipt(item.retryApproval);
  }
  if (item.rollbackTarget !== undefined) {
    const target = record(item.rollbackTarget, "rollback target");
    exact(target, ["artifactId", "contentDigest", "surfaceDigest"], [], "rollback target");
    id(target.artifactId, "artifactId", "rollback target");
    digest(target.contentDigest, "contentDigest", "rollback target");
    digest(target.surfaceDigest, "surfaceDigest", "rollback target");
  }
  if (item.mode === "rollback" && item.rollbackTarget === undefined) throw new InvalidReceiptError(kind, "rollback needs rollbackTarget");
}

export function assertReceiptMatchesArtifact(
  receipt: Pick<VerificationReceipt, "artifactId" | "contentDigest" | "manifestDigest" | "surfaceDigest">,
  artifact: Pick<VerificationReceipt, "artifactId" | "contentDigest" | "manifestDigest" | "surfaceDigest">,
  kind: string,
): void {
  for (const key of ["artifactId", "contentDigest", "manifestDigest", "surfaceDigest"] as const) {
    if (receipt[key] !== artifact[key]) throw new InvalidReceiptError(kind, `${key} does not match artifact`);
  }
}
