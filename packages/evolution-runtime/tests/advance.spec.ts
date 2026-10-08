/**
 * What the host advances on its own: verify, go live, retire, resolved; what is left to the model and people goes to the queue.
 */

import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  artifactApproved,
  artifactBuilt,
  artifactDeploymentRequested,
  artifactDrafted,
  artifactQuarantined,
  artifactRetired,
  artifactVerified,
  candidateClassified,
  candidateCorroborated,
  candidateObserved,
} from "@chopin/evolution";
import type { CandidateEvidence, DeploymentRequest, FeedbackWindow } from "@chopin/evolution";
import { approvalReceipt, verificationReceipt } from "../../evolution/tests/receipt-fixtures.js";

import { EVOLUTION_QUEUE_HEADER, evolutionQueue, renderEvolutionQueue } from "../src/queue.js";
import { selectEffectiveDataArtifacts } from "../src/selection.js";
import { artifactReferenceOf, latestFeedbackDeployment } from "../src/index.js";
import {
  cleanupTemporaryDirectories,
  dataManifest,
  evolutionService,
  fakeAgent,
  gateManifest,
  lifecycle,
  stageArtifact,
  temporaryDirectory,
  userMessage,
} from "./support.js";

afterEach(cleanupTemporaryDirectories);

function evidence(id: string, sessionId: string, cls: CandidateEvidence["class"] = "session-signal"): CandidateEvidence {
  return {
    evidenceId: id,
    class: cls,
    independenceKey: sessionId,
    independentUnits: 1,
    observedAt: "2026-08-31T00:00:00.000Z",
    contentHash: `sha256:${"a".repeat(64)}`,
    summary: `Evidence ${id}`,
    sourceSessionId: sessionId,
  };
}

function approvedEvents(staged: Awaited<ReturnType<typeof stageArtifact>>) {
  const artifactId = `${staged.manifest.id}:${staged.manifest.version}`;
  const binding = { artifactId, ...staged };
  return [
    artifactDrafted({ artifactId }, { manifest: staged.manifest, contentDigest: staged.contentDigest, manifestDigest: staged.manifestDigest, surfaceDigest: staged.surfaceDigest }),
    artifactBuilt({ artifactId }, { contentDigest: staged.contentDigest, manifestDigest: staged.manifestDigest, surfaceDigest: staged.surfaceDigest, sourceRevision: "git:0123456789abcdef" }),
    artifactVerified({ artifactId }, verificationReceipt(binding)),
    artifactApproved({ artifactId }, approvalReceipt(binding)),
  ];
}

describe("advance", () => {
  it.each([false, true])("reopens the candidate after negative feedback; the fix needs approval and an old rollback cannot override it (has prior version: %s)", async (withHistory) => {
    const directory = await temporaryDirectory();
    const ctx = new Context();
    const service = evolutionService(ctx, directory);
    try {
      const value = dataManifest("repair-lesson");
      const candidateId = value.lineage.candidateIds[0] as string;
      const proposalId = value.lineage.proposalIds[0] as string;
      const staged = await stageArtifact(directory, value, "old advice\n");
      const artifactId = `${value.id}:${value.version}`;
      const previous = withHistory ? await stageArtifact(directory, { ...value, version: "0.9.0" }, "earlier advice\n") : undefined;
      await service.events.appendMany([
        ...["one", "two"].map((id) => candidateObserved({ candidateId, actor: { kind: "system", id: "observer" } }, {
          signalKey: "repair-signal", lesson: "repair lesson", evidence: evidence(id, id),
        })),
        candidateCorroborated({ candidateId }, { rootCause: "cause", trigger: value.trigger, boundaries: { includes: ["editing"], excludes: [] } }),
        candidateClassified({ candidateId }, [{ proposalId, kind: value.kind, intendedEffect: value.intendedEffect, summary: value.summary, trigger: value.trigger, requiredPermissions: value.permissions }]),
        ...(previous === undefined ? [] : lifecycle(previous)),
        ...lifecycle(staged),
      ]);
      await service.advance();
      let projection = await service.events.fold();
      expect(projection.candidates[0]?.state).toBe("resolved");
      const deployment = latestFeedbackDeployment(projection.artifacts.find((artifact) => artifact.id === artifactId) as never);
      if (deployment === undefined) throw new Error("missing active deployment");
      const window: FeedbackWindow = {
        windowId: "negative-window", deploymentReceiptId: deployment.receiptId, artifactId,
        contentDigest: staged.contentDigest, intendedEffect: "advisory", startedAt: deployment.endedAt,
        endedAt: new Date().toISOString(), eligible: 1, activated: 1, recurrence: 1, prevented: 0,
        falseTrigger: 0, falseBlock: 0, independentSuccesses: 0, taskPass: 0, taskFail: 1,
        retryDelta: 0, costDeltaUsd: 0, latencyDeltaMs: 0, evidenceRefs: ["session:failed:event:5"],
      };
      expect(await service.recordFeedback(window, { actorId: "observer", observedAt: window.endedAt })).toBe("contradict");
      projection = await service.events.fold();
      expect(projection.artifacts.find((artifact) => artifact.id === artifactId)).toMatchObject({ state: "quarantined", enabled: false });
      expect(projection.candidates[0]?.state).toBe("classified");
      expect(evolutionQueue(projection)).toEqual([expect.objectContaining({ action: "stage", id: candidateId, detail: expect.stringContaining(`replace ${artifactId}`) })]);
      expect(selectEffectiveDataArtifacts(projection)).toEqual([]);

      const revised = await stageArtifact(directory, { ...value, version: "1.0.1" }, "corrected advice\n");
      const revisedId = `${value.id}:1.0.1`;
      const lifecycleEvents = approvedEvents(revised);
      await service.events.appendMany(lifecycleEvents.slice(0, -1));
      await service.advance();
      projection = await service.events.fold();
      expect(selectEffectiveDataArtifacts(projection).map((artifact) => artifact.id)).toEqual(withHistory ? [`${value.id}:0.9.0`] : []);
      expect(evolutionQueue(projection)).toContainEqual(expect.objectContaining({ action: "approve", id: revisedId }));
      await service.events.append(lifecycleEvents.at(-1) as never);
      await service.advance();
      projection = await service.events.fold();
      expect(selectEffectiveDataArtifacts(projection).map((artifact) => artifact.id)).toEqual([revisedId]);
      expect(projection.candidates[0]?.state).toBe("resolved");
      await expect(service.requestDeployment(artifactId, "rollback", "stale-request")).rejects.toThrow(/already been replaced|cannot request rollback from rolled-back/);
    } finally { await ctx.fiber.dispose(); }
  });

  it("a data artifact goes from built all the way to active and the candidate resolves, all in this process", async () => {
    const directory = await temporaryDirectory();
    const ctx = new Context();
    const service = evolutionService(ctx, directory);
    const candidateId = "candidate-lesson";
    const staged = await stageArtifact(directory, dataManifest("lesson", { candidateId }), "body\n");
    const artifactId = `${staged.manifest.id}:${staged.manifest.version}`;
    await service.events.appendMany([
      candidateObserved({ candidateId, actor: { kind: "system", id: "observer" } }, { signalKey: "sk1:x:y:-:z", lesson: "lesson", evidence: evidence("e1", "s1") }),
      candidateObserved({ candidateId, actor: { kind: "system", id: "observer" } }, { signalKey: "sk1:x:y:-:z", lesson: "lesson", evidence: evidence("e2", "s2") }),
      candidateCorroborated({ candidateId, actor: { kind: "agent", id: "main" } }, { rootCause: "cause", trigger: { repos: ["chopin"] }, boundaries: { includes: ["x"], excludes: [] } }),
      candidateClassified({ candidateId, actor: { kind: "agent", id: "main" } }, [{
        proposalId: "proposal-lesson", kind: "memory", intendedEffect: "advisory", summary: "lesson", trigger: { repos: ["chopin"] }, requiredPermissions: [],
      }]),
      artifactDrafted({ artifactId }, { manifest: staged.manifest, contentDigest: staged.contentDigest, manifestDigest: staged.manifestDigest, surfaceDigest: staged.surfaceDigest }),
      artifactBuilt({ artifactId }, { contentDigest: staged.contentDigest, manifestDigest: staged.manifestDigest, surfaceDigest: staged.surfaceDigest, sourceRevision: `host:no-git@${staged.contentDigest}` }),
    ]);

    const first = await service.advance();
    expect(first.verified).toEqual([artifactId]);
    expect(first.deployed).toEqual([]);
    let projection = await service.events.fold();
    expect(projection.artifacts[0]?.state).toBe("verified");
    expect(evolutionQueue(projection)).toEqual([{ action: "approve", id: artifactId, detail: `memory at ${staged.contentDigest}` }]);
    expect(renderEvolutionQueue(evolutionQueue(projection))).toContain(`${EVOLUTION_QUEUE_HEADER}\n`);
    expect(renderEvolutionQueue(evolutionQueue(projection))).toContain(`- approve ${artifactId} via evolution_approve`);

    const binding = { artifactId, ...staged };
    await service.events.append(artifactApproved({ artifactId }, approvalReceipt(binding)));
    const second = await service.advance();
    expect(second.deployed).toEqual([`${artifactId}:disabled`, `${artifactId}:canary`, `${artifactId}:active`]);
    expect(second.resolved).toEqual([candidateId]);
    projection = await service.events.fold();
    expect(projection.artifacts[0]?.state).toBe("active");
    expect(projection.artifacts[0]?.deploymentReceipts.every((receipt) => receipt.processGeneration === "runtime-test-generation")).toBe(true);
    expect(projection.candidates[0]?.state).toBe("resolved");
    expect((await service.verifyArtifact(artifactId)).verdict).toBe("pass");
    expect(evolutionQueue(projection)).toEqual([]);
    expect(await service.advance()).toEqual({ verified: [], deployed: [], retired: [], resolved: [] });
    await ctx.fiber.dispose();
  });

  it("a code artifact only goes as far as this process can; the canary goes to the target generation", async () => {
    const directory = await temporaryDirectory();
    const ctx = new Context();
    const service = evolutionService(ctx, directory);
    const staged = await stageArtifact(directory, gateManifest("guard"), "export default {}\n");
    const artifactId = `${staged.manifest.id}:${staged.manifest.version}`;
    const binding = { artifactId, ...staged };
    await service.events.appendMany([
      artifactDrafted({ artifactId }, { manifest: staged.manifest, contentDigest: staged.contentDigest, manifestDigest: staged.manifestDigest, surfaceDigest: staged.surfaceDigest }),
      artifactBuilt({ artifactId }, { contentDigest: staged.contentDigest, manifestDigest: staged.manifestDigest, surfaceDigest: staged.surfaceDigest, sourceRevision: "git:0123456789abcdef" }),
      artifactVerified({ artifactId }, verificationReceipt(binding)),
      artifactApproved({ artifactId }, approvalReceipt(binding)),
    ]);
    const result = await service.advance();
    expect(result.deployed).toEqual([`${artifactId}:disabled`]);
    const artifact = (await service.events.fold()).artifacts[0];
    expect(artifact?.state).toBe("installed-disabled");
    const canary = artifact?.deploymentRequests.find((request) => request.mode === "canary");
    expect(canary?.targetGeneration).not.toBe("runtime-test-generation");
    expect(await service.advance()).toEqual({ verified: [], deployed: [], retired: [], resolved: [] });
    await ctx.fiber.dispose();
  });

  it("concurrent advance in the same instance and across stores creates one request per deployment state and leaves no orphan", async () => {
    const directory = await temporaryDirectory();
    const ctx = new Context();
    const peerCtx = new Context();
    const service = evolutionService(ctx, directory);
    const peer = evolutionService(peerCtx, directory);
    const staged = await stageArtifact(directory, dataManifest("concurrent-memory"), "body\n");
    const artifactId = `${staged.manifest.id}:${staged.manifest.version}`;
    const binding = { artifactId, ...staged };
    await service.events.appendMany([
      artifactDrafted({ artifactId }, { manifest: staged.manifest, contentDigest: staged.contentDigest, manifestDigest: staged.manifestDigest, surfaceDigest: staged.surfaceDigest }),
      artifactBuilt({ artifactId }, { contentDigest: staged.contentDigest, manifestDigest: staged.manifestDigest, surfaceDigest: staged.surfaceDigest, sourceRevision: `host:no-git@${staged.contentDigest}` }),
    ]);
    await service.verifyArtifact(artifactId);
    await service.events.append(artifactApproved({ artifactId }, approvalReceipt(binding)));

    await Promise.all([service.advance(), service.advance(), peer.advance()]);
    const artifact = (await service.events.fold()).artifacts[0];
    expect(artifact?.state).toBe("active");
    expect(artifact?.deploymentRequests.map((request) => request.mode)).toEqual(["disabled", "canary", "active"]);
    expect(artifact?.deploymentRequests.every((request) =>
      artifact.deploymentReceipts.some((receipt) => receipt.operationId === request.requestId))).toBe(true);
    await ctx.fiber.dispose();
    await peerCtx.fiber.dispose();
  });

  it("when the process stopped between request and receipt, advance reuses the original request and finishes the remaining state", async () => {
    const directory = await temporaryDirectory();
    const ctx = new Context();
    const service = evolutionService(ctx, directory);
    const staged = await stageArtifact(directory, dataManifest("recover-open-request"), "body\n");
    const artifactId = `${staged.manifest.id}:${staged.manifest.version}`;
    await service.events.appendMany(approvedEvents(staged));
    const artifact = (await service.events.fold()).artifacts[0];
    const approval = artifact?.approvalReceipts.at(-1);
    if (artifact === undefined || approval === undefined) throw new Error("fixture is not approved");
    const open: DeploymentRequest = {
      requestId: "deploy-request-before-crash",
      artifactId,
      contentDigest: artifact.contentDigest,
      manifestDigest: artifact.manifestDigest,
      surfaceDigest: artifact.surfaceDigest,
      mode: "disabled",
      targetGeneration: service.processGeneration,
      approvalReceiptId: approval.receiptId,
      requestedAt: "2026-08-31T00:00:00.000Z",
      requestedBy: "advance-before-crash",
    };
    await service.events.append(artifactDeploymentRequested({ artifactId }, open));

    await service.advance();
    const recovered = (await service.events.fold()).artifacts[0];
    expect(recovered?.state).toBe("active");
    expect(recovered?.deploymentRequests.filter((request) => request.mode === "disabled")).toEqual([open]);
    expect(recovered?.deploymentReceipts.some((receipt) => receipt.operationId === open.requestId && receipt.health === "pass")).toBe(true);
    await ctx.fiber.dispose();
  });

  it("a missing artifact closes as one failure; other artifacts keep advancing, and restoring the file does not bypass retry approval", async () => {
    const directory = await temporaryDirectory();
    const ctx = new Context();
    const service = evolutionService(ctx, directory);
    const broken = await stageArtifact(directory, dataManifest("broken-memory"), "broken\n");
    const healthy = await stageArtifact(directory, dataManifest("healthy-memory"), "healthy\n");
    await service.events.appendMany([...approvedEvents(broken), ...approvedEvents(healthy)]);
    await rm(broken.path, { recursive: true, force: true });

    const first = await service.advance();
    let projection = await service.events.fold();
    const failed = projection.artifacts.find((artifact) => artifact.manifest.id === "broken-memory");
    const passed = projection.artifacts.find((artifact) => artifact.manifest.id === "healthy-memory");
    expect(first.deployed).not.toContain(`${failed?.id}:disabled`);
    expect(failed?.state).toBe("approved");
    expect(failed?.deploymentRequests).toHaveLength(1);
    expect(failed?.deploymentReceipts).toHaveLength(1);
    expect(failed?.deploymentReceipts[0]?.health).toBe("fail");
    expect(passed?.state).toBe("active");

    await stageArtifact(directory, broken.manifest, "broken\n");
    await service.advance();
    projection = await service.events.fold();
    const recovered = projection.artifacts.find((artifact) => artifact.manifest.id === "broken-memory");
    expect(recovered?.state).toBe("approved");
    expect(recovered?.deploymentRequests.map((request) => request.mode)).toEqual(["disabled"]);
    await ctx.fiber.dispose();
  });

  it("after a data rollback the retired last-known-good re-enters the index and its body is readable", async () => {
    const directory = await temporaryDirectory();
    const ctx = new Context();
    const service = evolutionService(ctx, directory);
    const previous = await stageArtifact(directory, dataManifest("rollback-memory", { trigger: { when: "editing files" } }), "old body\n");
    const previousId = `${previous.manifest.id}:${previous.manifest.version}`;
    const currentManifest = {
      ...dataManifest("rollback-memory", { trigger: { when: "editing files" } }),
      version: "1.1.0",
      lineage: {
        candidateIds: ["candidate-rollback-memory"],
        proposalIds: ["proposal-rollback-memory-v2"],
        supersedes: { artifactId: previousId, contentDigest: previous.contentDigest, surfaceDigest: previous.surfaceDigest },
      },
    };
    const current = await stageArtifact(directory, currentManifest, "bad body\n");
    const currentId = `${current.manifest.id}:${current.manifest.version}`;
    await service.events.appendMany([
      ...lifecycle(previous),
      ...lifecycle(current),
      artifactRetired({ artifactId: previousId }, `superseded by ${currentId}`),
      artifactQuarantined({ artifactId: currentId }, "bad memory", []),
    ]);

    await service.advance();
    const projection = await service.events.fold();
    expect(projection.artifacts.map((artifact) => [artifact.id, artifact.state])).toEqual([
      [previousId, "retired"],
      [currentId, "rolled-back"],
    ]);
    expect(selectEffectiveDataArtifacts(projection).map((artifact) => artifact.id)).toEqual([previousId]);
    expect(latestFeedbackDeployment(projection.artifacts.find((artifact) => artifact.id === previousId) as never)?.operationId)
      .toMatch(/^rollback-load-/);
    const agent = fakeAgent("rollback-session", [userMessage("edit a file", Date.now())]);
    const restoredContext = await service.inlineContextsFor(agent);
    expect(restoredContext.map((item) => item.artifact.id)).toEqual([previousId]);
    expect(restoredContext[0]?.text).toContain("old body");
    expect(restoredContext[0]?.text).not.toContain("bad body");
    expect((await service.readExperience(agent, "read-rollback" as never, previousId)).body).toBe("old body");

    const futureManifest = {
      ...currentManifest,
      version: "1.2.0",
      lineage: {
        candidateIds: ["candidate-rollback-memory"],
        proposalIds: ["proposal-rollback-memory-v3"],
        supersedes: { artifactId: currentId, contentDigest: current.contentDigest, surfaceDigest: current.surfaceDigest },
      },
    };
    const future = await stageArtifact(directory, futureManifest, "future body\n");
    await service.events.appendMany(lifecycle(future));
    expect(selectEffectiveDataArtifacts(await service.events.fold()).map((artifact) => artifact.id))
      .toEqual([`${future.manifest.id}:${future.manifest.version}`]);
    await expect(service.readExperience(agent, "read-stale" as never, previousId)).rejects.toThrow(/not the effective/);
    await ctx.fiber.dispose();
  });

  it("fails closed when the LKG is concurrently quarantined before the rollback receipt commits", async () => {
    const directory = await temporaryDirectory();
    const ctx = new Context();
    const service = evolutionService(ctx, directory);
    const previous = await stageArtifact(directory, dataManifest("rollback-cas"), "old\n");
    const previousId = `${previous.manifest.id}:${previous.manifest.version}`;
    const currentManifest = {
      ...dataManifest("rollback-cas"),
      version: "1.1.0",
      lineage: {
        candidateIds: ["candidate-rollback-cas"],
        proposalIds: ["proposal-rollback-cas-v2"],
        supersedes: { artifactId: previousId, contentDigest: previous.contentDigest, surfaceDigest: previous.surfaceDigest },
      },
    };
    const current = await stageArtifact(directory, currentManifest, "bad\n");
    const currentId = `${current.manifest.id}:${current.manifest.version}`;
    await service.events.appendMany([
      ...lifecycle(previous),
      ...lifecycle(current),
      artifactRetired({ artifactId: previousId }, `superseded by ${currentId}`),
      artifactQuarantined({ artifactId: currentId }, "bad version", []),
    ]);
    const currentArtifact = (await service.events.fold()).artifacts.find((artifact) => artifact.id === currentId);
    const approval = currentArtifact?.approvalReceipts.at(-1);
    if (currentArtifact === undefined || approval === undefined) throw new Error("fixture has no current approval");
    const request: DeploymentRequest = {
      requestId: "rollback-request-raced",
      artifactId: currentId,
      contentDigest: current.contentDigest,
      manifestDigest: current.manifestDigest,
      surfaceDigest: current.surfaceDigest,
      mode: "rollback",
      targetGeneration: service.processGeneration,
      approvalReceiptId: approval.receiptId,
      requestedAt: "2026-08-31T00:00:00.000Z",
      requestedBy: "rollback-race-test",
      rollbackTarget: artifactReferenceOf((await service.events.fold()).artifacts.find((artifact) => artifact.id === previousId) as never),
    };
    await service.events.append(artifactDeploymentRequested({ artifactId: currentId }, request));
    await service.events.append(artifactQuarantined({ artifactId: previousId }, "LKG invalidated concurrently", []));

    await expect(service.completeDeploymentRequest(request.requestId, "pass", previous.surfaceDigest)).rejects.toThrow(/not active or retired/);
    const after = await service.events.fold();
    expect(after.artifacts.find((artifact) => artifact.id === currentId)?.deploymentReceipts.some((receipt) => receipt.operationId === request.requestId)).toBe(false);
    expect(selectEffectiveDataArtifacts(after)).toEqual([]);
    await ctx.fiber.dispose();
  });

  it("the queue lists only what needs judgment: eligible candidates, pending classification, pending authoring, pending approval, failed verification", async () => {
    const directory = await temporaryDirectory();
    const ctx = new Context();
    const service = evolutionService(ctx, directory);
    await service.events.appendMany([
      candidateObserved({ candidateId: "one-unit", actor: { kind: "system", id: "observer" } }, { signalKey: "sk1:a:b:-:c", lesson: "once", evidence: evidence("e1", "s1") }),
      candidateObserved({ candidateId: "two-units", actor: { kind: "system", id: "observer" } }, { signalKey: "sk1:a:b:-:d", lesson: "twice", evidence: evidence("e2", "s1") }),
      candidateObserved({ candidateId: "two-units", actor: { kind: "system", id: "observer" } }, { signalKey: "sk1:a:b:-:d", lesson: "twice", evidence: evidence("e3", "s2") }),
      candidateObserved({ candidateId: "corrected", actor: { kind: "user", id: "audit" } }, { signalKey: "sk1:user-correction:x", lesson: "user said", evidence: evidence("e4", "s3", "user-correction") }),
    ]);
    const items = evolutionQueue(await service.events.fold());
    expect(items.map((item) => [item.action, item.id])).toEqual([["corroborate", "two-units"], ["corroborate", "corrected"]]);
    expect(renderEvolutionQueue([], 10)).toBe("");
    await ctx.fiber.dispose();
  });
});
