import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => {
  type File = { text: string; ino: bigint; modified: bigint; changed: bigint };
  const files = new Map<string, File>();
  let tick = BigInt(Date.now()) * 1_000_000n;
  let inode = 0n;
  return {
    files, reads: 0, locks: 0, beforeSync: undefined as (() => Promise<void>) | undefined,
    put(path: string, text: string): File {
      const previous = files.get(path);
      const value = { text, ino: previous?.ino ?? ++inode, modified: ++tick, changed: tick };
      files.set(path, value);
      return value;
    },
    missing(code: string): Error { return Object.assign(new Error(code), { code }); },
    get(path: string): File {
      const value = files.get(path);
      if (!value) throw this.missing("ENOENT");
      return value;
    },
    info(value: File) {
      return { dev: 1n, ino: value.ino, size: BigInt(Buffer.byteLength(value.text)),
        mtimeNs: value.modified, ctimeNs: value.changed, mtimeMs: Number(value.modified / 1_000_000n) };
    },
  };
});

// File I/O runs in memory, using the real store, lock and state transition code.
vi.mock("node:fs/promises", async () => {
  const { Readable } = await import("node:stream");
  return {
    access: async (path: string) => { disk.get(path); },
    mkdir: async () => undefined,
    stat: async (path: string) => disk.info(disk.get(path)),
    readFile: async (path: string) => disk.get(path).text,
    writeFile: async (path: string, text: string) => { disk.put(path, text); },
    unlink: async (path: string) => { disk.get(path); disk.files.delete(path); },
    open: async (path: string, flag: string) => {
      if (flag === "wx") {
        if (disk.files.has(path)) throw disk.missing("EEXIST");
        disk.put(path, "");
        if (path.endsWith(".lock")) disk.locks++;
      } else if (flag === "a" && !disk.files.has(path)) disk.put(path, "");
      const file = disk.get(path);
      return {
        stat: async () => ({ size: Buffer.byteLength(file.text) }),
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const bytes = Buffer.from(file.text).subarray(position, position + length);
          bytes.copy(buffer, offset);
          return { bytesRead: bytes.length };
        },
        createReadStream: () => { disk.reads++; return Readable.from([file.text]); },
        writeFile: async (text: string) => { Object.assign(file, disk.put(path, flag === "a" ? file.text + text : text)); },
        sync: async () => { if (!path.endsWith(".lock")) await disk.beforeSync?.(); },
        close: async () => undefined,
      };
    },
  };
});

import { candidateObserved } from "../src/candidate.js";
import { EvolutionEventStore, EvolutionLogCorruptError, EvolutionLogLockError } from "../src/store.js";
import { foldEvolutionEvents } from "../src/fold.js";
import { startEvolutionSupervisor } from "../../../apps/cli/src/evolution.js";
import { HotActivationManager } from "../../plugin-adapter/src/index.js";
import { artifactQuarantined } from "../src/artifact.js";
import { capabilityManifestDigest, capabilitySurfaceDigest } from "../src/manifest.js";
import { gateManifest, lifecycle } from "../../evolution-runtime/tests/support.js";
import type { Context } from "@deepseek-ai/cordis";
import type { EvolutionEvent } from "../src/types.js";
import type { ExecutionContext } from "../src/execution-context.js";
import { normalizeTriggerFacts } from "../../evolution-runtime/src/selection.js";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { PromptAssembly } from "@deepseek-ai/dsh-system-prompt";

vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs")>(),
  watch: () => ({ on() { return this; }, close() {} }),
}));

const path = "events.jsonl";
function observed(id: string, lesson = "Read the declared inputs.") {
  return candidateObserved({ candidateId: `candidate-${id}`, eventId: `event-${id}`,
    actor: { kind: "system", id: "observer" }, occurredAt: "2026-09-14T00:00:00.000Z" }, {
    signalKey: `signal-${id}`, lesson,
    evidence: { evidenceId: `evidence-${id}`, class: "session-signal", independenceKey: id,
      independentUnits: 1, observedAt: "2026-09-14T00:00:00.000Z", contentHash: `sha256:${"a".repeat(64)}`,
      summary: "A tool returned a failure.", sourceSessionId: `session-${id}` },
  });
}
function seed(...events: EvolutionEvent[]) {
  disk.put(path, events.map(event => JSON.stringify(event) + "\n").join(""));
}
function store() { return new EvolutionEventStore(path, { lockRetryMs: 1, lockTimeoutMs: 100 }); }

beforeEach(() => {
  disk.files.clear(); disk.reads = 0; disk.locks = 0; disk.beforeSync = undefined;
});

describe("event snapshot consistency", () => {
  it("unchanged concurrent reads share one parse and one immutable projection", async () => {
    const events = Array.from({ length: 500 }, (_, i) => observed(String(i)));
    seed(...events);
    const reader = store();
    const snapshots = await Promise.all(Array.from({ length: 30 }, () => reader.snapshot()));
    expect(disk.reads).toBe(1);
    expect(disk.locks).toBe(1);
    expect(snapshots.every(snapshot => snapshot === snapshots[0])).toBe(true);
    expect(snapshots[0]!.projection).toEqual(foldEvolutionEvents(events));
    expect(() => { snapshots[0]!.projection.candidates[0]!.lesson = "changed"; }).toThrow();
    const history = await reader.readAll();
    history[0]!.data.lesson = "caller mutation";
    const projection = await reader.fold();
    projection.candidates.length = 0;
    expect((await reader.snapshot()).projection).toEqual(foldEvolutionEvents(events));
    expect(disk.reads).toBe(1);
  });

  it("another writer invalidates the cached history and projection", async () => {
    seed(observed("one"));
    const reader = store();
    const before = await reader.snapshot();
    await store().append(observed("two"));
    const after = await reader.snapshot();
    expect(after.revision).not.toBe(before.revision);
    expect(after.projection).toEqual(foldEvolutionEvents([observed("one"), observed("two")]));
    expect(before.projection.eventCount).toBe(1);
  });

  it("a cached read waits for a writer to durably finish before publishing", async () => {
    seed(observed("one"));
    const reader = store();
    await reader.snapshot();
    let release!: () => void;
    let entered!: () => void;
    const syncing = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    disk.beforeSync = async () => { entered(); await gate; };
    const writing = store().append(observed("two"));
    await syncing;
    let returned = false;
    const reading = reader.snapshot().then(value => { returned = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(returned).toBe(false);
    release();
    await writing;
    expect((await reading).projection.eventCount).toBe(2);
  });

  it("same-size edits invalidate even if the modification timestamp is restored", async () => {
    seed(observed("one", "First."));
    const reader = store();
    const before = await reader.snapshot();
    const modified = disk.get(path).modified;
    seed(observed("one", "Other."));
    disk.get(path).modified = modified;
    const after = await reader.snapshot();
    expect(after.revision).not.toBe(before.revision);
    expect(after.projection.candidates[0]!.lesson).toBe("Other.");
  });

  it("file replacement invalidates identical sizes and timestamps", async () => {
    seed(observed("one", "First."));
    const reader = store();
    await reader.snapshot();
    const previous = disk.get(path);
    disk.files.delete(path);
    seed(observed("one", "Other."));
    Object.assign(disk.get(path), { modified: previous.modified, changed: previous.changed });
    expect((await reader.snapshot()).projection.candidates[0]!.lesson).toBe("Other.");
  });

  it.each(["\n", "{broken}\n", JSON.stringify(observed("two"))])("corruption never returns an earlier successful snapshot: %s", async suffix => {
    seed(observed("one"));
    const reader = store();
    await reader.snapshot();
    disk.put(path, disk.get(path).text + suffix);
    await expect(reader.snapshot()).rejects.toBeInstanceOf(EvolutionLogCorruptError);
    await expect(reader.snapshot()).rejects.toBeInstanceOf(EvolutionLogCorruptError);
    seed(observed("two"));
    expect((await reader.snapshot()).projection.candidates[0]!.id).toBe("candidate-two");
  });

  it("a write revalidates disk history and rejects conflicting identities without appending", async () => {
    seed(observed("one"));
    const writer = store();
    await writer.snapshot();
    disk.put(path, disk.get(path).text + JSON.stringify(observed("one", "Changed.")) + "\n");
    const before = disk.get(path).text;
    await expect(writer.append(observed("two"))).rejects.toThrow("different content");
    expect(disk.get(path).text).toBe(before);
  });

  it("write failure releases its lock, and queued operations can recover", async () => {
    seed(observed("one"));
    const writer = store();
    await expect(writer.transact(() => { throw new Error("denied"); })).rejects.toThrow("denied");
    await Promise.all([writer.append(observed("two")), store().append(observed("three"))]);
    expect((await writer.snapshot()).projection.eventCount).toBe(3);
    expect(disk.files.has(`${path}.lock`)).toBe(false);
  });

  it("an outstanding lock never permits a cached result after timeout", async () => {
    seed(observed("one"));
    const reader = new EvolutionEventStore(path, { lockRetryMs: 1, lockTimeoutMs: 5 });
    await reader.snapshot();
    disk.put(`${path}.lock`, JSON.stringify({ pid: process.pid }));
    await expect(reader.snapshot()).rejects.toBeInstanceOf(EvolutionLogLockError);
  });

  it("idle deployment scans reuse one snapshot and notice an external append", async () => {
    seed(observed("one"));
    const runGeneration = vi.fn(async () => 0);
    const supervisor = await startEvolutionSupervisor({ eventsFile: path, mainScript: "unused.mjs",
      configPath: "unused.yml", runGeneration, pollIntervalMs: 60_000 });
    try {
      await supervisor.scanNow();
      const reads = disk.reads;
      for (let i = 0; i < 20; i++) await supervisor.scanNow();
      expect(disk.reads).toBe(reads);
      seed(observed("one"), observed("two"));
      await supervisor.scanNow();
      expect(disk.reads).toBe(reads + 1);
      expect(runGeneration).not.toHaveBeenCalled();
    } finally { await supervisor.stop(); }
  });

  it("removes an advertised capability when the same session leaves its scope", async () => {
    const manifest = gateManifest("scoped-tool");
    manifest.trigger = { repos: ["allowed"], environments: ["fixed-route"] };
    let facts = normalizeTriggerFacts({ repos: ["allowed"], environments: ["fixed-route"] });
    seed();
    const schemas = vi.fn(() => [{ name: "native_read" }, { name: "scoped_read" }]);
    const context = { tools: { schemas }, chopinEvolution: { events: store(), contextPrompt: () => ({ prompt: "Inspect files", requestId: "request" }),
      factsFor: async () => facts, factsNowFor: () => facts, clearPreparedContexts() {}, recordExposure: async () => {} } } as unknown as Context;
    const rendered: ExecutionContext[] = [];
    const manager = new HotActivationManager(context, { watchChanges: false });
    const internal = manager as unknown as { mounted: Map<string, unknown>; rewriteAssembly(assembly: PromptAssembly, agent: Agent): Promise<void> };
    internal.mounted.set(manifest.id, { artifact: { id: "scoped-tool:1.0.0", manifest }, plugin: {
      renderContext(_name: string, input: { environment: ExecutionContext }) { rendered.push(input.environment); return ""; },
      inspection: { definitions: {
        tools: [{ name: "scoped_read", description: "Read declared files", inputSchema: { type: "object" } }],
        contexts: [{ name: "execution-view", order: 1 }] } } } });
    const agent = { session: { id: "same-session", header: { cwd: "allowed" }, snapshotEvents: () => [] } } as unknown as Agent;
    const assembly = { tools: [{ name: "native_read" }], contexts: [] } as unknown as PromptAssembly;
    await internal.rewriteAssembly(assembly, agent);
    expect(assembly.tools.map(tool => tool.name)).toEqual(["native_read", "scoped_read"]);
    expect(rendered[0]?.tools).toEqual(["native_read", "scoped_read"]);
    expect(schemas).toHaveBeenLastCalledWith(agent);
    expect(rendered[0]).not.toHaveProperty("writable");
    facts = normalizeTriggerFacts({ repos: ["other"], environments: ["fixed-route"] });
    await internal.rewriteAssembly(assembly, agent);
    expect(assembly.tools.map(tool => tool.name)).toEqual(["native_read"]);
    expect(rendered).toHaveLength(1);
    facts = normalizeTriggerFacts({ repos: ["allowed"], environments: ["other-route"] });
    await internal.rewriteAssembly(assembly, agent);
    expect(assembly.tools.map(tool => tool.name)).toEqual(["native_read"]);
    facts = normalizeTriggerFacts({ repos: ["allowed"], environments: ["fixed-route"] });
    await internal.rewriteAssembly(assembly, agent);
    expect(assembly.tools.map(tool => tool.name)).toEqual(["native_read", "scoped_read"]);
    schemas.mockReturnValue([{ name: "native_read" }, { name: "scoped_read" }, { name: "run_code" }]);
    assembly.tools = [{ name: "run_code", description: "Execute registered tools indirectly.", parameters: { type: "object" } }];
    await internal.rewriteAssembly(assembly, agent);
    expect(rendered.at(-1)?.tools).toEqual(["native_read", "scoped_read", "run_code"]);
  });

  it("a cached active capability is withdrawn only when the current step releases its lease", async () => {
    const manifest = gateManifest("guarded-step");
    const events = lifecycle({ manifest, path: "source", files: ["capability.json", manifest.entry],
      contentDigest: `sha256:${"b".repeat(64)}`, manifestDigest: capabilityManifestDigest(manifest),
      surfaceDigest: capabilitySurfaceDigest(manifest) });
    seed(...events);
    const reader = store();
    const artifact = (await reader.snapshot()).projection.artifacts[0]!;
    const context = { chopinEvolution: { events: reader, pluginApiVersion: "1.0.0", dshVersion: manifest.requires.dsh },
      logger: { info() {}, warn() {} } } as unknown as Context;
    const manager = new HotActivationManager(context, { watchChanges: false });
    const dispose = vi.fn();
    const internal = manager as unknown as { mounted: Map<string, unknown>; stepLeases: Map<string, symbol> };
    internal.mounted.set(manifest.id, { artifact, plugin: {}, dispose });
    await manager.reconcile();
    const reads = disk.reads;
    for (let i = 0; i < 20; i++) await manager.reconcile();
    expect(disk.reads).toBe(reads);
    internal.stepLeases.set("running-session", Symbol("step"));
    seed(...events, artifactQuarantined({ artifactId: artifact.id }, "Independent verification failed."));
    await manager.reconcile();
    expect(dispose).not.toHaveBeenCalled();
    internal.stepLeases.clear();
    await manager.reconcile();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager.artifacts).toEqual([]);
    expect(disk.reads).toBe(reads + 1);
    manager.stop();
  });
});
