import { describe, expect, it } from "vitest";

import {
  artifactActivated,
  artifactApproved,
  artifactBuilt,
  artifactCanaryActivated,
  artifactDrafted,
  artifactDeploymentRequested,
  artifactFeedbackRecorded,
  artifactInstalledDisabled,
  artifactRetired,
  artifactRuntimeLoaded,
  artifactTrusted,
  artifactVerified,
  evaluateFeedbackWindow,
  foldEvolutionEvents,
} from "../src/index.js";
import type { CapabilityManifest, FeedbackWindow } from "../src/index.js";
import { approvalReceipt, deploymentReceipt, deploymentRequest, verificationReceipt } from "./receipt-fixtures.js";

const digest = `sha256:${"e".repeat(64)}`;
const manifest: CapabilityManifest = {
  schemaVersion: 1,
  id: "gate-read-first",
  version: "1.0.0",
  kind: "gate",
  runtime: "dsh-plugin",
  intendedEffect: "preventive",
  summary: "Require read before edit.",
  entry: "index.js",
  trigger: { tools: ["str_replace_editor"] },
  provides: { contexts: [], skills: [], guards: ["read-first"], tools: [], services: [], workflows: [] },
  permissions: ["tools:guard"],
  dependencies: [],
  conflicts: [],
  requires: { chopinPluginApi: "^1.0.0", dsh: "0.1.1-rc.2" },
  lineage: { candidateIds: ["read-before-edit"], proposalIds: ["gate-read-first"] },
};

function activeLifecycle() {
  const artifactId = "gate-read-first:1.0.0";
  const draft = artifactDrafted({ artifactId }, { manifest, contentDigest: digest });
  const binding = {
    artifactId,
    contentDigest: digest,
    manifestDigest: draft.data.manifestDigest as string,
    surfaceDigest: draft.data.surfaceDigest as string,
    manifest,
  };
  const activeDeployment = deploymentReceipt(binding, "active");
  return {
    artifactId,
    binding,
    activeDeployment,
    events: [
      draft,
      artifactBuilt({ artifactId }, {
        contentDigest: binding.contentDigest,
        manifestDigest: binding.manifestDigest,
        surfaceDigest: binding.surfaceDigest,
        sourceRevision: "git:0123456789abcdef",
      }),
      artifactVerified({ artifactId }, verificationReceipt(binding)),
      artifactApproved({ artifactId }, approvalReceipt(binding)),
      artifactDeploymentRequested({ artifactId }, deploymentRequest(binding, "disabled")),
      artifactInstalledDisabled({ artifactId }, deploymentReceipt(binding, "disabled")),
      artifactDeploymentRequested({ artifactId }, deploymentRequest(binding, "canary")),
      artifactCanaryActivated({ artifactId }, deploymentReceipt(binding, "canary")),
      artifactDeploymentRequested({ artifactId }, deploymentRequest(binding, "active")),
      artifactActivated({ artifactId }, activeDeployment),
    ],
  };
}

function window(overrides: Partial<FeedbackWindow> = {}): FeedbackWindow {
  const lifecycle = activeLifecycle();
  return {
    windowId: "window-one",
    deploymentReceiptId: lifecycle.activeDeployment.receiptId,
    artifactId: lifecycle.artifactId,
    contentDigest: digest,
    intendedEffect: "preventive",
    startedAt: "2026-08-31T00:00:00.000Z",
    endedAt: "2026-08-31T01:00:00.000Z",
    eligible: 3,
    activated: 3,
    recurrence: 0,
    prevented: 3,
    falseTrigger: 0,
    falseBlock: 0,
    independentSuccesses: 3,
    taskPass: 3,
    taskFail: 0,
    retryDelta: -2,
    costDeltaUsd: -0.1,
    latencyDeltaMs: -100,
    evidenceRefs: ["session-one", "session-two"],
    ...overrides,
  };
}

describe("feedback verdict", () => {
  it("without eligible exposure the verdict can only be inactive", () => {
    expect(evaluateFeedbackWindow(window({ eligible: 0, activated: 0, prevented: 0, independentSuccesses: 0, taskPass: 0 }))).toBe("inactive");
  });

  it("a preventive recurrence is a contradiction, and a false block quarantines immediately", () => {
    expect(evaluateFeedbackWindow(window({ recurrence: 1, prevented: 2 }))).toBe("contradict");
    expect(evaluateFeedbackWindow(window({ falseBlock: 1 }))).toBe("quarantine");
  });

  it("failing more often than passing is a contradiction for either effect, however it started", () => {
    expect(evaluateFeedbackWindow(window({ intendedEffect: "advisory", independentSuccesses: 1, taskPass: 1, taskFail: 2, prevented: 0 }))).toBe("contradict");
    expect(evaluateFeedbackWindow(window({ recurrence: 0, prevented: 0, independentSuccesses: 0, taskPass: 1, taskFail: 2 }))).toBe("contradict");
    expect(evaluateFeedbackWindow(window({ intendedEffect: "advisory", independentSuccesses: 2, taskPass: 2, taskFail: 1, prevented: 0 }))).toBe("confirm");
  });

  it("advisory needs at least two independent successes and cannot be confirmed by the absence of recurrence", () => {
    expect(evaluateFeedbackWindow(window({ intendedEffect: "advisory", independentSuccesses: 1, taskPass: 1, prevented: 0 }))).toBe("inactive");
    expect(evaluateFeedbackWindow(window({ intendedEffect: "advisory", independentSuccesses: 2, taskPass: 2, prevented: 0 }))).toBe("confirm");
  });

  it("successes, false triggers and task counts cannot exceed the actual activation count", () => {
    expect(() => evaluateFeedbackWindow(window({
      eligible: 1,
      activated: 1,
      prevented: 0,
      independentSuccesses: 2,
      taskPass: 1,
    }))).toThrow(/independentSuccesses exceeds activated/);
    expect(() => evaluateFeedbackWindow(window({
      eligible: 1,
      activated: 1,
      prevented: 0,
      independentSuccesses: 1,
      taskPass: 1,
      taskFail: 1,
    }))).toThrow(/taskPass \+ taskFail exceeds activated/);
  });
});

describe("feedback state", () => {
  it("only a confirm window can mark an active artifact trusted", () => {
    const lifecycle = activeLifecycle();
    const confirmed = window();
    const projection = foldEvolutionEvents([
      ...lifecycle.events,
      artifactFeedbackRecorded({ artifactId: lifecycle.artifactId }, confirmed),
      artifactTrusted({ artifactId: lifecycle.artifactId }, confirmed.windowId),
    ]);
    expect(projection.artifacts[0]?.trust).toBe("trusted");
    expect(projection.artifacts[0]?.feedbackWindows).toHaveLength(1);
  });

  it("an inactive window cannot fake trusted", () => {
    const lifecycle = activeLifecycle();
    const inactive = window({ eligible: 0, activated: 0, prevented: 0, independentSuccesses: 0, taskPass: 0 });
    expect(() => foldEvolutionEvents([
      ...lifecycle.events,
      artifactFeedbackRecorded({ artifactId: lifecycle.artifactId }, inactive),
      artifactTrusted({ artifactId: lifecycle.artifactId }, inactive.windowId),
    ])).toThrow(/not confirm/);
  });

  it("feedback effect and deployment receipt must belong to the current deployment", () => {
    const lifecycle = activeLifecycle();
    expect(() => foldEvolutionEvents([
      ...lifecycle.events,
      artifactFeedbackRecorded({ artifactId: lifecycle.artifactId }, window({ intendedEffect: "advisory", prevented: 0 })),
    ])).toThrow(/intendedEffect differs/);

    const newerRuntime = {
      ...lifecycle.activeDeployment,
      receiptId: "runtime-active-current",
      operationId: "runtime-active-current",
    };
    const reloaded = foldEvolutionEvents([
      ...lifecycle.events,
      artifactRuntimeLoaded({ artifactId: lifecycle.artifactId }, newerRuntime),
      artifactFeedbackRecorded({ artifactId: lifecycle.artifactId }, window()),
    ]).artifacts[0];
    expect(reloaded?.feedbackDeploymentReceiptId).toBe(lifecycle.activeDeployment.receiptId);
    expect(reloaded?.deploymentReceipts).toContainEqual(newerRuntime);
    expect(() => foldEvolutionEvents([
      ...lifecycle.events,
      artifactRuntimeLoaded({ artifactId: lifecycle.artifactId }, newerRuntime),
      artifactFeedbackRecorded({ artifactId: lifecycle.artifactId }, window({ deploymentReceiptId: newerRuntime.receiptId })),
    ])).toThrow(/current successful deployment/);
  });

  it("a retired artifact cannot regain trusted from an old confirm window", () => {
    const lifecycle = activeLifecycle();
    const confirmed = window();
    expect(() => foldEvolutionEvents([
      ...lifecycle.events,
      artifactFeedbackRecorded({ artifactId: lifecycle.artifactId }, confirmed),
      artifactTrusted({ artifactId: lifecycle.artifactId }, confirmed.windowId),
      artifactRetired({ artifactId: lifecycle.artifactId }, "superseded"),
      artifactTrusted({ artifactId: lifecycle.artifactId }, confirmed.windowId),
    ])).toThrow(/current successful deployment/);
  });
});
