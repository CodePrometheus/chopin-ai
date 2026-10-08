import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  assertCapabilityManifest,
  capabilityManifestDigest,
  capabilitySurfaceDigest,
  foldEvolutionEvents,
} from "@chopin/evolution";
import type { EvolutionEvent, EvolutionProjection, EvolutionTransaction, StagedArtifact } from "@chopin/evolution";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

import { ChopinEvolution } from "../src/index.js";

const memory = vi.hoisted(() => ({ files: new Map<string, string>(), histories: new Map<string, unknown>() }));

vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  mkdir: async () => undefined,
  rm: async (path: string) => {
    for (const key of [...memory.files.keys()]) if (key === path || key.startsWith(`${path}/`)) memory.files.delete(key);
  },
  writeFile: async (path: string, content: string) => { memory.files.set(path, content); },
  readFile: async (path: string) => {
    const value = memory.files.get(path);
    if (value === undefined) throw new Error(`missing in-memory file ${path}`);
    return value;
  },
  stat: async (path: string) => ({ size: Buffer.byteLength(memory.files.get(path) ?? "") }),
  rename: async (path: string, destination: string) => {
    for (const [key, value] of [...memory.files]) if (key === path || key.startsWith(`${path}/`)) {
      memory.files.set(destination + key.slice(path.length), value);
      memory.files.delete(key);
    }
  },
}));

vi.mock("@chopin/evolution", async (original) => {
  const actual = await original<typeof import("@chopin/evolution")>();
  class RegisteredHistory {
    constructor(path: string) {
      const history = memory.histories.get(path);
      if (history === undefined) throw new Error(`no in-memory history registered for ${path}`);
      return history as RegisteredHistory;
    }
  }
  return { ...actual, EvolutionEventStore: RegisteredHistory };
});

/** Real on-disk paths the store touches beside the in-memory fixture; removed after each test. */
const temporaryPaths: string[] = [];

class MemoryHistory {
  readonly path = join(tmpdir(), `memory-correction-${randomUUID()}`);
  constructor() { mkdirSync(this.path, { recursive: true }); temporaryPaths.push(this.path); }
  readonly history: EvolutionEvent[] = [];
  readonly batches: string[][] = [];
  failCommit = false;
  private queue = Promise.resolve();

  async readAll() { return [...this.history]; }
  async fold() { return foldEvolutionEvents(this.history); }
  async snapshot() {
    await this.queue;
    const events = [...this.history];
    return { revision: String(events.length), events, projection: foldEvolutionEvents(events) };
  }
  async append(event: EvolutionEvent) { await this.appendMany([event]); }
  async appendMany(events: readonly EvolutionEvent[]) {
    await this.transact(() => ({ events, value: undefined }));
  }
  async appendChecked(events: readonly EvolutionEvent[], assertCurrent: (projection: EvolutionProjection) => void) {
    await this.transact((projection) => { assertCurrent(projection); return { events, value: undefined }; });
  }
  transact<T>(derive: (projection: EvolutionProjection, history: readonly EvolutionEvent[]) => EvolutionTransaction<T>): Promise<T> {
    const run = this.queue.then(() => {
      const transaction = derive(foldEvolutionEvents(this.history), this.history);
      foldEvolutionEvents([...this.history, ...transaction.events]);
      if (this.failCommit && transaction.events.some((event) => event.type === "artifact.approved")) {
        throw new Error("injected commit failure");
      }
      const existing = new Set(this.history.map((event) => event.eventId));
      const fresh = transaction.events.filter((event) => !existing.has(event.eventId));
      if (fresh.length > 0) this.batches.push(fresh.map((event) => event.type));
      this.history.push(...fresh);
      return transaction.value;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

function inspectSource(path: string): StagedArtifact {
  const manifest = JSON.parse(memory.files.get(join(path, "capability.json")) ?? "null");
  assertCapabilityManifest(manifest);
  const files = [...memory.files.keys()].filter((key) => key.startsWith(`${path}/`))
    .map((key) => key.slice(path.length + 1)).sort((left, right) => left.localeCompare(right));
  const digest = createHash("sha256");
  for (const file of files) {
    const content = memory.files.get(join(path, file)) as string;
    digest.update(`${file}\0${Buffer.byteLength(content)}\0`).update(content).update("\0");
  }
  return {
    path, manifest, files,
    contentDigest: `sha256:${digest.digest("hex")}`,
    manifestDigest: capabilityManifestDigest(manifest),
    surfaceDigest: capabilitySurfaceDigest(manifest),
  };
}

const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.restoreAllMocks();
  memory.files.clear();
  memory.histories.clear();
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(history = new MemoryHistory()) {
  const ctx = new Context();
  contexts.push(ctx);
  const sessionEvents = [{
    type: "user/message", seq: 0, time: Date.now(),
    data: { id: "user-message-one", source: { kind: "user" }, content: [{ type: "text", text: "Read the file before editing it." }] },
  }] as unknown as SessionEvent[];
  const approval = vi.fn(async (input: { agent: Agent; callId: string; reason: string }) => {
    const events = sessionEvents;
    const time = Date.now();
    const auditId = `audit-${input.callId}`;
    events.push(
      { type: "approval/asked", seq: events.length, time, data: { id: auditId, callId: input.callId } } as unknown as SessionEvent,
      { type: "approval/decided", seq: events.length + 1, time, data: { id: auditId, outcome: "allowed-once" } } as unknown as SessionEvent,
    );
    return "allowed-once";
  });
  ctx.provide("approval", { request: approval });
  const eventsFile = join(history.path, "events.jsonl");
  memory.histories.set(eventsFile, history);
  const service = new ChopinEvolution(ctx, {
    eventsFile, artifactsDir: join(history.path, "artifacts"), receiptsDir: join(history.path, "receipts"),
    chopinVersion: "0.1.0", dshVersion: "0.1.1-rc.2", processGeneration: "correction-test", autonomous: false,
  });
  vi.spyOn(service.artifacts, "inspectSource").mockImplementation(async (path) => inspectSource(path));
  vi.spyOn(service.artifacts, "stage").mockImplementation(async (source) => {
    const staged = inspectSource(source);
    const target = join(service.artifacts.root, "sha256", staged.contentDigest.slice(7));
    for (const file of staged.files) memory.files.set(join(target, file), memory.files.get(join(source, file)) as string);
    return inspectSource(target);
  });
  vi.spyOn(service.artifacts, "inspect").mockImplementation(async (digest) => {
    const staged = inspectSource(join(service.artifacts.root, "sha256", digest.slice(7)));
    if (staged.contentDigest !== digest) throw new Error("content digest mismatch");
    return staged;
  });
  const agent = {
    id: "main",
    session: { id: "correction-session", header: { cwd: "workspace" }, snapshotEvents: () => [...sessionEvents] },
  } as unknown as Agent;
  return { service, history, agent, approval };
}

const input = { slug: "read-first", lesson: "Read the exact file before editing.", when: "editing an existing file" };

describe("correction commit", () => {
  it("concurrent replay approves once; after rebuilding the service a retry of the same message reuses it and is readable immediately", async () => {
    const { service, history, agent, approval } = fixture();
    const [first, concurrent] = await Promise.all([
      service.recordUserCorrection(agent, "one" as never, input),
      service.recordUserCorrection(agent, "two" as never, input),
    ]);
    expect(concurrent).toEqual(first);
    expect(approval).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ artifactState: "active", enabled: true });
    const reopened = fixture(history);
    const retry = await reopened.service.recordUserCorrection(agent, "three" as never, { ...input, lesson: ` ${input.lesson} ` });
    expect(retry).toEqual(first);
    expect(reopened.approval).not.toHaveBeenCalled();
    const prepared = await reopened.service.prepareExperienceContext(agent);
    expect(prepared.inline.map((item) => item.artifact.id)).toEqual([first.artifactId]);
    expect(prepared.inline[0]?.text).toContain(input.lesson);
    expect((await reopened.service.readExperience(agent, "read" as never, first.artifactId as string)).body).toContain(input.lesson);
    const projection = await history.fold();
    expect(projection.artifacts).toHaveLength(1);
    expect(projection.candidates[0]?.evidence).toHaveLength(1);
    expect(history.batches[0]).toEqual([
      "candidate.observed", "candidate.corroborated", "candidate.classified", "artifact.drafted",
      "artifact.built", "artifact.verified", "artifact.approved",
    ]);
    expect(approval.mock.calls[0]?.[0].reason).toContain(`Exact content digest: ${projection.artifacts[0]?.contentDigest}`);
  });

  it("different corrections of the same message committed concurrently use separate versions and reuse the original evidence event", async () => {
    const { service, history, agent } = fixture();
    const results = await Promise.all([
      service.recordUserCorrection(agent, "one" as never, input),
      service.recordUserCorrection(agent, "two" as never, { ...input, lesson: "Read the file and check its callers." }),
    ]);
    expect(new Set(results.map((result) => result.artifactId)).size).toBe(2);
    expect(new Set(results.map((result) => result.eventId)).size).toBe(1);
    const projection = await history.fold();
    expect(projection.artifacts).toHaveLength(2);
    expect(projection.artifacts.every((artifact) => artifact.approvalReceipts.length === 1)).toBe(true);
    expect(projection.candidates[0]?.evidence).toHaveLength(1);
    expect(projection.candidates[0]?.proposals).toHaveLength(2);
    expect(history.history.filter((event) => event.type === "candidate.observed")).toHaveLength(1);
    expect(projection.artifacts.filter((artifact) => artifact.enabled)).toHaveLength(1);
    expect(projection.artifacts.filter((artifact) => artifact.state === "retired")).toHaveLength(1);
  });

  it("a failed transaction commit lands no candidate, artifact or approval event, and retries normally once writes are fixed", async () => {
    const { service, history, agent } = fixture();
    history.failCommit = true;
    await expect(service.recordUserCorrection(agent, "one" as never, input)).rejects.toThrow("injected commit failure");
    expect(history.history).toEqual([]);
    history.failCommit = false;
    expect(await service.recordUserCorrection(agent, "two" as never, input)).toMatchObject({ artifactState: "active", enabled: true });
    expect((await history.fold()).artifacts).toHaveLength(1);
  });

  it("content changed after approval must not commit, and no approval is requested for an invalid trigger", async () => {
    const { service, history, agent, approval } = fixture();
    await expect(service.recordUserCorrection(agent, "invalid" as never, { ...input, when: " " })).rejects.toThrow(/when/);
    expect(approval).not.toHaveBeenCalled();
    vi.spyOn(service.artifacts, "stage").mockImplementationOnce(async (source) => ({
      ...inspectSource(source), contentDigest: `sha256:${"a".repeat(64)}`,
    }));
    await expect(service.recordUserCorrection(agent, "changed" as never, input)).rejects.toThrow(/changed after approval/);
    expect(history.history).toEqual([]);
  });

  it("a failed verification leaves no intermediate state, and the real state is returned while deployment is not yet effective", async () => {
    const { service, history, agent } = fixture();
    const inspect = service.artifacts.inspect.bind(service.artifacts);
    vi.spyOn(service.artifacts, "inspect").mockImplementationOnce(async (digest) => {
      const staged = await inspect(digest);
      return { ...staged, files: [...staged.files, "credentials.json"] };
    });
    await expect(service.recordUserCorrection(agent, "verify-fail" as never, input)).rejects.toThrow(/failed static verification/);
    expect(history.history).toEqual([]);
    vi.spyOn(service, "advance").mockResolvedValue({ verified: [], deployed: [], retired: [], resolved: [] });
    const result = await service.recordUserCorrection(agent, "pending" as never, input);
    expect(result).toMatchObject({ outcome: "allowed-once", artifactState: "approved", enabled: false });
  });
});
