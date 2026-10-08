import { describe, expect, it } from "vitest";
import type { Session } from "@deepseek-ai/dsh-session";

import type {
  ApprovalReceipt,
  ArtifactProjection,
  ArtifactReference,
  CapabilityManifest,
  DeploymentMode,
  DeploymentReceipt,
  DeploymentRequest,
  EvolutionProjection,
} from "@chopin/evolution";

import {
  assertLoadContract,
  controllerDeployments,
  satisfiesVersionRange,
  selectProductionArtifacts,
  successfulCalls,
} from "../src/index.js";

const hashes = {
  content: `sha256:${"a".repeat(64)}`,
  manifest: `sha256:${"b".repeat(64)}`,
  surface: `sha256:${"c".repeat(64)}`,
};

function manifest(
  id: string,
  version: string,
  options: {
    supersedes?: ArtifactReference;
    dependencies?: CapabilityManifest["dependencies"];
    conflicts?: string[];
    dsh?: string;
  } = {},
): CapabilityManifest {
  return {
    schemaVersion: 1,
    id,
    version,
    kind: "tool",
    runtime: "dsh-plugin",
    intendedEffect: "preventive",
    summary: `${id} ${version}`,
    entry: "index.js",
    trigger: { repos: ["chopin"] },
    provides: { contexts: [], skills: [], guards: [], tools: [id], services: [], workflows: [] },
    permissions: ["tools:register"],
    dependencies: options.dependencies ?? [],
    conflicts: options.conflicts ?? [],
    requires: { chopinPluginApi: "^1.0.0", dsh: options.dsh ?? "0.1.1-rc.2" },
    lineage: {
      candidateIds: [`candidate-${id}-${version}`],
      proposalIds: [`proposal-${id}-${version}`],
      ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
    },
  };
}

function reference(artifact: ArtifactProjection): ArtifactReference {
  return { artifactId: artifact.id, contentDigest: artifact.contentDigest, surfaceDigest: artifact.surfaceDigest };
}

function request(artifact: ArtifactProjection, mode: DeploymentMode, rollbackTarget?: ArtifactReference): DeploymentRequest {
  return {
    requestId: `request-${mode}-${artifact.id}`,
    artifactId: artifact.id,
    contentDigest: artifact.contentDigest,
    manifestDigest: artifact.manifestDigest,
    surfaceDigest: artifact.surfaceDigest,
    mode,
    targetGeneration: `generation-${mode}`,
    approvalReceiptId: `approval-${artifact.id}`,
    requestedAt: "2026-08-31T00:00:00.000Z",
    requestedBy: "test-agent",
    ...(rollbackTarget === undefined ? {} : { rollbackTarget }),
  };
}

function receipt(artifact: ArtifactProjection, mode: "active"): DeploymentReceipt {
  const deploymentRequest = request(artifact, mode);
  return {
    receiptId: `receipt-${mode}-${artifact.id}`,
    artifactId: artifact.id,
    contentDigest: artifact.contentDigest,
    manifestDigest: artifact.manifestDigest,
    surfaceDigest: artifact.surfaceDigest,
    mode,
    operationId: deploymentRequest.requestId,
    processGeneration: deploymentRequest.targetGeneration,
    dshVersion: "0.1.1-rc.2",
    chopinVersion: "0.1.0",
    loadedSurfaceDigest: artifact.surfaceDigest,
    health: "pass",
    startedAt: "2026-08-31T00:00:00.000Z",
    endedAt: "2026-08-31T01:00:00.000Z",
  };
}

function artifact(
  capability: CapabilityManifest,
  state: ArtifactProjection["state"],
  unique = capability.version.replaceAll(".", ""),
): ArtifactProjection {
  const value: ArtifactProjection = {
    id: `${capability.id}:${capability.version}`,
    state,
    stateChangedAt: "2026-08-31T01:00:00.000Z",
    stateChangedEventIndex: Number.parseInt(unique, 10),
    eventCount: 1,
    firstEventId: `first-${capability.id}-${unique}`,
    lastEventId: `last-${capability.id}-${unique}`,
    updatedAt: "2026-08-31T01:00:00.000Z",
    manifest: capability,
    contentDigest: `sha256:${unique.padEnd(64, "a").slice(0, 64)}`,
    manifestDigest: hashes.manifest,
    surfaceDigest: `sha256:${unique.padEnd(64, "c").slice(0, 64)}`,
    exposures: { selected: 0, injected: 0, "tool-called": 0, "gate-evaluated": 0 },
    trust: state === "active" ? "provisional" : "approved",
    enabled: state === "active",
    verificationReceipts: [],
    approvalReceipts: [],
    deploymentReceipts: [],
    deploymentRequests: [],
    feedbackWindows: [],
  };
  const approval: ApprovalReceipt = {
    receiptId: `approval-${value.id}`,
    artifactId: value.id,
    contentDigest: value.contentDigest,
    manifestDigest: value.manifestDigest,
    surfaceDigest: value.surfaceDigest,
    permissionDigest: hashes.content,
    capabilityDigest: hashes.content,
    decision: "allowed-once",
    actor: "test-user",
    sessionId: "test-session",
    approvalAuditId: "test-approval",
    decidedAt: "2026-08-31T00:00:00.000Z",
  };
  value.approvalReceipts.push(approval);
  if (state === "active" || state === "retired") {
    const activeRequest = request(value, "active");
    value.deploymentRequests.push(activeRequest);
    value.deploymentReceipts.push(receipt(value, "active"));
  }
  return value;
}

function projection(artifacts: ArtifactProjection[]): EvolutionProjection {
  return { schemaVersion: 1, eventCount: artifacts.length, candidates: [], artifacts };
}

describe("controller deployment selection", () => {
  it("successfulCalls parses raw JSON object arguments and fails closed on bad JSON", () => {
    const session = {
      snapshotEvents: () => [
        { type: "tool/call", data: { callId: "call-one", name: "read", arguments: "{\"file_path\":\"packages/a.ts\"}" } },
        { type: "tool/result", data: { message: { role: "tool", toolCallId: "call-one", isError: false, content: [] } } },
        { type: "tool/call", data: { callId: "call-two", name: "read", arguments: "not-json" } },
        { type: "tool/result", data: { message: { role: "tool", toolCallId: "call-two", isError: false, content: [] } } },
        { type: "tool/call", data: { callId: "call-three", name: "read", arguments: "[\"packages/ignored.ts\"]" } },
        { type: "tool/result", data: { message: { role: "tool", toolCallId: "call-three", isError: false, content: [] } } },
      ],
    } as unknown as Session;
    expect(successfulCalls(session)).toEqual([
      { name: "read", arguments: { file_path: "packages/a.ts" } },
    ]);
  });

  it("guard does not borrow successes from old tasks or failed retries, keeps valid calls with different arguments and recognizes nested calls", () => {
    const call = (id: string, path: string) => ({ type: "tool/call", data: { callId: id, name: "check", arguments: JSON.stringify({ path }) } });
    const result = (id: string, isError = false) => ({ type: "tool/result", data: { message: { role: "tool", toolCallId: id, isError, content: [] } } });
    const events = [
      call("old-task", "old.json"), result("old-task"),
      { type: "user/message", data: { source: { kind: "user" } } },
      call("first", "a.json"), result("first"),
      call("independent", "b.json"), result("independent"),
      call("pending", "a.json"),
      { type: "tool/ptc-dispatch-start", data: { subCallId: "nested", name: "read", arguments: { path: "c.json" } } },
      { type: "tool/ptc-dispatch", data: { subCallId: "nested", isError: false } },
    ];
    const session = { snapshotEvents: () => events } as unknown as Session;
    const valid = [{ name: "check", arguments: { path: "b.json" } }, { name: "read", arguments: { path: "c.json" } }];
    expect(successfulCalls(session)).toEqual(valid);
    events.push(result("pending", true), result("first"));
    expect(successfulCalls(session)).toEqual(valid);
    events.push(call("fixed", "a.json"), result("fixed"));
    expect(successfulCalls(session)).toEqual([...valid, { name: "check", arguments: { path: "a.json" } }]);
  });

  it("returns only pending canaries and always skips disabled", () => {
    const current = artifact(manifest("learned-tool", "1.0.0"), "installed-disabled");
    const canary = request(current, "canary");
    const disabled = request(current, "disabled");
    expect(controllerDeployments(projection([current]), [
      { artifactId: current.id, request: disabled },
      { artifactId: current.id, request: canary },
    ])).toEqual([{ current, target: current, request: canary }]);
  });

  it("fails closed when the rollback target has no exact approval", () => {
    const target = artifact(manifest("versioned-tool", "1.0.0"), "active", "1");
    const current = artifact(manifest("versioned-tool", "2.0.0", { supersedes: reference(target) }), "quarantined", "2");
    target.approvalReceipts = [];
    const rollback = request(current, "rollback", reference(target));
    expect(() => controllerDeployments(projection([target, current]), [{ artifactId: current.id, request: rollback }]))
      .toThrow(/no exact approval/);
  });
});

describe("production version and contract selection", () => {
  it("mounts only approved versions the authoritative projection marks as effective", () => {
    const first = artifact(manifest("versioned-tool", "1.0.0"), "active", "1");
    const second = artifact(manifest("versioned-tool", "2.0.0", { supersedes: reference(first) }), "active", "2");
    first.enabled = false;
    expect(selectProductionArtifacts(projection([first, second])).map((item) => item.id)).toEqual([second.id]);
  });

  it("quarantine does not silently fall back, rollback restores the retired LKG, and an active v3 can then move forward", () => {
    const first = artifact(manifest("versioned-tool", "1.0.0"), "active", "1");
    const second = artifact(manifest("versioned-tool", "2.0.0", { supersedes: reference(first) }), "quarantined", "2");
    first.state = "retired";
    first.stateChangedAt = "2026-08-31T02:00:00.000Z";
    first.stateChangedEventIndex = 3;
    first.enabled = false;
    first.trust = "retired";
    expect(selectProductionArtifacts(projection([first, second]))).toEqual([]);

    const rollback = request(second, "rollback", reference(first));
    second.state = "rolled-back";
    second.stateChangedEventIndex = 4;
    first.enabled = true;
    second.deploymentRequests.push(rollback);
    second.deploymentReceipts.push({
      receiptId: "receipt-rollback-versioned-tool",
      artifactId: second.id,
      contentDigest: second.contentDigest,
      manifestDigest: second.manifestDigest,
      surfaceDigest: second.surfaceDigest,
      mode: "rollback",
      operationId: rollback.requestId,
      processGeneration: rollback.targetGeneration,
      dshVersion: "0.1.1-rc.2",
      chopinVersion: "0.1.0",
      loadedSurfaceDigest: first.surfaceDigest,
      health: "pass",
      startedAt: "2026-08-31T02:00:00.000Z",
      endedAt: "2026-08-31T03:00:00.000Z",
      rollbackTarget: reference(first),
    });
    expect(selectProductionArtifacts(projection([first, second])).map((item) => item.id)).toEqual([first.id]);

    const third = artifact(manifest("versioned-tool", "3.0.0", { supersedes: reference(second) }), "active", "3");
    first.enabled = false;
    third.stateChangedAt = "2026-08-31T04:00:00.000Z";
    third.stateChangedEventIndex = 5;
    const thirdActive = third.deploymentReceipts.find((item) => item.mode === "active");
    if (thirdActive === undefined) throw new Error("test fixture missing v3 active receipt");
    thirdActive.startedAt = "2026-08-31T04:00:00.000Z";
    thirdActive.endedAt = "2026-08-31T04:00:00.000Z";
    expect(selectProductionArtifacts(projection([first, second, third])).map((item) => item.id)).toEqual([third.id]);
  });

  it("requires, dependencies and conflicts fail closed before import", () => {
    const dependency = artifact(manifest("dependency", "1.0.0"), "active", "3");
    const target = artifact(manifest("target", "1.0.0", {
      dependencies: [{ id: "dependency", version: "1.0.0" }],
    }), "active", "4");
    expect(() => assertLoadContract(projection([dependency, target]), target, [dependency, target], {
      pluginApi: "1.0.0",
      dsh: "0.1.1-rc.2",
    })).not.toThrow();
    expect(() => assertLoadContract(projection([target]), target, [target], {
      pluginApi: "1.0.0",
      dsh: "0.1.1-rc.2",
    })).toThrow(/requires effective dependency@1.0.0/);

    const conflicting = artifact(manifest("conflicting", "1.0.0", { conflicts: ["target"] }), "active", "5");
    expect(() => assertLoadContract(projection([dependency, target, conflicting]), target, [dependency, target, conflicting], {
      pluginApi: "1.0.0",
      dsh: "0.1.1-rc.2",
    })).toThrow(/conflicts/);
    expect(satisfiesVersionRange("0.1.1-rc.2", "0.1.1-rc.2")).toBe(true);
    expect(satisfiesVersionRange("1.2.0", "^1.0.0")).toBe(true);
    expect(satisfiesVersionRange("2.0.0", "^1.0.0")).toBe(false);
  });
});
