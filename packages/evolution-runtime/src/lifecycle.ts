import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";
import type {  } from "@deepseek-ai/dsh-tools";
import {
  MANAGED_POLICY,
  MAX_AUTOMATIC_FIXTURES,
  automaticCapabilityDenial,
  automaticRetryAvailable,
  artifactApproved,
  artifactActivated,
  artifactCanaryActivated,
  artifactDeploymentFailed,
  artifactDeploymentRequested,
  artifactInstalledDisabled,
  artifactRetired,
  artifactRolledBack,
  artifactRuntimeLoaded,
  artifactVerificationFailed,
  artifactVerified,
  assertApprovalReceipt,
  assertCapabilityFixtureSuite,
  assertDeploymentReceipt,
  assertDeploymentRequest,
  candidateResolved,
  canonicalJson,
  capabilityPermissionDigest,
  capabilityProvidesDigest,
  verifyStagedArtifact,
} from "@chopin/evolution";
import { scrub } from "@chopin/ledger";
import type {
  ApprovalReceipt,
  ArtifactProjection,
  DeploymentMode,
  DeploymentReceipt,
  DeploymentRequest,
  EvolutionActor,
  EvolutionEvent,
  ProposalOutcome,
  VerificationReceipt,
} from "@chopin/evolution";

import {
  latestFailedDeployment,
  nextDeploymentMode,
  artifactReferenceOf,
  referenceMatchesArtifact,
  latestSuccessfulDeployment,
  hasEffectiveReplacement,
  selectFeedbackArtifacts,
  assertLastKnownGood,
  resolveLastKnownGood,
} from "./deployment.js";
import type { ArtifactHost } from "./runtime-host.js";
import type { AdvanceResult } from "./index.js";

interface DeploymentHost extends ArtifactHost {
  warn(message: string, ...values: unknown[]): void;
}

const ADVANCE_ACTOR: EvolutionActor = { kind: "system", id: "chopin-evolution-advance" };

export class DeploymentLifecycle {
  private advanceTail: Promise<void> = Promise.resolve();

  constructor(private readonly host: DeploymentHost) {}

  private policyReceipt(artifact: Pick<ArtifactProjection, "id" | "manifest" | "contentDigest" | "manifestDigest" | "surfaceDigest">, sessionId?: string): ApprovalReceipt {
    const denial = automaticCapabilityDenial(artifact.manifest);
    if (denial !== undefined) throw new Error(denial);
    return {
      receiptId: `policy-${randomUUID()}`, artifactId: artifact.id,
      contentDigest: artifact.contentDigest, manifestDigest: artifact.manifestDigest, surfaceDigest: artifact.surfaceDigest,
      permissionDigest: capabilityPermissionDigest(artifact.manifest), capabilityDigest: capabilityProvidesDigest(artifact.manifest),
      decision: "allowed-once", actor: "host-policy", policy: MANAGED_POLICY,
      ...(sessionId === undefined ? {} : { sessionId }), decidedAt: new Date().toISOString(),
    };
  }

  private async authorizeAutomatically(artifactId: string, sessionId?: string): Promise<ApprovalReceipt | undefined> {
    if (!this.host.autonomous) return undefined;
    const artifact = ((await this.host.events.snapshot()).projection).artifacts.find((item) => item.id === artifactId);
    if (artifact === undefined || automaticCapabilityDenial(artifact.manifest) !== undefined) return undefined;
    const staged = await this.host.artifacts.inspect(artifact.contentDigest);
    if (artifact.manifest.runtime !== "data") {
      const suite = JSON.parse(await readFile(join(staged.path, "capability.tests.json"), "utf8")) as unknown;
      assertCapabilityFixtureSuite(suite);
      if (suite.cases.length > MAX_AUTOMATIC_FIXTURES) return undefined;
      for (const guard of artifact.manifest.provides.guards) {
        const cases = suite.cases.filter((item) => item.kind === "guard" && item.name === guard);
        if (!cases.some((item) => item.kind === "guard" && item.expect.decision === null)
          || !cases.some((item) => item.kind === "guard" && typeof item.expect.decision === "string")) return undefined;
      }
    }
    return this.host.events.transact((projection) => {
      const current = projection.artifacts.find((item) => item.id === artifactId);
      if (current === undefined) throw new Error(`unknown artifact ${artifactId}`);
      const existing = current.approvalReceipts.find((receipt) => receipt.policy !== undefined);
      if (existing !== undefined) return { events: [], value: existing };
      if (current.state !== "verified") throw new Error(`artifact ${artifactId} is not verified`);
      const receipt = this.policyReceipt(current, sessionId);
      return { events: [artifactApproved({ artifactId, actor: { kind: "system", id: "host-policy" } }, receipt)], value: receipt };
    });
  }

  advance(): Promise<AdvanceResult> {
    const run = this.advanceTail.then(() => this.advanceOnce());
    this.advanceTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async advanceOnce(): Promise<AdvanceResult> {
    const result: AdvanceResult = { verified: [], deployed: [], retired: [], resolved: [] };
    const failedArtifacts = new Set<string>();
    let automaticGrants = 0;
    for (let round = 0; round < 8; round += 1) {
      const projection = (await this.host.events.snapshot()).projection;
      let progressed = false;
      for (const artifact of projection.artifacts) {
        if (failedArtifacts.has(artifact.id)) continue;
        if (artifact.state === "built" && artifact.verificationReceipts.length === 0) {
          const verification = await this.verifyArtifact(artifact.id);
          if (verification.verdict === "pass") {
            result.verified.push(artifact.id);
            progressed = true;
          } else {
            failedArtifacts.add(artifact.id);
          }
          continue;
        }
        if (artifact.state === "verified" && this.host.autonomous) {
          if (automaticGrants < 4 && await this.authorizeAutomatically(artifact.id)) {
            automaticGrants += 1;
            progressed = true;
          }
          continue;
        }
        const next = nextDeploymentMode(artifact);
        if (next === undefined) continue;
        if (next === "rollback" && hasEffectiveReplacement(projection, artifact)) continue;
        try {
          const outcome = await this.requestDeployment(artifact.id, next, ADVANCE_ACTOR.id as string, ADVANCE_ACTOR);
          if (outcome.receipt?.health === "pass") {
            result.deployed.push(`${artifact.id}:${next}`);
            progressed = true;
          } else if (outcome.receipt?.health === "fail") {
            failedArtifacts.add(artifact.id);
          }
        } catch (error) {
          failedArtifacts.add(artifact.id);
          this.host.warn("evolution advance skipped %s -> %s: %s", artifact.id, next, (error as Error).message);
        }
      }
      progressed = (await this.retireSuperseded(result)) || progressed;
      progressed = (await this.resolveActivated(result)) || progressed;
      if (!progressed) break;
    }
    return result;
  }

  /** Once a new version is live, retire the superseded old versions of the same capability. */
  private async retireSuperseded(result: AdvanceResult): Promise<boolean> {
    const retired = await this.host.events.transact((projection) => {
      const active = projection.artifacts.filter((artifact) => artifact.state === "active" && artifact.manifest.runtime === "data");
      const events: EvolutionEvent[] = [];
      const ids: string[] = [];
      for (const newer of active) {
        if (!newer.enabled) continue;
        for (const older of active) {
          if (older.enabled || older.manifest.id !== newer.manifest.id || ids.includes(older.id)) continue;
          events.push(artifactRetired({ artifactId: older.id, actor: ADVANCE_ACTOR }, `superseded by ${newer.id}`));
          ids.push(older.id);
        }
      }
      return { events, value: ids };
    });
    result.retired.push(...retired);
    return retired.length > 0;
  }

  /** The host marks a candidate resolved only once every proposal has an artifact live. */
  private async resolveActivated(result: AdvanceResult): Promise<boolean> {
    const resolved = await this.host.events.transact((projection, history) => {
      const appended: EvolutionEvent[] = [];
      const ids: string[] = [];
      for (const candidate of projection.candidates) {
        if (candidate.state !== "classified" || candidate.proposals.length === 0) continue;
        const outcomes: ProposalOutcome[] = [];
        for (const proposal of candidate.proposals) {
          const needsRecovery = projection.artifacts.some((item) =>
            (item.state === "quarantined" || item.state === "rolled-back")
            && item.manifest.lineage.candidateIds.includes(candidate.id)
            && item.manifest.lineage.proposalIds.includes(proposal.proposalId));
          const artifact = projection.artifacts.find((item) =>
            (item.state === "active" || item.state === "retired")
            && (!needsRecovery || item.enabled)
            && item.manifest.lineage.candidateIds.includes(candidate.id)
            && item.manifest.lineage.proposalIds.includes(proposal.proposalId));
          const activation = artifact === undefined
            ? undefined
            : history.findLast((event) => event.entityId === artifact.id && event.type === "artifact.active");
          if (artifact === undefined || activation === undefined) break;
          outcomes.push({
            proposalId: proposal.proposalId,
            status: "activated",
            artifactId: artifact.id,
            contentDigest: artifact.contentDigest,
            deploymentEventId: activation.eventId,
          });
        }
        if (outcomes.length !== candidate.proposals.length) continue;
        appended.push(candidateResolved({ candidateId: candidate.id, actor: ADVANCE_ACTOR }, outcomes));
        ids.push(candidate.id);
      }
      return { events: appended, value: ids };
    });
    result.resolved.push(...resolved);
    return resolved.length > 0;
  }

  async verifyArtifact(artifactId: string): Promise<VerificationReceipt> {
    const projection = (await this.host.events.snapshot()).projection;
    const artifact = projection.artifacts.find((item) => item.id === artifactId);
    if (artifact === undefined) throw new Error(`unknown artifact ${artifactId}`);
    const existing = artifact.verificationReceipts.findLast((receipt) => receipt.verdict === "pass");
    if (existing !== undefined) return existing;
    if (artifact.state !== "built") throw new Error(`artifact ${artifactId} is ${artifact.state}, not built`);
    if (artifact.sourceRevision === undefined) throw new Error(`artifact ${artifactId} has no host source revision`);
    const receipt = await verifyStagedArtifact(this.host.artifacts, artifact.contentDigest, {
      sourceRevision: artifact.sourceRevision,
      receiptsDir: this.host.receiptsDir,
      chopinVersion: this.host.chopinVersion,
      dshVersion: this.host.dshVersion,
    });
    if (receipt.artifactId !== artifactId) throw new Error(`verification returned artifact ${receipt.artifactId}, expected ${artifactId}`);
    return this.host.events.transact((current) => {
      const currentArtifact = current.artifacts.find((item) => item.id === artifactId);
      if (currentArtifact === undefined) throw new Error(`unknown artifact ${artifactId}`);
      const existing = currentArtifact.verificationReceipts.findLast((item) => item.verdict === "pass");
      if (existing !== undefined) return { events: [], value: existing };
      if (currentArtifact.state !== "built") throw new Error(`artifact ${artifactId} is ${currentArtifact.state}, not built`);
      if (
        currentArtifact.contentDigest !== receipt.contentDigest
        || currentArtifact.manifestDigest !== receipt.manifestDigest
        || currentArtifact.surfaceDigest !== receipt.surfaceDigest
        || currentArtifact.sourceRevision !== receipt.sourceRevision
      ) throw new Error(`verification result for ${artifactId} is stale`);
      const event = receipt.verdict === "pass"
        ? artifactVerified({ artifactId, actor: { kind: "system", id: "chopin-static-verifier" } }, receipt)
        : artifactVerificationFailed({ artifactId, actor: { kind: "system", id: "chopin-static-verifier" } }, receipt);
      return { events: [event], value: receipt };
    });
  }

  async approveArtifact(
    agent: Agent,
    callId: ToolCallId,
    artifactId: string,
    contentDigest: string,
  ): Promise<{ outcome: ApprovalOutcome; receipt?: ApprovalReceipt }> {
    const projection = (await this.host.events.snapshot()).projection;
    const artifact = projection.artifacts.find((item) => item.id === artifactId);
    if (artifact === undefined) throw new Error(`unknown artifact ${artifactId}`);
    if (artifact.contentDigest !== contentDigest) throw new Error(`artifact ${artifactId} digest changed; approval request is stale`);
    if (artifact.state !== "verified") {
      const granted = artifact.approvalReceipts.find((receipt) => receipt.policy !== undefined);
      if (this.host.autonomous && granted !== undefined) return { outcome: "allowed-once", receipt: granted };
      throw new Error(`artifact ${artifactId} is ${artifact.state}, not verified`);
    }

    const automatic = await this.authorizeAutomatically(artifactId, String(agent.session.id));
    if (automatic !== undefined) return { outcome: "allowed-once", receipt: automatic };

    const approval = await this.host.requestAuditedApproval(
      agent,
      callId,
      "evolution_approve",
      `Approve exact artifact ${artifactId} at ${contentDigest}; permissions=${artifact.manifest.permissions.join(",") || "none"}`,
    );
    if (approval.outcome !== "allowed-once" || approval.auditId === undefined || approval.decidedAt === undefined) {
      return { outcome: approval.outcome };
    }

    const receipt: ApprovalReceipt = {
      receiptId: `approve-${randomUUID()}`,
      artifactId,
      contentDigest,
      manifestDigest: artifact.manifestDigest,
      surfaceDigest: artifact.surfaceDigest,
      permissionDigest: capabilityPermissionDigest(artifact.manifest),
      capabilityDigest: capabilityProvidesDigest(artifact.manifest),
      decision: approval.outcome,
      actor: "dsh-approval-seam",
      sessionId: String(agent.session.id),
      approvalAuditId: approval.auditId,
      decidedAt: approval.decidedAt,
    };
    assertApprovalReceipt(receipt);
    await this.host.events.append(artifactApproved({ artifactId, actor: { kind: "system", id: "dsh-approval-seam" } }, receipt));
    return { outcome: approval.outcome, receipt };
  }

  async requestDeployment(
    artifactId: string,
    mode: DeploymentMode,
    requestedBy: string,
    actor: EvolutionActor = { kind: "agent", id: requestedBy },
  ): Promise<{ request: DeploymentRequest; receipt?: DeploymentReceipt }> {
    return this.requestDeploymentOnce(artifactId, mode, requestedBy, actor);
  }

  async retryDeployment(
    agent: Agent,
    callId: ToolCallId,
    artifactId: string,
    contentDigest: string,
    failureReceiptId: string,
  ): Promise<{ outcome: ApprovalOutcome; request?: DeploymentRequest; receipt?: DeploymentReceipt }> {
    const artifact = ((await this.host.events.snapshot()).projection).artifacts.find((item) => item.id === artifactId);
    if (artifact === undefined) throw new Error(`unknown artifact ${artifactId}`);
    if (artifact.contentDigest !== contentDigest) throw new Error(`artifact ${artifactId} digest changed; retry request is stale`);
    const failure = latestFailedDeployment(artifact);
    if (failure?.receipt.receiptId !== failureReceiptId) throw new Error(`deployment failure ${failureReceiptId} is no longer current`);
    if (this.host.autonomous && automaticCapabilityDenial(artifact.manifest) === undefined) {
      if (!automaticRetryAvailable(artifact, failure.request.mode)) {
        throw new Error("automatic retry budget exhausted; stage a corrected version instead");
      }
      const retryApproval = this.policyReceipt(artifact, String(agent.session.id));
      const result = await this.requestDeploymentOnce(artifactId, failure.request.mode, String(agent.session.id), {
        kind: "system", id: "chopin-deployment-retry",
      }, { retryOf: failureReceiptId, retryApproval });
      return { outcome: "allowed-once", ...result };
    }
    const approval = await this.host.requestAuditedApproval(
      agent,
      callId,
      "evolution_deployment_retry",
      `Retry one ${failure.request.mode} deployment for exact artifact ${artifactId} at ${contentDigest}; failure=${failureReceiptId}; rollbackTarget=${canonicalJson(failure.request.rollbackTarget ?? null)}; reason=${scrub(failure.receipt.detail ?? "see failure receipt")}`,
    );
    if (approval.outcome !== "allowed-once" || approval.auditId === undefined || approval.decidedAt === undefined) {
      return { outcome: approval.outcome };
    }
    const retryApproval: ApprovalReceipt = {
      receiptId: `retry-approve-${randomUUID()}`,
      artifactId,
      contentDigest,
      manifestDigest: artifact.manifestDigest,
      surfaceDigest: artifact.surfaceDigest,
      permissionDigest: capabilityPermissionDigest(artifact.manifest),
      capabilityDigest: capabilityProvidesDigest(artifact.manifest),
      decision: "allowed-once",
      actor: "host-approval-seam",
      sessionId: String(agent.session.id),
      approvalAuditId: approval.auditId,
      decidedAt: approval.decidedAt,
    };
    assertApprovalReceipt(retryApproval);
    const result = await this.requestDeploymentOnce(artifactId, failure.request.mode, String(agent.session.id), {
      kind: "system", id: "chopin-deployment-retry",
    }, { retryOf: failureReceiptId, retryApproval });
    return { outcome: approval.outcome, ...result };
  }

  private async requestDeploymentOnce(
    artifactId: string,
    mode: DeploymentMode,
    requestedBy: string,
    actor: EvolutionActor,
    retry?: Pick<DeploymentRequest, "retryOf" | "retryApproval">,
  ): Promise<{ request: DeploymentRequest; receipt?: DeploymentReceipt }> {
    const decision = await this.host.events.transact<{ request: DeploymentRequest; receipt?: DeploymentReceipt; complete: boolean }>((projection) => {
      const artifact = projection.artifacts.find((item) => item.id === artifactId);
      if (artifact === undefined) throw new Error(`unknown artifact ${artifactId}`);
      const inProcess = mode === "disabled" || artifact.manifest.runtime === "data";
      // One failure is retried once: a second approval of it returns that retry, finished or not.
      const earlierRetry = retry === undefined ? undefined
        : artifact.deploymentRequests.find((request) => request.retryOf === retry.retryOf);
      if (earlierRetry !== undefined) {
        const receipt = artifact.deploymentReceipts.find((item) => item.operationId === earlierRetry.requestId);
        return {
          events: [],
          value: receipt !== undefined
            ? { request: earlierRetry, receipt, complete: true }
            : { request: earlierRetry, complete: inProcess && earlierRetry.targetGeneration === this.host.processGeneration },
        };
      }
      const approval = artifact.approvalReceipts.at(-1);
      if (approval === undefined) throw new Error(`artifact ${artifactId} has no approval receipt`);
      const expectedMode = nextDeploymentMode(artifact);
      if (mode !== expectedMode) throw new Error(`cannot request ${mode} from ${artifact.state}`);
      if (mode === "rollback" && hasEffectiveReplacement(projection, artifact)) {
        throw new Error(`artifact ${artifactId} has already been replaced by an effective version`);
      }
      if (mode === "active" && latestSuccessfulDeployment(artifact, "canary") === undefined) {
        throw new Error(`artifact ${artifact.id} has no behavior evidence after its current canary deployment`);
      }
      const rollbackTarget = mode === "rollback" ? resolveLastKnownGood(projection, artifact) : undefined;
      const openRequests = artifact.deploymentRequests.filter((request) =>
        !artifact.deploymentReceipts.some((receipt) => receipt.operationId === request.requestId));
      const open = openRequests.find((request) => request.mode === mode);
      if (open !== undefined) {
        if (retry !== undefined && open.retryOf !== retry.retryOf) {
          throw new Error(`deployment retry for ${retry.retryOf} is stale`);
        }
        if (mode === "rollback" && canonicalJson(open.rollbackTarget ?? null) !== canonicalJson(rollbackTarget ?? null)) {
          throw new Error(`open rollback request ${open.requestId} no longer targets the exact last-known-good artifact`);
        }
        return {
          events: [],
          value: { request: open, complete: inProcess && open.targetGeneration === this.host.processGeneration },
        };
      }
      if (openRequests.length > 0) {
        throw new Error(`artifact ${artifact.id} already has open deployment request ${openRequests[0]?.requestId}`);
      }

      const failure = latestFailedDeployment(artifact, mode);
      if (retry === undefined && failure !== undefined) {
        return { events: [], value: { ...failure, complete: false } };
      }
      if (retry !== undefined && retry.retryOf !== failure?.receipt.receiptId) {
        throw new Error(`deployment retry for ${retry.retryOf} is stale`);
      }

      const request: DeploymentRequest = {
        requestId: `deploy-request-${randomUUID()}`,
        artifactId,
        contentDigest: artifact.contentDigest,
        manifestDigest: artifact.manifestDigest,
        surfaceDigest: artifact.surfaceDigest,
        mode,
        targetGeneration: inProcess ? this.host.processGeneration : randomUUID(),
        approvalReceiptId: approval.receiptId,
        requestedAt: new Date().toISOString(),
        requestedBy,
        ...(rollbackTarget === undefined ? {} : { rollbackTarget }),
        ...retry,
      };
      assertDeploymentRequest(request);
      return {
        events: [artifactDeploymentRequested({ artifactId, actor }, request)],
        value: { request, complete: inProcess },
      };
    });
    if (decision.receipt !== undefined) return { request: decision.request, receipt: decision.receipt };
    if (!decision.complete) return { request: decision.request };
    return { request: decision.request, receipt: await this.completeInProcess(decision.request) };
  }

  private async completeInProcess(request: DeploymentRequest): Promise<DeploymentReceipt> {
    if (request.mode === "disabled") {
      try {
        const staged = await this.host.artifacts.inspect(request.contentDigest);
        return await this.completeDeploymentRequest(request.requestId, "pass", staged.surfaceDigest, "content-addressed artifact installed disabled");
      } catch (error) {
        return this.completeDeploymentRequest(request.requestId, "fail", request.surfaceDigest, (error as Error).message);
      }
    }
    await this.reconcileDataGeneration();
    const artifact = ((await this.host.events.snapshot()).projection).artifacts.find((item) => item.id === request.artifactId);
    const receipt = artifact?.deploymentReceipts.find((item) => item.operationId === request.requestId);
    if (receipt === undefined) throw new Error(`data deployment ${request.requestId} did not complete in process`);
    return receipt;
  }

  async pendingForCurrentGeneration(): Promise<Array<{ artifactId: string; request: DeploymentRequest }>> {
    const projection = (await this.host.events.snapshot()).projection;
    return projection.artifacts.flatMap((artifact) => artifact.deploymentRequests
      .filter((request) => request.targetGeneration === this.host.processGeneration)
      .filter((request) => !artifact.deploymentReceipts.some((receipt) => receipt.operationId === request.requestId))
      .map((request) => ({ artifactId: artifact.id, request })));
  }

  async completeDeploymentRequest(
    requestId: string,
    health: "pass" | "fail",
    loadedSurfaceDigest: string,
    detail?: string,
  ): Promise<DeploymentReceipt> {
    return this.host.events.transact((projection) => {
      const artifact = projection.artifacts.find((item) => item.deploymentRequests.some((request) => request.requestId === requestId));
      if (artifact === undefined) throw new Error(`unknown deployment request ${requestId}`);
      const existing = artifact.deploymentReceipts.find((receipt) => receipt.operationId === requestId);
      if (existing !== undefined) return { events: [], value: existing };
      const request = artifact.deploymentRequests.find((item) => item.requestId === requestId) as DeploymentRequest;
      if (request.targetGeneration !== this.host.processGeneration) {
        throw new Error(`deployment request ${requestId} targets ${request.targetGeneration}, current generation is ${this.host.processGeneration}`);
      }
      let restoredTarget: ArtifactProjection | undefined;
      if (health === "pass" && request.mode === "rollback") {
        if (request.rollbackTarget === undefined) throw new Error(`rollback request ${requestId} has no target`);
        restoredTarget = assertLastKnownGood(projection, artifact, request.rollbackTarget);
      }
      const startedAt = new Date().toISOString();
      const endedAt = new Date().toISOString();
      const receipt: DeploymentReceipt = {
        receiptId: `deploy-${randomUUID()}`,
        artifactId: artifact.id,
        contentDigest: artifact.contentDigest,
        manifestDigest: artifact.manifestDigest,
        surfaceDigest: artifact.surfaceDigest,
        mode: request.mode,
        operationId: request.requestId,
        processGeneration: this.host.processGeneration,
        dshVersion: this.host.dshVersion,
        chopinVersion: this.host.chopinVersion,
        loadedSurfaceDigest,
        health,
        startedAt,
        endedAt,
        ...(request.rollbackTarget === undefined ? {} : { rollbackTarget: request.rollbackTarget }),
        ...(detail === undefined ? {} : { detail }),
      };
      assertDeploymentReceipt(receipt);
      const meta = { artifactId: artifact.id, actor: { kind: "system" as const, id: "chopin-deployment-controller" } };
      const event = health === "fail"
        ? artifactDeploymentFailed(meta, receipt)
        : request.mode === "disabled"
          ? artifactInstalledDisabled(meta, receipt)
          : request.mode === "canary"
            ? artifactCanaryActivated(meta, receipt)
            : request.mode === "active"
              ? artifactActivated(meta, receipt)
              : artifactRolledBack(meta, receipt);
      const events: EvolutionEvent[] = [event];
      if (restoredTarget?.manifest.runtime === "data") {
        const restored: DeploymentReceipt = {
          receiptId: `runtime-${randomUUID()}`,
          artifactId: restoredTarget.id,
          contentDigest: restoredTarget.contentDigest,
          manifestDigest: restoredTarget.manifestDigest,
          surfaceDigest: restoredTarget.surfaceDigest,
          mode: "active",
          operationId: `rollback-load-${request.requestId}`,
          processGeneration: this.host.processGeneration,
          dshVersion: this.host.dshVersion,
          chopinVersion: this.host.chopinVersion,
          loadedSurfaceDigest: restoredTarget.surfaceDigest,
          health: "pass",
          startedAt,
          endedAt,
          detail: `restored by rollback ${request.requestId}`,
        };
        assertDeploymentReceipt(restored);
        events.push(artifactRuntimeLoaded({
          artifactId: restoredTarget.id,
          actor: { kind: "system", id: "chopin-deployment-controller" },
        }, restored));
      }
      return { events, value: receipt };
    });
  }

  async reconcileDataGeneration(): Promise<void> {
    for (const pending of await this.pendingForCurrentGeneration()) {
      if (pending.request.mode === "disabled") continue;
      const projection = (await this.host.events.snapshot()).projection;
      const artifact = projection.artifacts.find((item) => item.id === pending.artifactId);
      if (artifact === undefined) continue;
      const target = pending.request.mode === "rollback" ? pending.request.rollbackTarget : {
        artifactId: artifact.id,
        contentDigest: artifact.contentDigest,
        surfaceDigest: artifact.surfaceDigest,
      };
      if (target === undefined) continue;
      const targetArtifact = projection.artifacts.find((item) => item.id === target.artifactId);
      if (targetArtifact?.manifest.runtime !== "data") continue;
      try {
        if (pending.request.mode === "rollback") {
          assertLastKnownGood(projection, artifact, target);
        } else if (!referenceMatchesArtifact(target, artifact)) {
          throw new Error(`deployment target ${target.artifactId} digest changed`);
        }
        const staged = await this.host.artifacts.inspect(target.contentDigest);
        if (staged.surfaceDigest !== target.surfaceDigest) throw new Error(`deployment target ${target.artifactId} surface changed`);
        await this.completeDeploymentRequest(pending.request.requestId, "pass", staged.surfaceDigest, "data capability reconciled in target generation");
      } catch (error) {
        await this.completeDeploymentRequest(pending.request.requestId, "fail", target.surfaceDigest, (error as Error).message);
      }
    }
  }

  async recordRuntimeLoaded(artifactId: string, mode: "canary" | "active", loadedSurfaceDigest: string): Promise<void> {
    const projection = (await this.host.events.snapshot()).projection;
    const artifact = projection.artifacts.find((item) => item.id === artifactId);
    if (artifact === undefined) throw new Error(`unknown artifact ${artifactId}`);
    const now = new Date().toISOString();
    const receipt: DeploymentReceipt = {
      receiptId: `runtime-${randomUUID()}`,
      artifactId,
      contentDigest: artifact.contentDigest,
      manifestDigest: artifact.manifestDigest,
      surfaceDigest: artifact.surfaceDigest,
      mode,
      operationId: `runtime-load-${createHash("sha256").update(`${this.host.processGeneration}\0${artifactId}`).digest("hex")}`,
      processGeneration: this.host.processGeneration,
      dshVersion: this.host.dshVersion,
      chopinVersion: this.host.chopinVersion,
      loadedSurfaceDigest,
      health: "pass",
      startedAt: now,
      endedAt: now,
      detail: "runtime adapter loaded exact capability surface",
    };
    const event = artifactRuntimeLoaded({ artifactId, actor: { kind: "system", id: "chopin-plugin-adapter" } }, receipt);
    const expected = artifactReferenceOf(artifact);
    await this.host.events.appendChecked([event], (current) => {
      const currentArtifact = current.artifacts.find((item) => item.id === artifactId);
      if (currentArtifact === undefined || !referenceMatchesArtifact(expected, currentArtifact)) {
        throw new Error(`runtime load target ${artifactId} changed before receipt commit`);
      }
      if (mode === "canary") {
        if (currentArtifact.state !== "canary-active") {
          throw new Error(`runtime load target ${artifactId} is ${currentArtifact.state}, not canary-active`);
        }
        return;
      }
      if (!selectFeedbackArtifacts(current).some((item) => item.id === artifactId)) {
        throw new Error(`runtime load target ${artifactId} is no longer the effective production version`);
      }
    });
  }

}
