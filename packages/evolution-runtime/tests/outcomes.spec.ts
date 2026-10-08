/**
 * Session outcomes keep the actual result, but natural execution cannot prove capability benefit on its own.
 */

import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { EvolutionEventStore, artifactExposureRecorded, candidateObserved, evaluateFeedbackWindow } from "@chopin/evolution";
import type { ArtifactProjection, EvolutionEvent } from "@chopin/evolution";

import { latestSuccessfulDeployment } from "../src/index.js";
import { acceptedSubmissionRef, cumulativeWindow, sessionOutcomeWindow } from "../src/outcomes.js";
import {
  cleanupTemporaryDirectories,
  dataManifest,
  gateManifest,
  lifecycle,
  stageArtifact,
  temporaryDirectory,
  toolCall,
  toolResult,
} from "./support.js";

afterEach(cleanupTemporaryDirectories);

const deployedAt = "2026-08-31T00:00:00.000Z";
const deployedMs = Date.parse(deployedAt);
const guarded = new Set(["submit_delivery"]);

function exposure(
  artifact: ArtifactProjection,
  sessionId: string,
  phase: "selected" | "injected" | "gate-evaluated",
  suffix: string,
  at: string,
  callId?: string,
): EvolutionEvent {
  return artifactExposureRecorded({ artifactId: artifact.id, eventId: `exposure-${sessionId}-${suffix}`, occurredAt: at }, {
    phase,
    sessionId,
    requestId: `request-${suffix}`,
    contentDigest: artifact.contentDigest,
    factsDigest: `sha256:${"a".repeat(64)}`,
    matchedSelectors: ["repos"],
    ...(phase === "gate-evaluated" ? { toolName: "submit_delivery" } : {}),
    ...(callId === undefined ? {} : { callId }),
  });
}

function recurrence(candidateId: string, sessionId: string, at: string, suffix = ""): EvolutionEvent {
  return candidateObserved({ candidateId, eventId: `observed-${sessionId}-${at}${suffix}`, occurredAt: at, actor: { kind: "system", id: "observer" } }, {
    signalKey: "sk1:tool-failure:bash:-:boom",
    lesson: "boom",
    evidence: {
      evidenceId: `evidence-${sessionId}-${at}${suffix}`,
      class: "session-signal",
      independenceKey: sessionId,
      independentUnits: 1,
      observedAt: at,
      contentHash: `sha256:${"b".repeat(64)}`,
      summary: "boom",
      sourceSessionId: sessionId,
      sourceRef: `session:${sessionId}:event:9`,
    },
  });
}

function deliveredSession(id: string, passed: boolean, atMs: number) {
  return {
    id,
    events: [toolCall("submit-1", "submit_delivery", atMs), toolResult("submit-1", atMs + 1, { isError: !passed })],
  };
}

async function activeArtifact(kind: "memory" | "gate") {
  const directory = await temporaryDirectory();
  const store = new EvolutionEventStore(join(directory, "events.jsonl"));
  const staged = kind === "memory"
    ? await stageArtifact(directory, dataManifest("lesson"), "body\n")
    : await stageArtifact(directory, gateManifest("guard"), "export default {}\n");
  await store.appendMany(lifecycle(staged, deployedAt));
  const artifact = (await store.fold()).artifacts[0] as ArtifactProjection;
  const deployment = latestSuccessfulDeployment(artifact, "active");
  if (deployment === undefined) throw new Error("fixture has no active deployment");
  return { store, artifact, deployment };
}

describe("acceptedSubmissionRef", () => {
  it("accepts only gate-guarded tools called successfully after deployment", () => {
    expect(acceptedSubmissionRef(deliveredSession("s", true, deployedMs + 1_000), guarded, deployedMs)).toMatch(/^session:s:event:\d+$/);
    expect(acceptedSubmissionRef(deliveredSession("s", false, deployedMs + 1_000), guarded, deployedMs)).toBeUndefined();
    expect(acceptedSubmissionRef(deliveredSession("s", true, deployedMs - 1_000), guarded, deployedMs)).toBeUndefined();
    expect(acceptedSubmissionRef(deliveredSession("s", true, deployedMs + 2_000), guarded, deployedMs, deployedMs + 1_000)).toBeUndefined();
    expect(acceptedSubmissionRef(deliveredSession("s", true, deployedMs + 1_000), new Set(), deployedMs)).toBeUndefined();
  });
});

describe("sessionOutcomeWindow", () => {
  it("no exposure, no outcome; read plus successful delivery records taskPass", async () => {
    const { store, artifact, deployment } = await activeArtifact("memory");
    const base = { artifact, deployment, session: deliveredSession("s1", true, deployedMs + 61_000), turn: 1, endedAt: "2026-08-31T00:02:00.000Z", guardedTools: guarded };
    expect(sessionOutcomeWindow({ ...base, events: await store.readAll() })).toBeUndefined();

    await store.appendMany([
      exposure(artifact, "s1", "selected", "list", "2026-08-31T00:00:30.000Z"),
      exposure(artifact, "s1", "injected", "read", "2026-08-31T00:01:00.000Z"),
    ]);
    const window = sessionOutcomeWindow({ ...base, events: await store.readAll() });
    expect(window).toMatchObject({ eligible: 1, activated: 1, taskPass: 1, taskFail: 0, prevented: 0, independentSuccesses: 0, recurrence: 0 });
    expect(window?.windowId.startsWith("session-")).toBe(true);
    expect(window?.evidenceRefs[0]).toBe("session:s1:turn:1");
    expect(window?.evidenceRefs[1]).toMatch(/^session:s1:event:/);
    expect(evaluateFeedbackWindow(window as never)).toBe("inactive");
  });

  it("listed but never read: eligible yes, activated no, and a successful delivery records no pass", async () => {
    const { store, artifact, deployment } = await activeArtifact("memory");
    await store.append(exposure(artifact, "s1", "selected", "list", "2026-08-31T00:00:30.000Z"));
    const window = sessionOutcomeWindow({
      artifact, deployment, events: await store.readAll(), session: deliveredSession("s1", true, deployedMs + 60_000), turn: 1, endedAt: "2026-08-31T00:02:00.000Z", guardedTools: guarded,
    });
    expect(window).toMatchObject({ eligible: 1, activated: 0, taskPass: 0, taskFail: 0 });
  });

  it("a lineage signal recurring in this session: taskFail records 1, recurrence never exceeds activated", async () => {
    const { store, artifact, deployment } = await activeArtifact("memory");
    await store.appendMany([
      exposure(artifact, "s1", "injected", "read", "2026-08-31T00:01:00.000Z"),
      recurrence("candidate-lesson", "s1", "2026-08-31T00:01:10.000Z"),
      recurrence("candidate-lesson", "s1", "2026-08-31T00:01:20.000Z"),
      recurrence("candidate-lesson", "s0", "2026-08-31T00:01:30.000Z"),
    ]);
    const window = sessionOutcomeWindow({
      artifact, deployment, events: await store.readAll(), session: deliveredSession("s1", true, deployedMs + 60_000), turn: 2, endedAt: "2026-08-31T00:02:00.000Z", guardedTools: guarded,
    });
    expect(window).toMatchObject({ activated: 1, recurrence: 1, taskFail: 1, taskPass: 0 });
  });

  it("recurrences and submissions started before the first real use are not attributed to the experience", async () => {
    const { store, artifact, deployment } = await activeArtifact("memory");
    const activatedAt = Date.parse("2026-08-31T00:01:00.000Z");
    await store.appendMany([
      recurrence("candidate-lesson", "s1", "2026-08-31T00:00:30.000Z"),
      recurrence("candidate-lesson", "s1", "2026-08-31T00:01:00.000Z", "-before-exposure"),
      exposure(artifact, "s1", "injected", "read", "2026-08-31T00:01:00.000Z"),
      recurrence("candidate-lesson", "s1", "2026-08-31T00:02:30.000Z"),
      exposure(artifact, "s1", "injected", "future-read", "2026-08-31T00:03:00.000Z"),
    ]);
    const window = sessionOutcomeWindow({
      artifact,
      deployment,
      events: await store.readAll(),
      session: {
        id: "s1",
        events: [
          toolCall("submit-before-activation", "submit_delivery", activatedAt - 1),
          toolResult("submit-before-activation", activatedAt + 1, { isError: false }),
          toolCall("submit-next-turn", "submit_delivery", Date.parse("2026-08-31T00:02:30.000Z")),
          toolResult("submit-next-turn", Date.parse("2026-08-31T00:02:31.000Z"), { isError: false }),
        ],
      },
      turn: 2,
      endedAt: "2026-08-31T00:02:00.000Z",
      guardedTools: guarded,
    });
    expect(window).toMatchObject({ activated: 1, recurrence: 0, taskPass: 0, taskFail: 0 });
  });

  it("a same-millisecond submission is attributed only when the session seq proves it came after activation", async () => {
    const { store, artifact, deployment } = await activeArtifact("memory");
    const at = "2026-08-31T00:01:00.000Z";
    const atMs = Date.parse(at);
    await store.appendMany([
      exposure(artifact, "before", "injected", "read", at, "read-after-submit"),
      exposure(artifact, "after", "injected", "read", at, "read-before-submit"),
    ]);
    const events = await store.readAll();
    const beforeSession = {
      id: "before",
      events: [
        toolCall("submit-before-read", "submit_delivery", atMs),
        toolResult("submit-before-read", atMs, { isError: false }),
        toolCall("read-after-submit", "experience_read", atMs),
      ],
    };
    const afterSession = {
      id: "after",
      events: [
        toolCall("read-before-submit", "experience_read", atMs),
        toolCall("submit-after-read", "submit_delivery", atMs),
        toolResult("submit-after-read", atMs, { isError: false }),
      ],
    };
    expect(sessionOutcomeWindow({
      artifact, deployment, events, session: beforeSession, turn: 1, endedAt: at, guardedTools: guarded,
    })).toMatchObject({ activated: 1, taskPass: 0 });
    expect(sessionOutcomeWindow({
      artifact, deployment, events, session: afterSession, turn: 1, endedAt: at, guardedTools: guarded,
    })).toMatchObject({ activated: 1, taskPass: 1 });
  });

  it("a successful delivery with the guard involved does not prove an error was prevented; a turn before deployment has no window", async () => {
    const { store, artifact, deployment } = await activeArtifact("gate");
    await store.append(exposure(artifact, "s1", "gate-evaluated", "guard", "2026-08-31T00:01:00.000Z"));
    const events = await store.readAll();
    const window = sessionOutcomeWindow({
      artifact, deployment, events, session: deliveredSession("s1", true, deployedMs + 61_000), turn: 1, endedAt: "2026-08-31T00:02:00.000Z", guardedTools: guarded,
    });
    expect(window).toMatchObject({ activated: 1, prevented: 0, taskPass: 1 });
    expect(evaluateFeedbackWindow(window!)).toBe("inactive");
    expect(sessionOutcomeWindow({
      artifact, deployment, events, session: deliveredSession("s1", true, deployedMs + 61_000), turn: 1, endedAt: "2026-08-30T00:00:00.000Z", guardedTools: guarded,
    })).toBeUndefined();
  });
});

describe("cumulativeWindow", () => {
  it("folds the latest turn of each session; two successful sessions are still an observation, not benefit proof", async () => {
    const { store, artifact, deployment } = await activeArtifact("memory");
    const events = [
      exposure(artifact, "s1", "injected", "read", "2026-08-31T00:01:00.000Z"),
      exposure(artifact, "s2", "injected", "read", "2026-08-31T00:03:00.000Z"),
    ];
    await store.appendMany(events);
    const all = await store.readAll();
    const s1turn1 = sessionOutcomeWindow({ artifact, deployment, events: all, session: { id: "s1", events: [] }, turn: 1, endedAt: "2026-08-31T00:01:30.000Z", guardedTools: guarded });
    const s1turn2 = sessionOutcomeWindow({ artifact, deployment, events: all, session: deliveredSession("s1", true, deployedMs + 90_000), turn: 2, endedAt: "2026-08-31T00:02:00.000Z", guardedTools: guarded });
    const s2 = sessionOutcomeWindow({ artifact, deployment, events: all, session: deliveredSession("s2", true, deployedMs + 200_000), turn: 1, endedAt: "2026-08-31T00:04:00.000Z", guardedTools: guarded });
    const withWindows = { ...artifact, feedbackWindows: [s1turn1, s1turn2, s2].filter((window) => window !== undefined) } as ArtifactProjection;

    const cumulative = cumulativeWindow(withWindows, deployment);
    expect(cumulative).toMatchObject({ eligible: 2, activated: 2, taskPass: 2, independentSuccesses: 0, endedAt: "2026-08-31T00:04:00.000Z" });
    expect(cumulative?.evidenceRefs).toEqual(["session:s1:turn:2", "session:s2:turn:1"]);
    expect(cumulative?.windowId.startsWith("cumulative-")).toBe(true);
    expect(evaluateFeedbackWindow(cumulative as never)).toBe("inactive");
    expect(cumulativeWindow(withWindows, deployment)?.windowId).toBe(cumulative?.windowId);

    const onlyOne = { ...artifact, feedbackWindows: [s1turn2].filter((window) => window !== undefined) } as ArtifactProjection;
    expect(evaluateFeedbackWindow(cumulativeWindow(onlyOne, deployment) as never)).toBe("inactive");
    expect(cumulativeWindow({ ...artifact, feedbackWindows: [] } as ArtifactProjection, deployment)).toBeUndefined();
  });

  it("one recurrence in a preventive cumulative window is contradict", async () => {
    const { store, artifact, deployment } = await activeArtifact("gate");
    await store.appendMany([
      exposure(artifact, "s1", "gate-evaluated", "guard", "2026-08-31T00:01:00.000Z"),
      recurrence("candidate-guard", "s1", "2026-08-31T00:01:10.000Z"),
    ]);
    const window = sessionOutcomeWindow({
      artifact, deployment, events: await store.readAll(), session: { id: "s1", events: [] }, turn: 1, endedAt: "2026-08-31T00:02:00.000Z", guardedTools: guarded,
    });
    const cumulative = cumulativeWindow({ ...artifact, feedbackWindows: [window as never] } as ArtifactProjection, deployment);
    expect(evaluateFeedbackWindow(cumulative as never)).toBe("contradict");
  });
});
