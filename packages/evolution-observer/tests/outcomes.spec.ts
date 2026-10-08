/**
 * The observer's two newer duties: failure signatures carry a gate dimension, and turn end writes session outcomes folded into a cumulative window.
 */

import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import { GATE_DENIAL_TRAILER } from "@chopin/gate";
import { artifactExposureRecorded, artifactQuarantined, artifactRetired, candidateObserved, foldEvolutionEvents } from "@chopin/evolution";
import type { ArtifactProjection } from "@chopin/evolution";
import { ChopinEvolution, latestFeedbackDeployment } from "@chopin/evolution-runtime";
import {
  cleanupTemporaryDirectories,
  dataManifest,
  evolutionService,
  fakeAgent,
  gateManifest,
  lifecycle,
  stageArtifact,
  temporaryDirectory,
  toolCall,
  toolResult,
  turnEnd,
  userMessage,
} from "../../evolution-runtime/tests/support.js";

import { observeToolFailure, recordSessionOutcomes, recurrenceWindow } from "../src/index.js";

afterEach(cleanupTemporaryDirectories);

function failure(sessionId: string, tool: string, text: string): { session: Pick<Session, "id" | "snapshotEvents">; event: Extract<SessionEvent, { type: "tool/result" }> } {
  const events = [toolCall("call-one", tool, 1_777_766_400_000), toolResult("call-one", 1_777_766_401_000, { isError: true, text })];
  return { session: { id: SessionId(sessionId), snapshotEvents: () => [...events] }, event: events[1] as Extract<SessionEvent, { type: "tool/result" }> };
}

describe("failure signature", () => {
  it("gate denials cluster by unmet rule id; an ordinary failure has - as its gate segment", () => {
    const denial = (gate: string) => `Rejected by 1 unmet investigation gate(s):\n- ${gate}: do it\n${GATE_DENIAL_TRAILER} ${gate}`;
    const verified = failure("s1", "submit_delivery", denial("verified"));
    const reviewed = failure("s2", "submit_delivery", denial("diff-reviewed"));
    const plain = failure("s3", "bash", "spawn EBADF at /tmp/build-123");
    const one = observeToolFailure(verified.session, verified.event);
    const two = observeToolFailure(reviewed.session, reviewed.event);
    const three = observeToolFailure(plain.session, plain.event);
    expect(one?.data.signalKey).toMatch(/^sk1:gate-rejection:submit_delivery:verified:/);
    expect(two?.data.signalKey).toMatch(/^sk1:gate-rejection:submit_delivery:diff-reviewed:/);
    expect(one?.entityId).not.toBe(two?.entityId);
    expect(three?.data.signalKey).toBe("sk1:tool-failure:bash:-:spawn EBADF at <path>");
  });
});

describe("recurrenceWindow", () => {
  it("one advisory recurrence does not convict immediately; it is judged by delivery in the cumulative window only", async () => {
    const directory = await temporaryDirectory();
    const staged = await stageArtifact(directory, dataManifest("lesson"), "body\n");
    const events = lifecycle(staged);
    const artifact = foldEvolutionEvents(events).artifacts[0] as ArtifactProjection;
    const plain = failure("s1", "bash", "boom");
    const observed = observeToolFailure(plain.session, plain.event);
    expect(recurrenceWindow(artifact, events, "s1", observed as never)).toBeUndefined();
  });

  it("an exposure in the same millisecond but ordered after the failure is not attributed backwards", async () => {
    const directory = await temporaryDirectory();
    const candidateId = "candidate-tie-order";
    const staged = await stageArtifact(directory, gateManifest("tie-order", candidateId), "export default {}\n");
    const lifecycleEvents = lifecycle(staged);
    const artifact = foldEvolutionEvents(lifecycleEvents).artifacts[0] as ArtifactProjection;
    const occurredAt = "2026-08-31T00:01:00.000Z";
    const observed = candidateObserved({
      candidateId,
      eventId: "observed-before-exposure",
      occurredAt,
      actor: { kind: "system", id: "test-observer" },
    }, {
      signalKey: "sk1:tool-failure:bash:-:tie",
      lesson: "tie",
      evidence: {
        evidenceId: "evidence-before-exposure",
        class: "session-signal",
        independenceKey: "s1",
        independentUnits: 1,
        observedAt: occurredAt,
        contentHash: `sha256:${"a".repeat(64)}`,
        summary: "tie",
        sourceSessionId: "s1",
        sourceRef: "session:s1:event:1",
      },
    });
    const laterExposure = artifactExposureRecorded({ artifactId: artifact.id, eventId: "exposure-after-observed", occurredAt }, {
      phase: "gate-evaluated",
      sessionId: "s1",
      requestId: "request-after",
      contentDigest: artifact.contentDigest,
      factsDigest: `sha256:${"b".repeat(64)}`,
      matchedSelectors: ["repos"],
      toolName: "submit_delivery",
    });
    expect(recurrenceWindow(artifact, [...lifecycleEvents, observed, laterExposure], "s1", observed))
      .toMatchObject({ eligible: 0, activated: 0, recurrence: 0, taskFail: 0 });
  });
});

describe("recordSessionOutcomes", () => {
  it("the same code version accumulates delivery observations across processes, waits for usage records to land, and produces no benefit proof", async () => {
    const directory = await temporaryDirectory();
    const value = {
      ...dataManifest("shared-advice"), kind: "tool" as const, runtime: "dsh-plugin" as const,
      entry: "index.mjs", permissions: ["tools:register"],
      provides: { contexts: [], skills: [], guards: [], tools: ["suggest"], services: [], workflows: [] },
      requires: { chopinPluginApi: "^1.0.0", dsh: "0.1.3-alpha.1" },
    };
    const staged = await stageArtifact(directory, value, "export default {}\n");
    const artifactId = `${value.id}:${value.version}`;
    let epoch: string | undefined;
    for (const generation of ["process-one", "process-two"]) {
      const ctx = new Context();
      ctx.provide("chopinGates", { guardedTools: () => ["submit_delivery"] });
      const service = new ChopinEvolution(ctx, {
        eventsFile: join(directory, "events.jsonl"), artifactsDir: join(directory, "artifacts"),
        receiptsDir: join(directory, "receipts"), chopinVersion: "0.1.0", dshVersion: "0.1.3-alpha.1",
        processGeneration: generation,
      });
      try {
        if (generation === "process-one") await service.events.appendMany(lifecycle(staged));
        await service.recordRuntimeLoaded(artifactId, "active", staged.surfaceDigest);
        const current = (await service.events.fold()).artifacts[0] as ArtifactProjection;
        epoch ??= latestFeedbackDeployment(current)?.receiptId;
        expect(latestFeedbackDeployment(current)?.receiptId).toBe(epoch);
        const base = Date.now();
        const writing = service.recordExposure(artifactId, {
          phase: "tool-called", sessionId: generation, requestId: `use-${generation}`, callId: `use-${generation}`,
          toolName: "suggest", contentDigest: staged.contentDigest, factsDigest: `sha256:${"a".repeat(64)}`,
          matchedSelectors: ["repos"],
        }, `exposure-${generation}`, new Date(base).toISOString());
        const sessionEvents = [toolCall("submit", "submit_delivery", base + 1_000), toolResult("submit", base + 2_000)];
        await recordSessionOutcomes(ctx, { id: SessionId(generation), snapshotEvents: () => sessionEvents }, turnEnd(1, base + 3_000));
        await writing;
        const updated = (await service.events.fold()).artifacts[0] as ArtifactProjection;
        const cumulative = updated.feedbackWindows.filter((window) => window.windowId.startsWith("cumulative-")).at(-1);
        expect(cumulative?.independentSuccesses).toBe(0);
        expect(updated.trust).toBe("provisional");
      } finally { await ctx.fiber.dispose(); }
    }
  });

  it("two sessions' successes accumulate, but task success alone cannot declare the experience effective", async () => {
    const directory = await temporaryDirectory();
    const ctx = new Context();
    ctx.provide("chopinGates", { guardedTools: () => ["submit_delivery"] });
    const service = evolutionService(ctx, directory);
    const deployedAt = "2026-08-31T00:00:00.000Z";
    const staged = await stageArtifact(directory, dataManifest("lesson"), "body\n");
    await service.events.appendMany(lifecycle(staged, deployedAt));
    const artifactId = `${staged.manifest.id}:${staged.manifest.version}`;

    const runSession = async (sessionId: string, turn: number, offsetMs: number) => {
      const base = Date.parse(deployedAt) + offsetMs;
      await service.events.append(artifactExposureRecorded({
        artifactId,
        eventId: `exposure-${sessionId}`,
        occurredAt: new Date(base).toISOString(),
      }, {
        phase: "injected",
        sessionId,
        requestId: `read-${sessionId}`,
        contentDigest: staged.contentDigest,
        factsDigest: `sha256:${"a".repeat(64)}`,
        matchedSelectors: ["repos"],
        toolName: "experience_read",
        callId: `read-${sessionId}`,
      }));
      const sessionEvents = [toolCall("submit", "submit_delivery", base + 1_000), toolResult("submit", base + 2_000)];
      const session = {
        id: SessionId(sessionId),
        snapshotEvents: () => [...sessionEvents],
      };
      await recordSessionOutcomes(ctx, session, turnEnd(turn, base + 3_000));
    };

    await runSession("s1", 1, 60_000);
    let artifact = (await service.events.fold()).artifacts[0] as ArtifactProjection;
    expect(artifact.feedbackWindows.map((window) => window.windowId.split("-")[0])).toEqual(["session", "cumulative"]);
    expect(artifact.trust).toBe("provisional");

    await runSession("s1", 1, 60_000);
    expect((await service.events.fold()).artifacts[0]?.feedbackWindows).toHaveLength(2);

    await runSession("s2", 1, 120_000);
    artifact = (await service.events.fold()).artifacts[0] as ArtifactProjection;
    expect(artifact.trust).toBe("provisional");
    const cumulative = artifact.feedbackWindows.filter((window) => window.windowId.startsWith("cumulative-")).at(-1);
    expect(cumulative).toMatchObject({ independentSuccesses: 0, taskPass: 2, activated: 2 });
    expect((await service.events.readAll()).filter((event) => event.type === "artifact.trusted")).toHaveLength(0);
    await ctx.fiber.dispose();
  });

  it("a data rollback opens a new feedback epoch for the retired LKG, and a session outcome can be written after a read", async () => {
    const directory = await temporaryDirectory();
    const ctx = new Context();
    ctx.provide("chopinGates", { guardedTools: () => ["submit_delivery"] });
    const service = evolutionService(ctx, directory);
    const previous = await stageArtifact(directory, dataManifest("restored-memory", { trigger: { when: "editing files" } }), "old body\n");
    const previousId = `${previous.manifest.id}:${previous.manifest.version}`;
    const currentManifest = {
      ...dataManifest("restored-memory", { trigger: { when: "editing files" } }),
      version: "1.1.0",
      lineage: {
        candidateIds: ["candidate-restored-memory"],
        proposalIds: ["proposal-restored-memory-v2"],
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
    let restored = (await service.events.fold()).artifacts.find((artifact) => artifact.id === previousId) as ArtifactProjection;
    const deployment = latestFeedbackDeployment(restored);
    expect(deployment?.operationId).toMatch(/^rollback-load-/);

    if (deployment === undefined) throw new Error("fixture has no restored deployment");
    const runSession = async (sessionId: string) => {
      const agent = fakeAgent(sessionId, [userMessage("edit a file", Date.now())]);
      await service.readExperience(agent, `read-${sessionId}` as never, previousId);
      const exposure = (await service.events.readAll()).findLast((event) =>
        event.entityId === previousId
        && event.type === "artifact.exposure-recorded"
        && event.data.sessionId === sessionId);
      if (exposure === undefined) throw new Error("fixture has no restored exposure");
      const base = Date.parse(exposure.occurredAt);
      const sessionEvents = [toolCall(`submit-${sessionId}`, "submit_delivery", base + 1), toolResult(`submit-${sessionId}`, base + 2)];
      const session = {
        id: SessionId(sessionId),
        snapshotEvents: () => [...sessionEvents],
      };
      await recordSessionOutcomes(ctx, session, turnEnd(1, base + 3));
    };
    await runSession("restored-session-one");
    await runSession("restored-session-two");

    restored = (await service.events.fold()).artifacts.find((artifact) => artifact.id === previousId) as ArtifactProjection;
    expect(restored.state).toBe("retired");
    expect(restored.trust).toBe("provisional");
    expect(restored.feedbackWindows).toHaveLength(4);
    expect(restored.feedbackWindows.every((window) => window.deploymentReceiptId === deployment.receiptId)).toBe(true);
    expect(restored.feedbackWindows[0]).toMatchObject({ startedAt: deployment.endedAt, activated: 1, taskPass: 1 });
    await ctx.fiber.dispose();
  });
});
