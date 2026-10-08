import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";

import {
  ArtifactStore,
  EvolutionEventStore,
  artifactBuilt,
  artifactDrafted,
  artifactDeploymentRequested,
  artifactActivated,
  artifactApproved,
  artifactCanaryActivated,
  artifactInstalledDisabled,
  artifactExposureRecorded,
  artifactQuarantined,
  artifactVerified,
  foldEvolutionEvents,
} from "@chopin/evolution";
import type { ArtifactExposureData, CapabilityManifest, EvolutionEvent, FeedbackWindow } from "@chopin/evolution";
import { approvalReceipt, deploymentReceipt, deploymentRequest, verificationReceipt } from "../../evolution/tests/receipt-fixtures.js";

import { buildExperienceContext } from "../src/render.js";
import { ChopinEvolution, artifactReferenceOf } from "../src/index.js";
import { defaultTriggerFacts } from "../src/facts.js";
import { matchApplicabilityTrigger, normalizeTriggerFacts, selectContextArtifacts } from "../src/selection.js";
import { apply as applyEvolutionTools } from "../src/tools.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chopin-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function manifest(id: string, kind: "memory" | "skill" | "plugin" = "memory"): CapabilityManifest {
  const executable = kind === "plugin";
  return {
    schemaVersion: 1,
    id,
    version: "1.0.0",
    kind,
    runtime: executable ? "dsh-plugin" : "data",
    intendedEffect: executable ? "preventive" : "advisory",
    summary: `Capability ${id}`,
    entry: executable ? "index.js" : "content.md",
    trigger: { repos: ["chopin"], pathGlobs: ["packages/**/*.ts"] },
    provides: {
      contexts: kind === "memory" ? [id] : [],
      skills: kind === "skill" ? [id] : [],
      guards: [],
      tools: [],
      services: executable ? [id] : [],
      workflows: [],
    },
    permissions: executable ? ["tools:execute-wrapper"] : [],
    dependencies: [],
    conflicts: [],
    requires: { chopinPluginApi: "^1.0.0", ...(executable ? { dsh: "0.1.1-rc.2" } : {}) },
    lineage: { candidateIds: [`candidate-${id}`], proposalIds: [`proposal-${id}`] },
  };
}

async function stageArtifact(root: string, value: CapabilityManifest, content: string) {
  const source = join(root, `source-${value.id}-${value.version}`);
  await mkdir(source);
  await writeFile(join(source, "capability.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeFile(join(source, value.entry), content, "utf8");
  return new ArtifactStore(join(root, "artifacts")).stage(source);
}

function evolutionService(ctx: Context, root: string): ChopinEvolution {
  return new ChopinEvolution(ctx, {
    eventsFile: join(root, "events.jsonl"),
    artifactsDir: join(root, "artifacts"),
    receiptsDir: join(root, "receipts"),
    chopinVersion: "0.1.0",
    dshVersion: "0.1.1-rc.2",
    processGeneration: "runtime-test-generation",
    autonomous: false,
  });
}

function executableManifest(
  id: string,
  version: string,
  lineage: CapabilityManifest["lineage"],
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
    dependencies: [],
    conflicts: [],
    requires: { chopinPluginApi: "^1.0.0", dsh: "0.1.1-rc.2" },
    lineage,
  };
}

function lifecycle(staged: Awaited<ReturnType<typeof stageArtifact>>, state: "canary-active" | "active" = "active"): EvolutionEvent[] {
  const artifactId = `${staged.manifest.id}:${staged.manifest.version}`;
  const binding = { artifactId, ...staged };
  const events = [
    artifactDrafted({ artifactId }, {
      manifest: staged.manifest,
      contentDigest: staged.contentDigest,
      manifestDigest: staged.manifestDigest,
      surfaceDigest: staged.surfaceDigest,
    }),
    artifactBuilt({ artifactId }, {
      contentDigest: staged.contentDigest,
      manifestDigest: staged.manifestDigest,
      surfaceDigest: staged.surfaceDigest,
      sourceRevision: "git:0123456789abcdef",
    }),
    artifactVerified({ artifactId }, verificationReceipt(binding)),
    artifactApproved({ artifactId }, approvalReceipt(binding)),
    artifactDeploymentRequested({ artifactId }, deploymentRequest(binding, "disabled")),
    artifactInstalledDisabled({ artifactId }, deploymentReceipt(binding, "disabled")),
    artifactDeploymentRequested({ artifactId }, deploymentRequest(binding, "canary")),
    artifactCanaryActivated({ artifactId }, deploymentReceipt(binding, "canary")),
  ];
  if (state === "active") {
    events.push(artifactDeploymentRequested({ artifactId }, deploymentRequest(binding, "active")));
    events.push(artifactActivated({ artifactId }, deploymentReceipt(binding, "active")));
  }
  return events;
}

describe("trigger selection", () => {
  it("AND across fields, OR within a field, path glob supports **", () => {
    const trigger = { repos: ["chopin", "other"], pathGlobs: ["packages/**/*.ts"], tools: ["read"] };
    const matching = normalizeTriggerFacts({ repos: ["chopin"], paths: ["packages/gate/src/index.ts"], tools: ["read"] });
    expect(matchApplicabilityTrigger(trigger, matching)).toEqual({
      matches: true,
      matchedSelectors: ["repos", "pathGlobs", "tools"],
    });
    expect(matchApplicabilityTrigger(trigger, { ...matching, tools: [] }).matches).toBe(false);
  });

  it("selects only active/canary memory and skill, never plugin source as context", async () => {
    const directory = await temporaryDirectory();
    const memory = await stageArtifact(directory, manifest("memory-one"), "Read before edit.\n");
    const skill = await stageArtifact(directory, manifest("skill-one", "skill"), "Use the read tool first.\n");
    const plugin = await stageArtifact(directory, manifest("plugin-one", "plugin"), "export default () => {}\n");
    const projection = foldEvolutionEvents([...lifecycle(memory), ...lifecycle(skill, "canary-active"), ...lifecycle(plugin)]);
    const selected = selectContextArtifacts(projection, normalizeTriggerFacts({
      repos: ["chopin"], paths: ["packages/gate/src/index.ts"],
    }), 10);
    expect(selected.map((item) => item.artifact.manifest.kind)).toEqual(["memory", "skill"]);
  });

  it("extracts paths from the tool/call raw JSON string; bad JSON and a non-object root fail closed", () => {
    const agent = {
      session: {
        header: { cwd: "/tmp/chopin" },
        snapshotEvents: () => [
          { type: "tool/call", seq: 0, time: 1, data: { turn: 1, step: 1, callId: "call-one", name: "read", arguments: "{\"file_path\":\"packages/a.ts\"}" } },
          { type: "tool/call", seq: 1, time: 2, data: { turn: 1, step: 1, callId: "call-two", name: "read", arguments: "not-json" } },
          { type: "tool/call", seq: 2, time: 3, data: { turn: 1, step: 1, callId: "call-three", name: "read", arguments: "[\"packages/ignored.ts\"]" } },
        ],
      },
    } as unknown as Agent;
    const facts = defaultTriggerFacts(agent, "");
    expect(facts.paths).toEqual(["packages/a.ts"]);
    expect(facts.languages).toEqual(["typescript"]);
  });
});

describe("experience context", () => {
  it("bodies stay out of context, and the index lists only entries that passed the structured filter", async () => {
    const directory = await temporaryDirectory();
    const staged = await stageArtifact(directory, manifest("read-first"), "Read the exact file before editing it.\n");
    const eventStore = new EvolutionEventStore(join(directory, "events.jsonl"));
    await eventStore.appendMany(lifecycle(staged));

    const result = await buildExperienceContext({
      eventStore,
      facts: normalizeTriggerFacts({ repos: ["chopin"], paths: ["packages/gate/src/index.ts"] }),
      sessionId: "session-one",
      requestId: "session-one:1:1",
      occurredAt: "2026-08-31T00:00:00.000Z",
      options: { maxIndexItems: 200, maxIndexChars: 25_000, maxBodyChars: 1_500 },
    });
    expect(result.text).toContain("- read-first:1.0.0 — Capability read-first");
    expect(result.text).not.toContain("Read the exact file before editing it.");
    expect(result.listed).toEqual(["read-first:1.0.0"]);
    const projection = await eventStore.fold();
    expect(projection.artifacts[0]?.exposures).toMatchObject({ selected: 1, injected: 0 });
  });
});

describe("host-owned evolution control", () => {
  it("replaying the same exposure keeps one event, and the agent tool surface exposes no feedback", async () => {
    const directory = await temporaryDirectory();
    const staged = await stageArtifact(directory, executableManifest("learned-tool", "1.0.0", {
      candidateIds: ["candidate-learned-tool"],
      proposalIds: ["proposal-learned-tool"],
    }), "export default {}\n");
    const ctx = new Context();
    const service = evolutionService(ctx, directory);
    await service.events.appendMany(lifecycle(staged));
    const exposure: ArtifactExposureData = {
      phase: "tool-called",
      sessionId: "session-one",
      requestId: "call-one",
      contentDigest: staged.contentDigest,
      factsDigest: `sha256:${"a".repeat(64)}`,
      matchedSelectors: ["repos"],
      toolName: "learned-tool",
      callId: "call-one",
    };
    await service.recordExposure(`${staged.manifest.id}:${staged.manifest.version}`, exposure, "stable-exposure", "2026-08-31T01:00:00.000Z");
    await service.recordExposure(`${staged.manifest.id}:${staged.manifest.version}`, exposure, "stable-exposure", "2026-08-31T02:00:00.000Z");
    expect((await service.events.fold()).artifacts[0]?.exposures["tool-called"]).toBe(1);

    const registered: string[] = [];
    applyEvolutionTools({ tools: { register: (tool: { name: string }) => registered.push(tool.name) } } as unknown as Context);
    expect(registered).toEqual(["evolution_approve", "experience_read", "evolution_deployment_retry",
      "evolution_context_inspect", "evolution_context_strategy",
      "evolution_improver_read", "evolution_improver_plan", "evolution_improver_propose"]);
    await ctx.fiber.dispose();
  });

  it("active promotion requires a successful canary behavior receipt from the target generation", async () => {
    const directory = await temporaryDirectory();
    const staged = await stageArtifact(directory, executableManifest("canary-tool", "1.0.0", {
      candidateIds: ["candidate-canary-tool"],
      proposalIds: ["proposal-canary-tool"],
    }), "export default {}\n");
    const ctx = new Context();
    const service = evolutionService(ctx, directory);
    await service.events.appendMany(lifecycle(staged, "canary-active"));
    const artifactId = `${staged.manifest.id}:${staged.manifest.version}`;
    expect((await service.requestDeployment(artifactId, "active", "test-agent")).request.mode).toBe("active");
    await ctx.fiber.dispose();
  });

  it("the rollback target is derived from lineage and successful active history", async () => {
    const directory = await temporaryDirectory();
    const previous = await stageArtifact(directory, executableManifest("versioned-tool", "1.0.0", {
      candidateIds: ["candidate-v1"],
      proposalIds: ["proposal-v1"],
    }), "export default {}\n");
    const previousProjection = foldEvolutionEvents(lifecycle(previous));
    const previousArtifact = previousProjection.artifacts[0] as NonNullable<(typeof previousProjection.artifacts)[number]>;
    const current = await stageArtifact(directory, executableManifest("versioned-tool", "2.0.0", {
      candidateIds: ["candidate-v2"],
      proposalIds: ["proposal-v2"],
      supersedes: artifactReferenceOf(previousArtifact),
    }), "export default {}\n");
    const currentId = `${current.manifest.id}:${current.manifest.version}`;
    const ctx = new Context();
    const service = evolutionService(ctx, directory);
    await service.events.appendMany([
      ...lifecycle(previous),
      ...lifecycle(current),
      artifactQuarantined({ artifactId: currentId }, "canary regression"),
    ]);
    const result = await service.requestDeployment(currentId, "rollback", "test-agent");
    expect(result.request.rollbackTarget).toEqual(artifactReferenceOf(previousArtifact));
    await ctx.fiber.dispose();
  });

  it("host feedback validates effect, the current deployment and provenance", async () => {
    const directory = await temporaryDirectory();
    const staged = await stageArtifact(directory, executableManifest("feedback-tool", "1.0.0", {
      candidateIds: ["candidate-feedback"],
      proposalIds: ["proposal-feedback"],
    }), "export default {}\n");
    const ctx = new Context();
    const service = evolutionService(ctx, directory);
    await service.events.appendMany(lifecycle(staged));
    const artifact = (await service.events.fold()).artifacts[0] as NonNullable<(Awaited<ReturnType<typeof service.events.fold>>["artifacts"])[number]>;
    const deployment = artifact.deploymentReceipts.find((receipt) => receipt.mode === "active" && receipt.operationId === "operation-active");
    const base: FeedbackWindow = {
      windowId: "feedback-window",
      deploymentReceiptId: deployment?.receiptId ?? "",
      artifactId: artifact.id,
      contentDigest: artifact.contentDigest,
      intendedEffect: "preventive",
      startedAt: "2026-08-31T00:00:00.000Z",
      endedAt: "2026-08-31T01:00:00.000Z",
      eligible: 2,
      activated: 2,
      recurrence: 0,
      prevented: 2,
      falseTrigger: 0,
      falseBlock: 0,
      independentSuccesses: 2,
      taskPass: 2,
      taskFail: 0,
      retryDelta: 0,
      costDeltaUsd: 0,
      latencyDeltaMs: 0,
      evidenceRefs: ["session-one"],
    };
    await expect(service.recordFeedback({ ...base, intendedEffect: "advisory" }, {
      actorId: "host-observer",
      observedAt: "2026-08-31T02:00:00.000Z",
    })).rejects.toThrow(/effect/);
    expect(await service.recordFeedback(base, {
      actorId: "host-observer",
      observedAt: "2026-08-31T02:00:00.000Z",
    })).toBe("confirm");
    const feedbackEvent = (await service.events.readAll()).find((event) => event.type === "artifact.feedback-recorded");
    expect(feedbackEvent?.actor).toEqual({ kind: "system", id: "host-observer" });
    await ctx.fiber.dispose();
  });
});
