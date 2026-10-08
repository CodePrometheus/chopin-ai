import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  EvolutionEventStore,
  candidateClassified,
  candidateCorroborated,
  candidateObserved,
  foldEvolutionEvents,
} from "@chopin/evolution";
import type {
  ArtifactProposal,
  CandidateEvidence,
  CandidateProjection,
  CapabilityManifest,
} from "@chopin/evolution";

import {
  AUTHORING_TOOL_NAMES,
  STAGE_PARAMETERS,
  apply,
  assertProposalMatchesManifest,
  authoringTools,
  formatHostSourceRevision,
  resolveOwnedSourceDirectory,
} from "../src/index.js";

const temporaryDirectories: string[] = [];
const trigger = { repos: ["chopin"], pathGlobs: ["packages/**/*.ts"] };

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chopin-authoring-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function evidence(id: string): CandidateEvidence {
  return {
    evidenceId: id,
    class: "session-signal",
    independenceKey: `session:${id}`,
    independentUnits: 1,
    observedAt: "2026-08-31T00:00:00.000Z",
    contentHash: `sha256:${(id === "evidence-one" ? "1" : "2").repeat(64)}`,
    summary: `Observed ${id}`,
    sourceSessionId: `session-${id}`,
  };
}

function candidateEvents(candidateId: string, proposal: ArtifactProposal) {
  return [
    candidateObserved({ candidateId, actor: { kind: "system", id: "test-observer" } }, {
      signalKey: `signal:${candidateId}`,
      lesson: `Lesson for ${candidateId}`,
      evidence: evidence("evidence-one"),
    }),
    candidateObserved({ candidateId, actor: { kind: "system", id: "test-observer" } }, {
      signalKey: `signal:${candidateId}`,
      lesson: `Lesson for ${candidateId}`,
      evidence: evidence("evidence-two"),
    }),
    candidateCorroborated({ candidateId, actor: { kind: "agent", id: "test-agent" } }, {
      rootCause: "The capability is not yet represented in runtime state.",
      trigger,
      boundaries: { includes: ["matching task"], excludes: ["unrelated task"] },
    }),
    candidateClassified({ candidateId, actor: { kind: "agent", id: "test-agent" } }, [proposal]),
  ];
}

function memoryProposal(candidateId: string): ArtifactProposal {
  return {
    proposalId: `proposal-${candidateId}`,
    kind: "memory",
    intendedEffect: "advisory",
    summary: "Inject one bounded lesson.",
    trigger,
    requiredPermissions: [],
  };
}

function memoryManifest(candidateId: string): CapabilityManifest {
  return {
    schemaVersion: 1,
    id: `memory-${candidateId}`,
    version: "1.0.0",
    kind: "memory",
    runtime: "data",
    intendedEffect: "advisory",
    summary: "Inject one bounded lesson.",
    entry: "memory.md",
    trigger,
    provides: { contexts: [`context-${candidateId}`], skills: [], guards: [], tools: [], services: [], workflows: [] },
    permissions: [],
    dependencies: [],
    conflicts: [],
    requires: { chopinPluginApi: "^1.0.0" },
    lineage: { candidateIds: [candidateId], proposalIds: [`proposal-${candidateId}`] },
  };
}

function toolProposal(candidateId: string): ArtifactProposal {
  return {
    proposalId: `proposal-${candidateId}`,
    kind: "tool",
    intendedEffect: "advisory",
    summary: "Register one learned tool.",
    trigger,
    requiredPermissions: ["tools:register"],
  };
}

function toolManifest(candidateId: string): CapabilityManifest {
  return {
    schemaVersion: 1,
    id: `tool-${candidateId}`,
    version: "1.0.0",
    kind: "tool",
    runtime: "dsh-plugin",
    intendedEffect: "advisory",
    summary: "Register one learned tool.",
    entry: "index.js",
    trigger,
    provides: { contexts: [], skills: [], guards: [], tools: [`tool-${candidateId}`], services: [], workflows: [] },
    permissions: ["tools:register"],
    dependencies: [],
    conflicts: [],
    requires: { chopinPluginApi: "^1.0.0", dsh: "0.1.1-rc.2" },
    lineage: { candidateIds: [candidateId], proposalIds: [`proposal-${candidateId}`] },
  };
}

function classifiedCandidate(candidateId: string, proposal: ArtifactProposal): CandidateProjection {
  return foldEvolutionEvents(candidateEvents(candidateId, proposal)).candidates[0] as CandidateProjection;
}

function fakeContext(eventStore: EvolutionEventStore, artifactStore: ArtifactStore, registered: unknown[] = []): Context {
  return {
    chopinEvolution: { events: eventStore, artifacts: artifactStore },
    tools: { register: (tool: unknown) => registered.push(tool) },
  } as unknown as Context;
}

function fakeExecution(cwd: string) {
  return {
    agent: {
      id: "session-authoring",
      session: { header: { cwd } },
    },
  } as never;
}

describe("DSH authoring surface", () => {
  it("registers only Candidate-to-Artifact tools, never mixing in approval/deploy/feedback", async () => {
    const directory = await temporaryDirectory();
    const registered: Array<{ name: string }> = [];
    apply(fakeContext(
      new EvolutionEventStore(join(directory, "events.jsonl")),
      new ArtifactStore(join(directory, "artifacts")),
      registered,
    ));
    expect(registered.map((tool) => tool.name)).toEqual(AUTHORING_TOOL_NAMES);
    expect(registered.every((tool) => !/(approve|deploy|feedback)/.test(tool.name))).toBe(true);
  });
});

describe("source ownership and host revision", () => {
  it("rejects .. and symlinks escaping the owning session cwd", async () => {
    const directory = await temporaryDirectory();
    const workspace = join(directory, "workspace");
    const outside = join(directory, "outside");
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    await symlink(outside, join(workspace, "escaped-link"));
    await expect(resolveOwnedSourceDirectory(workspace, "../outside")).rejects.toThrow(/escapes owning workspace/);
    await expect(resolveOwnedSourceDirectory(workspace, "escaped-link")).rejects.toThrow(/escapes owning workspace/);
  });

  it("stages a valid memory into the CAS; the revision can only be generated by the host", async () => {
    const directory = await temporaryDirectory();
    const workspace = join(directory, "workspace");
    const source = join(workspace, "capability");
    await mkdir(source, { recursive: true });
    const candidateId = "read-before-edit";
    const manifest = memoryManifest(candidateId);
    await writeFile(join(source, "capability.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(join(source, "memory.md"), "HOST_ONLY_ARTIFACT_BODY\n", "utf8");

    const eventStore = new EvolutionEventStore(join(directory, "events.jsonl"));
    const artifactStore = new ArtifactStore(join(directory, "artifacts"));
    await eventStore.appendMany(candidateEvents(candidateId, memoryProposal(candidateId)));
    const tool = authoringTools(fakeContext(eventStore, artifactStore)).find((item) => item.name === "evolution_artifact_stage");
    if (tool === undefined) throw new Error("stage tool is missing");
    const result = await tool.execute({
      candidateId,
      proposalId: `proposal-${candidateId}`,
      sourceDir: "capability",
      sourceRevision: "model:forged",
    }, fakeExecution(workspace)) as unknown as {
      artifactId: string;
      contentDigest: string;
      sourceRevision: string;
      created: boolean;
    };

    expect((STAGE_PARAMETERS as { properties: Record<string, unknown> }).properties).not.toHaveProperty("sourceRevision");
    expect(result.created).toBe(true);
    expect(result.sourceRevision).toBe(`host:no-git@${result.contentDigest}`);
    expect(result.sourceRevision).not.toContain("model:forged");
    const artifact = (await eventStore.fold()).artifacts[0];
    expect(artifact).toMatchObject({ id: result.artifactId, state: "built", sourceRevision: result.sourceRevision });
    expect(await readFile(join(artifactStore.root, "sha256", result.contentDigest.slice(7), "memory.md"), "utf8")).toBe("HOST_ONLY_ARTIFACT_BODY\n");
    expect(JSON.stringify(await eventStore.readAll())).not.toContain("HOST_ONLY_ARTIFACT_BODY");
  });

  it("the host revision binds the full git HEAD and the exact content digest", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(formatHostSourceRevision(digest, "B".repeat(40))).toBe(`git:${"b".repeat(40)}@${digest}`);
    expect(formatHostSourceRevision(digest)).toBe(`host:no-git@${digest}`);
  });
});

describe("proposal and resolution invariants", () => {
  it("rejects proposal kind and permission drift", () => {
    const candidateId = "learned-tool";
    const candidate = classifiedCandidate(candidateId, toolProposal(candidateId));
    expect(() => assertProposalMatchesManifest(candidate, `proposal-${candidateId}`, {
      ...toolManifest(candidateId),
      kind: "plugin",
    })).toThrow(/kind differs/);
    expect(() => assertProposalMatchesManifest(candidate, `proposal-${candidateId}`, {
      ...toolManifest(candidateId),
      permissions: ["network:read"],
    })).toThrow(/permissions differs/);
  });

  it("resolve cannot fake activated with a model-supplied deploymentEventId", async () => {
    const directory = await temporaryDirectory();
    const candidateId = "resolve-candidate";
    const proposal = memoryProposal(candidateId);
    const eventStore = new EvolutionEventStore(join(directory, "events.jsonl"));
    const artifactStore = new ArtifactStore(join(directory, "artifacts"));
    await eventStore.appendMany(candidateEvents(candidateId, proposal));
    const tool = authoringTools(fakeContext(eventStore, artifactStore)).find((item) => item.name === "evolution_candidate_resolve");
    if (tool === undefined) throw new Error("resolve tool is missing");

    await expect(tool.execute({
      candidateId,
      outcomes: [{
        proposalId: proposal.proposalId,
        status: "activated",
        artifactId: "invented:1.0.0",
        contentDigest: `sha256:${"f".repeat(64)}`,
        deploymentEventId: "invented-deployment",
      }],
    }, fakeExecution(directory))).rejects.toThrow(/no prior successful deployment/);
    expect((await eventStore.fold()).candidates[0]?.state).toBe("classified");
    expect(await eventStore.readAll()).toHaveLength(4);
  });
});
