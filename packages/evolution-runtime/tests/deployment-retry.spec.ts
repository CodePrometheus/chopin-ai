import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  ArtifactStore,
  artifactApproved,
  artifactBuilt,
  artifactDeploymentRequested,
  artifactDrafted,
  artifactVerified,
  capabilityManifestDigest,
  capabilitySurfaceDigest,
} from "@chopin/evolution";
import { approvalReceipt, verificationReceipt } from "../../evolution/tests/receipt-fixtures.js";
import { ChopinEvolution } from "../src/index.js";
import { evolutionQueue, renderEvolutionQueue } from "../src/queue.js";
import { cleanupTemporaryDirectories, dataManifest, temporaryDirectory } from "./support.js";

const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.restoreAllMocks();
  await cleanupTemporaryDirectories();
});

async function harness() {
  const root = await temporaryDirectory("deployment-retry-");
  const manifest = dataManifest("retry-lesson");
  const binding = {
    artifactId: `${manifest.id}:${manifest.version}`,
    manifest,
    contentDigest: `sha256:${"a".repeat(64)}`,
    manifestDigest: capabilityManifestDigest(manifest),
    surfaceDigest: capabilitySurfaceDigest(manifest),
  };
  const meta = { artifactId: binding.artifactId };
  const digests = { contentDigest: binding.contentDigest, manifestDigest: binding.manifestDigest, surfaceDigest: binding.surfaceDigest };
  const auditEvents: Array<{ type: string; time: number; data: Record<string, unknown> }> = [];
  const agent = { session: { id: "retry-session", snapshotEvents: () => [...auditEvents] } } as unknown as Parameters<ChopinEvolution["retryDeployment"]>[0];
  let allowed = true;
  let auditIndex = 0;
  let held: { pending: number; release: () => void; released: Promise<void> } | undefined;
  const approval = vi.fn(async (request: { callId: string; reason: string }) => {
    if (held !== undefined) {
      held.pending -= 1;
      if (held.pending === 0) held.release();
      await held.released;
    }
    auditIndex += 1;
    const id = `retry-audit-${auditIndex}`;
    const outcome = allowed ? "allowed-once" : "rejected";
    auditEvents.push({ type: "approval/asked", time: Date.now(), data: { id, callId: request.callId } });
    auditEvents.push({ type: "approval/decided", time: Date.now(), data: { id, outcome } });
    return outcome;
  });
  const inspect = vi.spyOn(ArtifactStore.prototype, "inspect").mockRejectedValue(new Error("artifact inspection failed"));
  /** A fresh service over the same on-disk state, as a restarted process would build it. */
  function service() {
    const ctx = new Context();
    contexts.push(ctx);
    ctx.provide("approval", { request: approval });
    return new ChopinEvolution(ctx, {
      eventsFile: join(root, "events.jsonl"), artifactsDir: join(root, "artifacts"), receiptsDir: join(root, "receipts"),
      chopinVersion: "1.0.0", dshVersion: "1.0.0", processGeneration: "memory-generation", autonomous: false,
    });
  }
  const events = service().events;
  await events.appendMany([
    artifactDrafted(meta, { manifest, ...digests }),
    artifactBuilt(meta, { ...digests, sourceRevision: "git:0123456789abcdef" }),
    artifactVerified(meta, verificationReceipt(binding)),
    artifactApproved(meta, approvalReceipt(binding)),
  ]);
  /** Keep approvals pending until `count` of them are open, as when two people approve the same prompt. */
  function holdApprovals(count: number) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    held = { pending: count, release, released };
  }
  return { service, events, agent, binding, approval, inspect, holdApprovals, reject: () => { allowed = false; } };
}

describe("deployment failure recovery", () => {
  it("repeated advances and reconstructed services preserve one failed request and expose recovery", async () => {
    const setup = await harness();
    const service = setup.service();
    await service.advance();
    await Promise.all([service.advance(), setup.service().advance(), setup.service().advance()]);
    const projection = await setup.events.fold();
    expect(projection.artifacts[0]?.deploymentRequests).toHaveLength(1);
    expect(projection.artifacts[0]?.deploymentReceipts).toHaveLength(1);
    expect(setup.inspect).toHaveBeenCalledTimes(1);
    const queue = evolutionQueue(projection);
    expect(queue).toEqual([expect.objectContaining({ action: "retry", id: setup.binding.artifactId })]);
    expect(renderEvolutionQueue(queue)).toContain("evolution_deployment_retry");
    expect(queue[0]?.detail).toContain(projection.artifacts[0]?.deploymentReceipts[0]?.receiptId);
  });

  it("one exact user approval authorizes one retry; another failure stops again", async () => {
    const setup = await harness();
    const service = setup.service();
    await service.advance();
    const failure = (await setup.events.fold()).artifacts[0]!.deploymentReceipts[0]!;
    const result = await service.retryDeployment(setup.agent, "retry-call" as never, setup.binding.artifactId, setup.binding.contentDigest, failure.receiptId);
    expect(result.outcome).toBe("allowed-once");
    expect(result.request?.retryOf).toBe(failure.receiptId);
    expect(result.request?.retryApproval?.approvalAuditId).toBe("retry-audit-1");
    expect(setup.approval.mock.calls[0]?.[0].reason).toContain(failure.receiptId);
    expect(setup.approval.mock.calls[0]?.[0].reason).toContain(setup.binding.contentDigest);
    await service.advance();
    expect((await setup.events.fold()).artifacts[0]?.deploymentRequests).toHaveLength(2);
    await expect(service.retryDeployment(setup.agent, "stale-call" as never, setup.binding.artifactId, setup.binding.contentDigest, failure.receiptId)).rejects.toThrow("no longer current");
    expect(setup.approval).toHaveBeenCalledTimes(1);
  });

  it("rejection leaves the failed operation unchanged", async () => {
    const setup = await harness();
    const service = setup.service();
    await service.advance();
    const before = await setup.events.fold();
    const failure = before.artifacts[0]!.deploymentReceipts[0]!;
    setup.reject();
    const result = await service.retryDeployment(setup.agent, "reject-call" as never, setup.binding.artifactId, setup.binding.contentDigest, failure.receiptId);
    expect(result).toEqual({ outcome: "rejected" });
    expect(await setup.events.fold()).toEqual(before);
  });

  it("concurrent approvals of the same failure converge on one retry request", async () => {
    const setup = await harness();
    await setup.service().advance();
    const failure = (await setup.events.fold()).artifacts[0]!.deploymentReceipts[0]!;
    setup.holdApprovals(2);
    const retry = (call: string) => setup.service().retryDeployment(setup.agent, call as never, setup.binding.artifactId, setup.binding.contentDigest, failure.receiptId);
    const results = await Promise.all([retry("retry-left"), retry("retry-right")]);
    expect(results[0]?.request?.requestId).toBe(results[1]?.request?.requestId);
    const artifact = (await setup.events.fold()).artifacts[0]!;
    expect(artifact.deploymentRequests).toHaveLength(2);
    expect(artifact.deploymentReceipts).toHaveLength(2);
  });

  it("a consumed retry approval cannot authorize a later failure", async () => {
    const setup = await harness();
    const service = setup.service();
    await service.advance();
    const firstFailure = (await setup.events.fold()).artifacts[0]!.deploymentReceipts[0]!;
    const approved = await service.retryDeployment(setup.agent, "retry-call" as never, setup.binding.artifactId, setup.binding.contentDigest, firstFailure.receiptId);
    const artifact = (await setup.events.fold()).artifacts[0]!;
    const nextFailure = artifact.deploymentReceipts.at(-1)!;
    const requestedAt = new Date().toISOString();
    const request = {
      ...approved.request!, requestId: "reused-approval-request", requestedAt, retryOf: nextFailure.receiptId,
      retryApproval: { ...approved.request!.retryApproval!, decidedAt: requestedAt },
    };
    await expect(setup.events.transact(() => ({
      events: [artifactDeploymentRequested({ artifactId: artifact.id, actor: { kind: "system", id: "chopin-deployment-retry" } }, request)],
      value: undefined,
    }))).rejects.toThrow("already been used");
  });

  it("event replay rejects unapproved retries and agent-authored approvals", async () => {
    const setup = await harness();
    await setup.service().advance();
    const artifact = (await setup.events.fold()).artifacts[0]!;
    const failedRequest = artifact.deploymentRequests[0]!;
    const failure = artifact.deploymentReceipts[0]!;
    const retry = { ...failedRequest, requestId: "unauthorized-retry", requestedAt: new Date().toISOString() };
    await expect(setup.events.transact(() => ({
      events: [artifactDeploymentRequested({ artifactId: artifact.id }, retry)], value: undefined,
    }))).rejects.toThrow("requires approval");
    const retryApproval = {
      ...approvalReceipt(setup.binding), receiptId: "new-approval", approvalAuditId: "new-audit", actor: "host-approval-seam",
      decidedAt: retry.requestedAt,
    };
    await expect(setup.events.transact(() => ({
      events: [artifactDeploymentRequested({ artifactId: artifact.id, actor: { kind: "agent", id: "model" } }, {
        ...retry, retryOf: failure.receiptId, retryApproval,
      })], value: undefined,
    }))).rejects.toThrow("host approval seam");
  });
});
