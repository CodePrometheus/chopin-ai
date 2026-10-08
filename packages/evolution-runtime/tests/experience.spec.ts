/**
 * How experiences become visible at the start of work: the index is always present, bodies are on demand, only a read counts as used; user corrections are booked through approval.
 */

import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { EvolutionEventStore, candidateIdFor } from "@chopin/evolution";
import { correctionSignalKey } from "@chopin/ledger";

import { EXPERIENCE_INDEX_HEADER, EXPERIENCE_INDEX_INSTRUCTION, buildExperienceContext, experienceIndexLine } from "../src/render.js";
import { normalizeTriggerFacts } from "../src/selection.js";
import { apply as applyEvolutionTools } from "../src/tools.js";
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

const facts = normalizeTriggerFacts({ repos: ["chopin"], paths: ["packages/gate/src/index.ts"] });

describe("experience index", () => {
  it("the index holds only id, when and summary, bodies stay out of context; selected is recorded once per entry per session", async () => {
    const directory = await temporaryDirectory();
    const eventStore = new EvolutionEventStore(join(directory, "events.jsonl"));
    const branch = await stageArtifact(directory, dataManifest("deploy-branch", {
      trigger: { when: "deploying to staging or creating a deploy branch" },
      summary: "Reuse the standing deploy branch.",
    }), "Push to the existing staging branch; never create dated branches.\n");
    const readFirst = await stageArtifact(directory, dataManifest("read-first", { kind: "skill" }), "Read the exact file before editing it.\n");
    await eventStore.appendMany([...lifecycle(branch), ...lifecycle(readFirst)]);

    const input = {
      eventStore,
      facts,
      sessionId: "session-one",
      requestId: "session-one:1:1",
      occurredAt: "2026-08-31T01:00:00.000Z",
      options: { maxIndexItems: 200, maxIndexChars: 25_000, maxBodyChars: 1_500 },
    };
    const result = await buildExperienceContext(input);
    await buildExperienceContext({ ...input, requestId: "session-one:1:2" });
    expect(result.text.startsWith(EXPERIENCE_INDEX_HEADER)).toBe(true);
    expect(result.text).toContain("- deploy-branch:1.0.0 — when: deploying to staging or creating a deploy branch — Reuse the standing deploy branch.");
    expect(result.text).toContain("- read-first:1.0.0 — Capability read-first");
    expect(result.text).not.toContain("never create dated branches");
    expect(result.listed).toEqual(["deploy-branch:1.0.0", "read-first:1.0.0"]);

    const projection = await eventStore.fold();
    expect(projection.artifacts.map((artifact) => artifact.exposures.selected)).toEqual([1, 1]);
    expect(projection.artifacts.every((artifact) => artifact.exposures.injected === 0)).toBe(true);

    await buildExperienceContext({ ...input, sessionId: "session-two", requestId: "session-two:1:1" });
    expect((await eventStore.fold()).artifacts.map((artifact) => artifact.exposures.selected)).toEqual([2, 2]);
  });

  it("a when-only trigger enters the index; a structured-field mismatch does not", async () => {
    const directory = await temporaryDirectory();
    const eventStore = new EvolutionEventStore(join(directory, "events.jsonl"));
    const whenOnly = await stageArtifact(directory, dataManifest("when-only", { trigger: { when: "renaming a package" } }), "body\n");
    const otherRepo = await stageArtifact(directory, dataManifest("other-repo", { trigger: { repos: ["elsewhere"], when: "anything" } }), "body\n");
    await eventStore.appendMany([...lifecycle(whenOnly), ...lifecycle(otherRepo)]);
    const result = await buildExperienceContext({
      eventStore,
      facts,
      sessionId: "session-one",
      requestId: "session-one:1:1",
      occurredAt: "2026-08-31T01:00:00.000Z",
      options: { maxIndexItems: 200, maxIndexChars: 25_000, maxBodyChars: 1_500 },
    });
    expect(result.listed).toEqual(["when-only:1.0.0"]);
  });

  it("entries cut by the index budget are not recorded as selected", async () => {
    const directory = await temporaryDirectory();
    const eventStore = new EvolutionEventStore(join(directory, "events.jsonl"));
    const first = await stageArtifact(directory, dataManifest("a-first"), "A\n");
    const second = await stageArtifact(directory, dataManifest("b-second"), "B\n");
    await eventStore.appendMany([...lifecycle(first), ...lifecycle(second)]);
    const projectionBefore = await eventStore.fold();
    const firstLine = experienceIndexLine(projectionBefore.artifacts.find((artifact) => artifact.id === "a-first:1.0.0")!);
    const budget = EXPERIENCE_INDEX_HEADER.length + 1 + EXPERIENCE_INDEX_INSTRUCTION.length + 1 + firstLine.length;
    const result = await buildExperienceContext({
      eventStore,
      facts,
      sessionId: "session-one",
      requestId: "session-one:1:1",
      occurredAt: "2026-08-31T01:00:00.000Z",
      options: { maxIndexItems: 200, maxIndexChars: budget, maxBodyChars: 1_500 },
    });
    expect(result.listed).toEqual(["a-first:1.0.0"]);
    const projection = await eventStore.fold();
    expect(projection.artifacts.find((artifact) => artifact.id === "b-second:1.0.0")?.exposures.selected).toBe(0);
  });

  it("an index line is clipped to a single line", () => {
    const line = experienceIndexLine({
      id: "long:1.0.0",
      manifest: dataManifest("long", { trigger: { when: "x".repeat(240) }, summary: "y".repeat(500) }),
    } as never);
    expect(line.length).toBeLessThanOrEqual(400);
    expect(line).not.toContain("\n");
  });
});

describe("experience_read", () => {
  it("returns the body and records one injected; replaying the same callId does not duplicate", async () => {
    const directory = await temporaryDirectory();
    const ctx = new Context();
    const service = evolutionService(ctx, directory);
    const staged = await stageArtifact(directory, dataManifest("read-first", { trigger: { when: "editing an existing file" } }), "Read the exact file before editing it.\n");
    const gate = await stageArtifact(directory, gateManifest("guard-one"), "export default {}\n");
    await service.events.appendMany([...lifecycle(staged), ...lifecycle(gate)]);
    const agent = fakeAgent("session-one", [userMessage("edit packages/gate/src/index.ts", Date.parse("2026-08-31T01:00:00.000Z"))]);

    const first = await service.readExperience(agent, "call-one" as never, "read-first:1.0.0");
    expect(first).toMatchObject({ artifactId: "read-first:1.0.0", kind: "memory", when: "editing an existing file" });
    expect(first.body).toBe("Read the exact file before editing it.");
    await service.readExperience(agent, "call-one" as never, "read-first:1.0.0");
    await service.readExperience(agent, "call-two" as never, "read-first:1.0.0");
    const artifact = (await service.events.fold()).artifacts.find((item) => item.id === "read-first:1.0.0");
    expect(artifact?.exposures.injected).toBe(2);
    const exposure = (await service.events.readAll()).find((event) => event.type === "artifact.exposure-recorded" && event.data.phase === "injected");
    expect(exposure?.data).toMatchObject({ toolName: "experience_read", callId: "call-one", matchedSelectors: ["when"] });

    await expect(service.readExperience(agent, "call-three" as never, "guard-one:1.0.0")).rejects.toThrow(/not readable/);
    await expect(service.readExperience(agent, "call-four" as never, "missing:1.0.0")).rejects.toThrow(/unknown artifact/);

    const registered: string[] = [];
    applyEvolutionTools({ tools: { register: (tool: { name: string }) => registered.push(tool.name) } } as unknown as Context);
    expect(registered).toContain("experience_read");
    await ctx.fiber.dispose();
  });
});

describe("user correction", () => {
  function approvalStub(outcome: "allowed-once" | "rejected", events: SessionEvent[], reasons: string[] = []) {
    return {
      request: async (input: { agent: Agent; callId: string; reason?: string }) => {
        reasons.push(input.reason ?? "");
        const time = Date.now();
        events.push(
          { type: "approval/asked", seq: events.length, time, data: { id: `audit-${input.callId}`, callId: input.callId } } as unknown as SessionEvent,
          { type: "approval/decided", seq: events.length + 1, time, data: { id: `audit-${input.callId}`, outcome } } as unknown as SessionEvent,
        );
        return outcome;
      },
    };
  }

  it("one approval: candidate, memory artifact, verification and go-live are all done by the host and the next step's index has it; a denial lands no bytes", async () => {
    const directory = await temporaryDirectory();
    const ctx = new Context();
    const reasons: string[] = [];
    const sessionEvents = [userMessage("Stop creating dated branches, push straight to the staging branch TOKEN=abc123secret", Date.parse("2026-08-31T01:00:00.000Z"))];
    ctx.provide("approval", approvalStub("allowed-once", sessionEvents, reasons));
    const service = evolutionService(ctx, directory);
    const agent = fakeAgent("session-one", sessionEvents);

    const result = await service.recordUserCorrection(agent, "call-one" as never, {
      slug: "reuse-one-deploy-branch",
      lesson: "Push to the standing staging branch instead of creating dated branches.",
      when: "deploying to staging or creating a deploy branch",
    });
    expect(result.outcome).toBe("allowed-once");
    expect(result.candidateId).toBe(candidateIdFor(correctionSignalKey("reuse-one-deploy-branch")));
    expect(result.artifactId).toMatch(/^lesson-reuse-one-deploy-branch:1\.0\.0-c[a-f0-9]{40}$/);
    expect(result).toMatchObject({ artifactState: "active", enabled: true });
    const events = await service.events.readAll();
    const observed = events.find((event) => event.type === "candidate.observed");
    const [correction] = sessionEvents;
    if (correction?.type !== "user/message") throw new Error("fixture starts with the user correction");
    expect(observed?.actor).toEqual({ kind: "user", id: correction.data.id });
    expect(observed?.data.evidence).toMatchObject({ class: "user-correction", independenceKey: "session-one" });
    expect((observed?.data.evidence as { sourceRef: string }).sourceRef).toMatch(/^session:session-one:user-message:user-\d+$/);
    expect(JSON.stringify(events)).not.toContain("abc123secret");
    expect(events.find((event) => event.type === "artifact.approved")?.data).toMatchObject({ receipt: { approvalAuditId: "audit-call-one" } });

    const projection = await service.events.fold();
    expect(projection.candidates[0]?.state).toBe("resolved");
    const artifact = projection.artifacts.find((item) => item.id === result.artifactId);
    expect(artifact?.state).toBe("active");
    expect(reasons[0]).toContain(`Exact content digest: ${artifact?.contentDigest}`);
    expect(artifact?.manifest.trigger).toEqual({ when: "deploying to staging or creating a deploy branch" });
    const prepared = await service.prepareExperienceContext(agent);
    expect(prepared.inline.map((item) => item.artifact.id)).toEqual([result.artifactId]);
    expect(prepared.inline[0]?.text).toContain("Push to the standing staging branch");
    const read = await service.readExperience(agent, "call-read" as never, result.artifactId as string);
    expect(read.body).toContain("Push to the standing staging branch");
    expect(read.body).not.toContain("Stop creating dated branches");
    expect((observed?.data.evidence as { summary: string }).summary).toContain("Stop creating dated branches");

    // Correct the same slug again: new version, old version retired, candidate resolved again.
    sessionEvents.push(userMessage("And ask me before creating a branch", Date.parse("2026-08-31T01:05:00.000Z")));
    const again = await service.recordUserCorrection(agent, "call-two" as never, {
      slug: "reuse-one-deploy-branch",
      lesson: "Push to the standing staging branch; ask before creating any branch.",
      when: "deploying to staging",
    });
    expect(again.artifactId).not.toBe(result.artifactId);
    const after = await service.events.fold();
    expect(after.artifacts.map((item) => [item.id, item.state])).toEqual([
      [result.artifactId, "retired"],
      [again.artifactId, "active"],
    ].sort((left, right) => (left[0] as string).localeCompare(right[0] as string)));
    expect(after.candidates[0]?.state).toBe("resolved");
    expect((await service.inlineContextsFor(agent)).map((item) => item.artifact.id)).toEqual([again.artifactId]);

    const approvalCount = reasons.length;
    await expect(service.recordUserCorrection(agent, "call-three" as never, { slug: "Bad Slug", lesson: "x", when: "y" })).rejects.toThrow(/kebab-case/);
    await expect(service.recordUserCorrection(agent, "call-four" as never, { slug: "ok", lesson: "x", when: "   " })).rejects.toThrow(/when/);
    expect(reasons).toHaveLength(approvalCount);
    await ctx.fiber.dispose();

    const rejecting = new Context();
    const rejectingEvents = [userMessage("no", 1)];
    rejecting.provide("approval", approvalStub("rejected", rejectingEvents));
    const rejectingService = evolutionService(rejecting, await temporaryDirectory());
    const refused = await rejectingService.recordUserCorrection(fakeAgent("session-two", rejectingEvents), "call-five" as never, {
      slug: "anything",
      lesson: "anything",
      when: "anything",
    });
    expect(refused.outcome).toBe("rejected");
    expect(await rejectingService.events.readAll()).toEqual([]);
    await rejecting.fiber.dispose();
  });
});
