import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  artifactDeploymentRequested,
  artifactExposureRecorded,
  artifactQuarantined,
  artifactRetired,
  artifactRolledBack,
  capabilityManifestDigest,
  capabilitySurfaceDigest,
  foldEvolutionEvents,
} from "@chopin/evolution";
import type { ArtifactProjection, EvolutionEvent } from "@chopin/evolution";

import { artifactReferenceOf, selectProductionArtifacts } from "../src/index.js";
import { selectEffectiveDataArtifacts } from "../src/selection.js";
import { dataManifest, gateManifest, lifecycle } from "./support.js";

function version(kind: "memory" | "gate", number: number) {
  const manifest = {
    ...(kind === "memory" ? dataManifest("versioned") : gateManifest("versioned")),
    version: `${number}.0.0`,
  };
  return {
    manifest,
    path: "source",
    files: ["capability.json", manifest.entry],
    contentDigest: `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`,
    manifestDigest: capabilityManifestDigest(manifest),
    surfaceDigest: capabilitySurfaceDigest(manifest),
  };
}

function restore(events: EvolutionEvent[], current: ArtifactProjection, target: ArtifactProjection): void {
  const rollbackTarget = artifactReferenceOf(target);
  const timestamp = "2026-09-05T00:00:00.000Z";
  const request = {
    requestId: `rollback-${current.id}`,
    artifactId: current.id,
    contentDigest: current.contentDigest,
    manifestDigest: current.manifestDigest,
    surfaceDigest: current.surfaceDigest,
    mode: "rollback" as const,
    targetGeneration: "restore-generation",
    approvalReceiptId: current.approvalReceipts[0]!.receiptId,
    requestedAt: timestamp,
    requestedBy: "test-controller",
    rollbackTarget,
  };
  events.push(
    artifactDeploymentRequested({ artifactId: current.id }, request),
    artifactRolledBack({ artifactId: current.id }, {
      receiptId: `receipt-${request.requestId}`,
      artifactId: current.id,
      contentDigest: current.contentDigest,
      manifestDigest: current.manifestDigest,
      surfaceDigest: current.surfaceDigest,
      mode: "rollback",
      operationId: request.requestId,
      processGeneration: request.targetGeneration,
      dshVersion: "0.1.1-rc.2",
      chopinVersion: "0.1.0",
      loadedSurfaceDigest: target.surfaceDigest,
      health: "pass",
      startedAt: timestamp,
      endedAt: timestamp,
      rollbackTarget,
    }),
  );
}

describe("effective lifecycle", () => {
  it.each(["memory", "gate"] as const)("%s replacement, rollback and explicit disable keep event order", (kind) => {
    const events = [...lifecycle(version(kind, 1)), ...lifecycle(version(kind, 2))];
    const select = () => {
      const projection = foldEvolutionEvents(events);
      return (kind === "memory" ? selectEffectiveDataArtifacts(projection) : selectProductionArtifacts(projection))
        .map((artifact) => artifact.id);
    };
    expect(select()).toEqual(["versioned:2.0.0"]);
    events.push(artifactRetired({ artifactId: "versioned:1.0.0" }, "replaced"));
    expect(select()).toEqual(["versioned:2.0.0"]);
    events.push(artifactQuarantined({ artifactId: "versioned:2.0.0" }, "failed behavior"));
    expect(select()).toEqual([]);
    const [first, second] = foldEvolutionEvents(events).artifacts;
    restore(events, second!, first!);
    expect(select()).toEqual(["versioned:1.0.0"]);

    events.push(...lifecycle(version(kind, 3)));
    expect(select()).toEqual(["versioned:3.0.0"]);
    events.push(artifactRetired({ artifactId: "versioned:3.0.0" }, "explicit stop"));
    expect(select()).toEqual([]);
    events.push(artifactExposureRecorded({ artifactId: first!.id }, {
      phase: "injected",
      sessionId: "historical-session",
      requestId: "late-observation",
      contentDigest: first!.contentDigest,
      factsDigest: first!.contentDigest,
      matchedSelectors: ["repos"],
    }));
    expect(select()).toEqual([]);
  });

  it("a retired version restored by rollback can still be explicitly disabled", () => {
    const events = [...lifecycle(version("memory", 1)), ...lifecycle(version("memory", 2))];
    events.push(
      artifactRetired({ artifactId: "versioned:1.0.0" }, "replaced"),
      artifactQuarantined({ artifactId: "versioned:2.0.0" }, "failed behavior"),
    );
    const [first, second] = foldEvolutionEvents(events).artifacts;
    restore(events, second!, first!);
    events.push(artifactRetired({ artifactId: first!.id }, "explicit stop after restore"));
    expect(selectEffectiveDataArtifacts(foldEvolutionEvents(events))).toEqual([]);
  });
});
