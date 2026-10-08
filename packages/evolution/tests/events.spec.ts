import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CandidateInvariantError,
  artifactBuilt,
  artifactDrafted,
  artifactDeploymentRequested,
  artifactActivated,
  artifactApproved,
  artifactCanaryActivated,
  artifactInstalledDisabled,
  artifactVerified,
  EvolutionEventConflictError,
  EvolutionEventStore,
  EvolutionLogCorruptError,
  EvolutionTransitionError,
  InvalidArtifactEventError,
  InvalidCandidateEventError,
  InvalidEvolutionEventError,
  candidateClassified,
  candidateCorroborated,
  candidateIdFor,
  candidateObserved,
  candidateResolved,
  createEvolutionEvent,
  foldEvolutionEvents,
  importLegacyPending,
} from "../src/index.js";
import type { ArtifactProposal, CandidateEvidence, CapabilityManifest, EvolutionActor } from "../src/index.js";
import { approvalReceipt, deploymentReceipt, deploymentRequest, verificationReceipt } from "./receipt-fixtures.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chopin-evolution-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function evidence(
  evidenceId: string,
  evidenceClass: CandidateEvidence["class"] = "session-signal",
  independenceKey = evidenceId,
  independentUnits = 1,
): CandidateEvidence {
  return {
    evidenceId,
    class: evidenceClass,
    independenceKey,
    independentUnits,
    observedAt: "2026-08-31T00:00:00.000Z",
    contentHash: `sha256:${"a".repeat(64)}`,
    summary: `Evidence ${evidenceId}`,
    sourceSessionId: `session-${evidenceId}`,
    ...(["host-verification", "gate-receipt", "tool-receipt"].includes(evidenceClass)
      ? { sourceRef: `receipt:${evidenceId}` }
      : {}),
  };
}

function evidenceActor(value: CandidateEvidence): EvolutionActor {
  if (value.class === "user-correction") return { kind: "user", id: "test-user" };
  if (value.class === "assistant-claim") return { kind: "agent", id: "test-agent" };
  return { kind: "system", id: "test-observer" };
}

function observed(evidenceValue = evidence("evidence-1"), eventId?: string) {
  return candidateObserved({
    candidateId: "read-before-edit",
    actor: evidenceActor(evidenceValue),
    ...(eventId === undefined ? {} : { eventId }),
    occurredAt: "2026-08-31T00:00:00.000Z",
  }, {
    signalKey: "tool-failure:edit-before-read",
    lesson: "Read a file before editing it.",
    evidence: evidenceValue,
  });
}

const trigger = { repos: ["chopin"], tools: ["str_replace_editor"] };
const boundaries = { includes: ["Editing an existing file"], excludes: ["Creating a new file"] };
const proposals: ArtifactProposal[] = [
  {
    proposalId: "memory-read-first",
    kind: "memory",
    intendedEffect: "advisory",
    summary: "Explain why the file must be read first.",
    trigger,
    requiredPermissions: [],
  },
  {
    proposalId: "gate-read-first",
    kind: "gate",
    intendedEffect: "preventive",
    summary: "Reject edit until the same file has been read.",
    trigger,
    requiredPermissions: ["tools:guard"],
  },
];

const capabilityManifest: CapabilityManifest = {
  schemaVersion: 1,
  id: "guard-read-first",
  version: "1.0.0",
  kind: "gate",
  runtime: "dsh-plugin",
  intendedEffect: "preventive",
  summary: "Require a successful read before editing an existing file.",
  entry: "index.js",
  trigger,
  provides: {
    contexts: [],
    skills: [],
    guards: ["read-first"],
    tools: [],
    services: [],
    workflows: [],
  },
  permissions: ["tools:guard"],
  dependencies: [],
  conflicts: [],
  requires: { chopinPluginApi: "^1.0.0", dsh: "0.1.1-rc.2" },
  lineage: { candidateIds: ["read-before-edit"], proposalIds: ["gate-read-first"] },
};

const contentDigest = `sha256:${"b".repeat(64)}`;

function drafted() {
  return artifactDrafted({ artifactId: "guard-read-first:1.0.0" }, { manifest: capabilityManifest, contentDigest });
}

function built() {
  return artifactBuilt({ artifactId: "guard-read-first:1.0.0" }, {
    contentDigest,
    manifestDigest: drafted().data.manifestDigest as string,
    surfaceDigest: drafted().data.surfaceDigest as string,
    sourceRevision: "git:0123456789abcdef",
  });
}

function binding() {
  const draft = drafted();
  return {
    artifactId: "guard-read-first:1.0.0",
    contentDigest,
    manifestDigest: draft.data.manifestDigest as string,
    surfaceDigest: draft.data.surfaceDigest as string,
    manifest: capabilityManifest,
  };
}

function corroborated() {
  return candidateCorroborated({ candidateId: "read-before-edit" }, {
    rootCause: "The edit tool has no read-before-write precondition.",
    trigger,
    boundaries,
  });
}

describe("event validation", () => {
  it("rejects an entity that does not match the event type", () => {
    expect(() => createEvolutionEvent({
      entityKind: "candidate",
      entityId: "bad-event",
      type: "artifact.drafted",
      data: {},
    })).toThrow(InvalidEvolutionEventError);
  });

  it("rejects non-JSON values and non-canonical timestamps", () => {
    expect(() => createEvolutionEvent({
      entityKind: "candidate",
      entityId: "bad-data",
      type: "candidate.observed",
      data: { value: Number.NaN },
    })).toThrow(/non-finite/);
    expect(() => createEvolutionEvent({
      occurredAt: "2026-08-31",
      entityKind: "candidate",
      entityId: "bad-time",
      type: "candidate.observed",
      data: {},
    })).toThrow(/canonical ISO/);
  });

  it("a reason lifecycle event must keep complete, strict audit fields", () => {
    const invalid = createEvolutionEvent({
      entityKind: "artifact",
      entityId: binding().artifactId,
      type: "artifact.rejected",
      data: { reason: "rejected without evidence refs" },
    });
    expect(() => foldEvolutionEvents([drafted(), invalid])).toThrow(InvalidArtifactEventError);
  });
});

describe("fold", () => {
  it("folds the legal lifecycle of candidates and artifacts", () => {
    const artifact = binding();
    const deployed = artifactCanaryActivated({
      artifactId: artifact.artifactId,
      eventId: "deployment-read-first-v1",
    }, deploymentReceipt(artifact, "canary"));
    const events = [
      observed(),
      observed(evidence("evidence-2")),
      corroborated(),
      candidateClassified({ candidateId: "read-before-edit" }, proposals),
      drafted(),
      built(),
      artifactVerified({ artifactId: artifact.artifactId }, verificationReceipt(artifact)),
      artifactApproved({ artifactId: artifact.artifactId }, approvalReceipt(artifact)),
      artifactDeploymentRequested({ artifactId: artifact.artifactId }, deploymentRequest(artifact, "disabled")),
      artifactInstalledDisabled({ artifactId: artifact.artifactId }, deploymentReceipt(artifact, "disabled")),
      artifactDeploymentRequested({ artifactId: artifact.artifactId }, deploymentRequest(artifact, "canary")),
      deployed,
      candidateResolved({ candidateId: "read-before-edit" }, [
        {
          proposalId: "memory-read-first",
          status: "rejected",
          reason: "The preventive gate fully covers this lesson.",
        },
        {
          proposalId: "gate-read-first",
          status: "activated",
          artifactId: "guard-read-first:1.0.0",
          contentDigest,
          deploymentEventId: deployed.eventId,
        },
      ]),
    ];
    const projection = foldEvolutionEvents(events);
    expect(projection.candidates[0]?.state).toBe("resolved");
    expect(projection.candidates[0]?.trustedIndependentUnits).toBe(2);
    expect(projection.candidates[0]?.proposals).toHaveLength(2);
    expect(projection.artifacts[0]?.state).toBe("canary-active");
    expect(projection.eventCount).toBe(13);
  });

  it("an illegal skip fails closed", () => {
    expect(() => foldEvolutionEvents([
      drafted(),
      artifactApproved({ artifactId: binding().artifactId }, approvalReceipt(binding())),
    ])).toThrow(EvolutionTransitionError);
  });

  it("approval and deployment receipts must bind the same artifact surface", () => {
    const artifact = binding();
    const projection = foldEvolutionEvents([
      drafted(),
      built(),
      artifactVerified({ artifactId: artifact.artifactId }, verificationReceipt(artifact)),
      artifactApproved({ artifactId: artifact.artifactId }, approvalReceipt(artifact)),
      artifactDeploymentRequested({ artifactId: artifact.artifactId }, deploymentRequest(artifact, "disabled")),
      artifactInstalledDisabled({ artifactId: artifact.artifactId }, deploymentReceipt(artifact, "disabled")),
      artifactDeploymentRequested({ artifactId: artifact.artifactId }, deploymentRequest(artifact, "canary")),
      artifactCanaryActivated({ artifactId: artifact.artifactId }, deploymentReceipt(artifact, "canary")),
      artifactDeploymentRequested({ artifactId: artifact.artifactId }, deploymentRequest(artifact, "active")),
      artifactActivated({ artifactId: artifact.artifactId }, deploymentReceipt(artifact, "active")),
    ]);
    expect(projection.artifacts[0]).toMatchObject({ state: "active", trust: "provisional", enabled: true });
  });

  it("verification source revision and the approval permission surface digest must match exactly", () => {
    const artifact = binding();
    expect(() => foldEvolutionEvents([
      drafted(),
      built(),
      artifactVerified({ artifactId: artifact.artifactId }, {
        ...verificationReceipt(artifact),
        sourceRevision: "git:different",
      }),
    ])).toThrow(InvalidArtifactEventError);

    expect(() => foldEvolutionEvents([
      drafted(),
      built(),
      artifactVerified({ artifactId: artifact.artifactId }, verificationReceipt(artifact)),
      artifactApproved({ artifactId: artifact.artifactId }, {
        ...approvalReceipt(artifact),
        permissionDigest: `sha256:${"0".repeat(64)}`,
      }),
    ])).toThrow(/permissionDigest differs/);
    expect(() => foldEvolutionEvents([
      drafted(),
      built(),
      artifactVerified({ artifactId: artifact.artifactId }, verificationReceipt(artifact)),
      artifactApproved({ artifactId: artifact.artifactId }, {
        ...approvalReceipt(artifact),
        capabilityDigest: `sha256:${"0".repeat(64)}`,
      }),
    ])).toThrow(/capabilityDigest differs/);
  });

  it("the same event id is idempotent with identical content and a conflict otherwise", () => {
    const event = observed(evidence("evidence-same"), "event-same");
    const same = { ...event, data: { lesson: event.data.lesson!, evidence: event.data.evidence!, signalKey: event.data.signalKey! } };
    const changed = { ...event, data: { ...event.data, lesson: "Different lesson" } };
    expect(foldEvolutionEvents([event, same]).eventCount).toBe(1);
    expect(() => foldEvolutionEvents([event, changed])).toThrow(EvolutionEventConflictError);
  });
});

describe("candidate evidence and classification", () => {
  it("assistant self-report does not count toward corroboration", () => {
    const events = [
      observed(evidence("assistant-1", "assistant-claim")),
      observed(evidence("assistant-2", "assistant-claim")),
      corroborated(),
    ];
    expect(() => foldEvolutionEvents(events)).toThrow(CandidateInvariantError);
  });

  it("a new observation after resolved is a recurrence and is accepted; reclassifying returns to classified", () => {
    const deployed = artifactCanaryActivated({ artifactId: "guard-read-first:1.0.0" }, deploymentReceipt(binding(), "canary"));
    const resolved = foldEvolutionEvents([
      observed(),
      observed(evidence("evidence-2")),
      corroborated(),
      candidateClassified({ candidateId: "read-before-edit" }, proposals),
      drafted(),
      built(),
      artifactVerified({ artifactId: "guard-read-first:1.0.0" }, verificationReceipt(binding())),
      artifactApproved({ artifactId: "guard-read-first:1.0.0" }, approvalReceipt(binding())),
      artifactDeploymentRequested({ artifactId: "guard-read-first:1.0.0" }, deploymentRequest(binding(), "disabled")),
      artifactInstalledDisabled({ artifactId: "guard-read-first:1.0.0" }, deploymentReceipt(binding(), "disabled")),
      artifactDeploymentRequested({ artifactId: "guard-read-first:1.0.0" }, deploymentRequest(binding(), "canary")),
      deployed,
      candidateResolved({ candidateId: "read-before-edit" }, [
        { proposalId: "memory-read-first", status: "rejected", reason: "covered by gate" },
        { proposalId: "gate-read-first", status: "activated", artifactId: "guard-read-first:1.0.0", contentDigest, deploymentEventId: deployed.eventId },
      ]),
      observed(evidence("evidence-3")),
      candidateClassified({ candidateId: "read-before-edit" }, [proposals[0] as ArtifactProposal]),
    ]);
    expect(resolved.candidates[0]?.state).toBe("classified");
    expect(resolved.candidates[0]?.evidence).toHaveLength(3);
  });

  it("one user-confirmed correction is enough to corroborate; a single machine signal is not", () => {
    const corrected = foldEvolutionEvents([observed(evidence("correction-1", "user-correction")), corroborated()]);
    expect(corrected.candidates[0]?.state).toBe("corroborated");
    expect(() => foldEvolutionEvents([observed(), corroborated()])).toThrow(/one user correction/);
  });

  it("trigger accepts a single-line when and rejects multi-line, over-long and empty-arrays-only", () => {
    const meta = { candidateId: "read-before-edit" };
    const body = (trigger: unknown) => ({ rootCause: "cause", trigger: trigger as never, boundaries });
    expect(candidateCorroborated(meta, body({ when: "editing an existing file" })).data.trigger).toEqual({ when: "editing an existing file" });
    expect(() => candidateCorroborated(meta, body({ when: "two\nlines" }))).toThrow(InvalidCandidateEventError);
    expect(() => candidateCorroborated(meta, body({ when: "x".repeat(241) }))).toThrow(InvalidCandidateEventError);
    expect(() => candidateCorroborated(meta, body({ repos: [] }))).toThrow(/at least one selector/);
    expect(candidateIdFor("sk1:tool-failure:bash:-:spawn EBADF")).toMatch(/^candidate-[a-f0-9]{64}$/);
  });

  it("the same independence key does not inflate the evidence count", () => {
    const projection = foldEvolutionEvents([
      observed(evidence("receipt-1", "tool-receipt", "session-one")),
      observed(evidence("receipt-2", "gate-receipt", "session-one")),
    ]);
    expect(projection.candidates[0]?.trustedIndependentUnits).toBe(1);
  });

  it("classification allows one experience to yield several artifacts with different permissions", () => {
    const projection = foldEvolutionEvents([
      observed(),
      observed(evidence("evidence-2", "user-correction")),
      corroborated(),
      candidateClassified({ candidateId: "read-before-edit" }, proposals),
    ]);
    expect(projection.candidates[0]?.proposals.map((proposal) => proposal.kind)).toEqual(["gate", "memory"]);
    expect(projection.candidates[0]?.rootCause).toContain("precondition");
    expect(projection.candidates[0]?.boundaries?.excludes).toEqual(["Creating a new file"]);
  });

  it("resolved must cover every proposal", () => {
    const prefix = [
      observed(),
      observed(evidence("evidence-2")),
      corroborated(),
      candidateClassified({ candidateId: "read-before-edit" }, proposals),
    ];
    expect(() => foldEvolutionEvents([
      ...prefix,
      candidateResolved({ candidateId: "read-before-edit" }, [{
        proposalId: "gate-read-first",
        status: "rejected",
        reason: "not wanted",
      }]),
    ])).toThrow(/cover every classified proposal/);
  });

  it("an activated outcome must reference an earlier successful deployment with matching identity", () => {
    const prefix = [
      observed(),
      observed(evidence("evidence-2")),
      corroborated(),
      candidateClassified({ candidateId: "read-before-edit" }, proposals),
    ];
    expect(() => foldEvolutionEvents([
      ...prefix,
      candidateResolved({ candidateId: "read-before-edit" }, [
        { proposalId: "memory-read-first", status: "rejected", reason: "covered by gate" },
        {
          proposalId: "gate-read-first",
          status: "activated",
          artifactId: "guard-read-first:1.0.0",
          contentDigest,
          deploymentEventId: "missing-deployment",
        },
      ]),
    ])).toThrow(/no prior successful deployment/);

    const artifact = binding();
    const deployment = artifactCanaryActivated({
      artifactId: artifact.artifactId,
      eventId: "real-deployment",
    }, deploymentReceipt(artifact, "canary"));
    expect(() => foldEvolutionEvents([
      ...prefix,
      drafted(),
      built(),
      artifactVerified({ artifactId: artifact.artifactId }, verificationReceipt(artifact)),
      artifactApproved({ artifactId: artifact.artifactId }, approvalReceipt(artifact)),
      artifactDeploymentRequested({ artifactId: artifact.artifactId }, deploymentRequest(artifact, "disabled")),
      artifactInstalledDisabled({ artifactId: artifact.artifactId }, deploymentReceipt(artifact, "disabled")),
      artifactDeploymentRequested({ artifactId: artifact.artifactId }, deploymentRequest(artifact, "canary")),
      deployment,
      candidateResolved({ candidateId: "read-before-edit" }, [
        { proposalId: "memory-read-first", status: "rejected", reason: "covered by gate" },
        {
          proposalId: "gate-read-first",
          status: "activated",
          artifactId: artifact.artifactId,
          contentDigest: `sha256:${"f".repeat(64)}`,
          deploymentEventId: deployment.eventId,
        },
      ]),
    ])).toThrow(/does not match deployment/);
  });

  it("non-legacy evidence cannot self-report aggregate units; receipt and actor provenance must be complete", () => {
    expect(() => observed(evidence("inflated", "session-signal", "session-inflated", 2))).toThrow(/exactly one independent unit/);
    expect(() => candidateObserved({
      candidateId: "bad-receipt",
      actor: { kind: "system", id: "test-observer" },
    }, {
      signalKey: "bad-receipt",
      lesson: "Receipt provenance is absent.",
      evidence: { ...evidence("bad-receipt", "tool-receipt"), sourceRef: undefined },
    })).toThrow(/requires sourceRef/);
    expect(() => candidateObserved({
      candidateId: "bad-actor",
      actor: { kind: "system", id: "test-observer" },
    }, {
      signalKey: "bad-actor",
      lesson: "User correction has the wrong actor.",
      evidence: evidence("bad-actor", "user-correction"),
    })).toThrow(/requires user actor/);
  });
});

describe("JSONL store", () => {
  it("concurrent appends from several store instances still leave one complete event per line", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "events.jsonl");
    const stores = [new EvolutionEventStore(path), new EvolutionEventStore(path)];
    const events = Array.from({ length: 40 }, (_, index) => candidateObserved({
      candidateId: `candidate-${index}`,
      actor: { kind: "system", id: "test-observer" },
    }, {
      signalKey: `signal:${index}`,
      lesson: `Lesson ${index}`,
      evidence: evidence(`evidence-${index}`),
    }));
    await Promise.all(events.map((event, index) => stores[index % stores.length]?.append(event)));

    const read = await stores[0]?.readAll();
    expect(read).toHaveLength(40);
    expect(new Set(read?.map((event) => event.eventId)).size).toBe(40);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(40);
  });

  it.each(["same", "cross"] as const)("%s store concurrent state races commit only one legal transition", async (kind) => {
    const directory = await temporaryDirectory();
    const path = join(directory, "events.jsonl");
    const first = new EvolutionEventStore(path);
    const second = kind === "same" ? first : new EvolutionEventStore(path);
    const artifact = binding();
    await first.appendMany([drafted(), built()]);
    const left = artifactVerified({ artifactId: artifact.artifactId, eventId: "verify-left" }, {
      ...verificationReceipt(artifact),
      receiptId: "receipt-left",
    });
    const right = artifactVerified({ artifactId: artifact.artifactId, eventId: "verify-right" }, {
      ...verificationReceipt(artifact),
      receiptId: "receipt-right",
    });

    const settled = await Promise.allSettled([first.append(left), second.append(right)]);
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect((await first.fold()).artifacts[0]?.state).toBe("verified");
    expect((await first.readAll())).toHaveLength(3);
  });

  it("an exact duplicate across stores lands one line only", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "events.jsonl");
    const first = new EvolutionEventStore(path);
    const second = new EvolutionEventStore(path);
    const event = observed(evidence("deduplicated"), "same-event");
    await Promise.all([first.append(event), second.append(event)]);
    expect(await first.readAll()).toEqual([event]);
  });

  it("concurrent reads see only a stable snapshot from before or after appendMany", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "events.jsonl");
    const writer = new EvolutionEventStore(path);
    const reader = new EvolutionEventStore(path);
    const events = Array.from({ length: 20 }, (_, index) => candidateObserved({
      candidateId: `stable-${index}`,
      actor: { kind: "system", id: "test-observer" },
    }, {
      signalKey: `stable:${index}`,
      lesson: `Stable lesson ${index}`,
      evidence: evidence(`stable-${index}`),
    }));

    const write = writer.appendMany(events);
    const reads = await Promise.all(Array.from({ length: 8 }, () => reader.readAll()));
    await write;
    expect(reads.every((items) => items.length === 0 || items.length === events.length)).toBe(true);
    expect(await reader.readAll()).toHaveLength(events.length);
  });

  it("illegal domain events and over-long lines fail before hitting disk", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "events.jsonl");
    const store = new EvolutionEventStore(path, { maxLineBytes: 300 });
    const invalid = createEvolutionEvent({
      entityKind: "candidate",
      entityId: "invalid-candidate",
      type: "candidate.observed",
      data: {},
      actor: { kind: "system", id: "test-observer" },
    });
    await expect(store.append(invalid)).rejects.toBeInstanceOf(InvalidCandidateEventError);
    expect(await store.readAll()).toEqual([]);

    const oversized = candidateObserved({
      candidateId: "oversized-candidate",
      actor: { kind: "system", id: "test-observer" },
    }, {
      signalKey: "oversized",
      lesson: "x".repeat(1_000),
      evidence: evidence("oversized"),
    });
    await expect(store.append(oversized)).rejects.toThrow(/line exceeds 300 bytes/);
    expect(await store.readAll()).toEqual([]);
  });

  it("a corrupt trailing line reports the exact line number instead of being silently dropped", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "events.jsonl");
    const store = new EvolutionEventStore(path);
    await store.append(observed());
    await writeFile(path, `${await readFile(path, "utf8")}{\"partial\":`, "utf8");

    const error = await store.readAll().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(EvolutionLogCorruptError);
    expect(error).toMatchObject({ lineNumber: 2 });
  });

  it("rebuilds the JSON and Markdown projections from JSONL", async () => {
    const directory = await temporaryDirectory();
    const store = new EvolutionEventStore(join(directory, "events.jsonl"));
    await store.append(observed());
    const projection = await store.rebuildProjections(join(directory, "state.json"), join(directory, "state.md"));

    expect(projection.candidates[0]?.state).toBe("observed");
    expect(JSON.parse(await readFile(join(directory, "state.json"), "utf8"))).toEqual(projection);
    const markdown = await readFile(join(directory, "state.md"), "utf8");
    expect(markdown).toContain("| read-before-edit | observed |");
    expect(markdown).toContain("## Capability kinds");
    expect(markdown).toContain("| memory | 0 | 0 |");
  });
});

describe("legacy import", () => {
  it("explicit import is idempotent, and a promoted entry without a digest does not pose as resolved", async () => {
    const directory = await temporaryDirectory();
    const legacy = join(directory, "pending");
    await mkdir(join(legacy, "promoted"), { recursive: true });
    await writeFile(join(legacy, "promoted", "read-first.yaml"), [
      "id: read-first",
      "lesson: Read before edit.",
      "sessions: 4",
      "occurrences: 9",
      "proposal: gate",
      "firstSeenAt: 2026-08-20T00:00:00.000Z",
      "lastSeenAt: 2026-08-30T00:00:00.000Z",
      "",
    ].join("\n"), "utf8");

    const store = new EvolutionEventStore(join(directory, "events.jsonl"));
    const first = await importLegacyPending(store, legacy);
    const second = await importLegacyPending(store, legacy);
    expect(first.appended).toBe(1);
    expect(first.warnings[0]).toContain("imported as observed");
    expect(second.appended).toBe(0);
    const imported = (await store.fold()).candidates[0];
    expect(imported?.state).toBe("observed");
    expect(imported?.trustedIndependentUnits).toBe(4);
  });
});

describe("contrast evidence", () => {
  it("is accepted with its source and never counts as an independent unit", () => {
    const contrast = { ...evidence("contrast-1", "contrast"), sourceRef: "session:session-contrast-1:event:7" };
    expect(() => observed({ ...evidence("contrast-1", "contrast"), sourceRef: undefined })).toThrow(/contrast/);
    const projection = foldEvolutionEvents([observed(evidence("failure-1")), observed(contrast, "observed-contrast-1")]);
    expect(projection.candidates[0]?.evidence.map((item) => item.class)).toEqual(["session-signal", "contrast"]);
    expect(projection.candidates[0]?.trustedIndependentUnits).toBe(1);
  });
});
