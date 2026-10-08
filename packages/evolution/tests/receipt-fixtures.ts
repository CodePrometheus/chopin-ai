import {
  capabilityPermissionDigest,
  capabilityProvidesDigest,
} from "../src/index.js";
import type {
  ApprovalReceipt,
  CapabilityManifest,
  DeploymentMode,
  DeploymentRequest,
  DeploymentReceipt,
  VerificationReceipt,
} from "../src/index.js";

export interface ArtifactBinding {
  artifactId: string;
  contentDigest: string;
  manifestDigest: string;
  surfaceDigest: string;
  manifest: CapabilityManifest;
}

const time = "2026-08-31T00:00:00.000Z";
const hash = `sha256:${"c".repeat(64)}`;

export function verificationReceipt(binding: ArtifactBinding, verdict: "pass" | "fail" = "pass"): VerificationReceipt {
  return {
    receiptId: `verify-${verdict}-${binding.artifactId}`,
    artifactId: binding.artifactId,
    contentDigest: binding.contentDigest,
    manifestDigest: binding.manifestDigest,
    surfaceDigest: binding.surfaceDigest,
    sourceRevision: "git:0123456789abcdef",
    fixtureDigest: hash,
    policyId: "test-policy",
    policyVersion: "1.0.0",
    cwd: "/tmp/chopin-artifact",
    startedAt: time,
    endedAt: time,
    verdict,
    checks: [{
      name: "test-check",
      kind: "contract",
      status: verdict,
      startedAt: time,
      endedAt: time,
    }],
    environment: {
      chopinVersion: "0.1.0",
      dshVersion: "0.1.1-rc.2",
      nodeVersion: "v24.0.0",
      platform: "darwin",
      arch: "arm64",
    },
    durableOutputRef: "/tmp/chopin-artifact/verification.json",
    durableOutputHash: hash,
  };
}

export function approvalReceipt(binding: ArtifactBinding): ApprovalReceipt {
  return {
    receiptId: `approve-${binding.artifactId}`,
    artifactId: binding.artifactId,
    contentDigest: binding.contentDigest,
    manifestDigest: binding.manifestDigest,
    surfaceDigest: binding.surfaceDigest,
    permissionDigest: capabilityPermissionDigest(binding.manifest),
    capabilityDigest: capabilityProvidesDigest(binding.manifest),
    decision: "allowed-once",
    actor: "test-user",
    sessionId: "test-session",
    approvalAuditId: "approval-audit-test",
    decidedAt: time,
  };
}

export function deploymentReceipt(binding: ArtifactBinding, mode: DeploymentMode): DeploymentReceipt {
  return {
    receiptId: `deploy-${mode}-${binding.artifactId}`,
    artifactId: binding.artifactId,
    contentDigest: binding.contentDigest,
    manifestDigest: binding.manifestDigest,
    surfaceDigest: binding.surfaceDigest,
    mode,
    operationId: `operation-${mode}`,
    processGeneration: `generation-${mode}`,
    dshVersion: "0.1.1-rc.2",
    chopinVersion: "0.1.0",
    loadedSurfaceDigest: binding.surfaceDigest,
    health: "pass",
    startedAt: time,
    endedAt: time,
    ...(mode === "rollback" ? {
      rollbackTarget: {
        artifactId: "last-known-good:1.0.0",
        contentDigest: `sha256:${"d".repeat(64)}`,
        surfaceDigest: `sha256:${"f".repeat(64)}`,
      },
    } : {}),
  };
}

export function deploymentRequest(binding: ArtifactBinding, mode: DeploymentMode): DeploymentRequest {
  const approval = approvalReceipt(binding);
  return {
    requestId: `operation-${mode}`,
    artifactId: binding.artifactId,
    contentDigest: binding.contentDigest,
    manifestDigest: binding.manifestDigest,
    surfaceDigest: binding.surfaceDigest,
    mode,
    targetGeneration: `generation-${mode}`,
    approvalReceiptId: approval.receiptId,
    requestedAt: time,
    requestedBy: "test-user",
    ...(mode === "rollback" ? {
      rollbackTarget: {
        artifactId: "last-known-good:1.0.0",
        contentDigest: `sha256:${"d".repeat(64)}`,
        surfaceDigest: `sha256:${"f".repeat(64)}`,
      },
    } : {}),
  };
}
