import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactStore,
  ArtifactStoreError,
  InvalidCapabilityManifestError,
  assertCapabilityManifest,
  capabilityManifestDigest,
  capabilitySurfaceDigest,
  leastPowerfulArtifactKind,
  verifyStagedArtifact,
} from "../src/index.js";
import type { CapabilityManifest } from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chopin-artifact-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function manifest(overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    schemaVersion: 1,
    id: "retry-spawn-ebadf",
    version: "1.0.0",
    kind: "plugin",
    runtime: "dsh-plugin",
    intendedEffect: "preventive",
    summary: "Retry one known transient spawn failure.",
    entry: "index.js",
    trigger: { tools: ["bash"], errorKeys: ["spawn ebadf"] },
    provides: {
      contexts: [],
      skills: [],
      guards: [],
      tools: [],
      services: ["retry-spawn-ebadf"],
      workflows: [],
    },
    permissions: ["tools:execute-wrapper"],
    dependencies: [],
    conflicts: [],
    requires: { chopinPluginApi: "^1.0.0", dsh: "0.1.1-rc.2" },
    lineage: { candidateIds: ["spawn-ebadf"], proposalIds: ["plugin-spawn-ebadf"] },
    ...overrides,
  };
}

async function writeArtifact(directory: string, value = manifest()): Promise<void> {
  await writeFile(join(directory, "capability.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeFile(join(directory, "index.js"), "export default function activate() {}\n", "utf8");
}

describe("capability manifest", () => {
  it("computes the full manifest digest and the permission surface digest separately", () => {
    const value = manifest();
    expect(capabilityManifestDigest(value)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(capabilitySurfaceDigest(value)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(capabilityManifestDigest(value)).not.toBe(capabilitySurfaceDigest(value));
  });

  it("rejects a plugin with higher permissions disguised as data", () => {
    expect(() => assertCapabilityManifest(manifest({ runtime: "data" }))).toThrow(InvalidCapabilityManifestError);
  });

  it("strictly binds kind, runtime and capability surface", () => {
    expect(() => assertCapabilityManifest(manifest({
      id: "memory-bad-surface",
      kind: "memory",
      runtime: "data",
      intendedEffect: "advisory",
      permissions: [],
      provides: { contexts: ["memory"], skills: [], guards: ["hidden-guard"], tools: [], services: [], workflows: [] },
      requires: { chopinPluginApi: "^1.0.0" },
    }))).toThrow(/cannot declare provides.guards/);
    expect(() => assertCapabilityManifest(manifest({
      id: "gate-as-data",
      kind: "gate",
      runtime: "data",
      provides: { contexts: [], skills: [], guards: ["gate"], tools: [], services: [], workflows: [] },
      requires: { chopinPluginApi: "^1.0.0" },
    }))).toThrow(/must use dsh-plugin/);
    expect(() => assertCapabilityManifest(manifest({
      id: "tool-without-tool",
      kind: "tool",
      provides: { contexts: [], skills: [], guards: ["guard"], tools: [], services: [], workflows: [] },
    }))).toThrow(/must declare provides.tools/);
    expect(() => assertCapabilityManifest(manifest({
      id: "empty-plugin",
      provides: { contexts: [], skills: [], guards: [], tools: [], services: [], workflows: [] },
    }))).toThrow(/at least one capability surface/);
  });

  it("picks the least-privileged kind in the order memory, skill, gate, tool, plugin", () => {
    expect(leastPowerfulArtifactKind(["plugin", "gate", "skill"])).toBe("skill");
  });
});

describe("content-addressed artifact store", () => {
  it("identical bytes land idempotently on the same content address, and a change yields a new digest", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "source");
    await mkdir(source);
    await writeArtifact(source);
    const store = new ArtifactStore(join(directory, "store"));

    const first = await store.stage(source);
    const same = await store.stage(source);
    expect(same.contentDigest).toBe(first.contentDigest);
    expect(same.path).toBe(first.path);
    expect(await readFile(join(first.path, "index.js"), "utf8")).toContain("activate");

    await writeFile(join(source, "index.js"), "export default function activate() { return 1 }\n", "utf8");
    const changed = await store.stage(source);
    expect(changed.contentDigest).not.toBe(first.contentDigest);
  });

  it("rejects symlinks so runtime-reachable content cannot escape the reviewed directory", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "source");
    await mkdir(source);
    await writeArtifact(source);
    await symlink("/etc/hosts", join(source, "hosts-link"));
    await expect(new ArtifactStore(join(directory, "store")).stage(source)).rejects.toThrow(ArtifactStoreError);
  });

  it("inspect reports an explicit digest mismatch after the content address is tampered with", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "source");
    await mkdir(source);
    await writeArtifact(source);
    const store = new ArtifactStore(join(directory, "store"));
    const staged = await store.stage(source);
    await writeFile(join(staged.path, "index.js"), "tampered\n", "utf8");
    await expect(store.inspect(staged.contentDigest)).rejects.toThrow(/digest mismatch/);
  });
});

describe("static verification receipt", () => {
  it("a data capability verifies body and surface but honestly marks the behavioral canary as not run", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "source");
    await mkdir(source);
    const value = manifest({
      id: "memory-read-first",
      kind: "memory",
      runtime: "data",
      intendedEffect: "advisory",
      entry: "memory.md",
      permissions: [],
      provides: { contexts: ["read-first"], skills: [], guards: [], tools: [], services: [], workflows: [] },
      requires: { chopinPluginApi: "^1.0.0" },
    });
    await writeFile(join(source, "capability.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await writeFile(join(source, "memory.md"), "Read the target file before editing it.\n", "utf8");
    const store = new ArtifactStore(join(directory, "store"));
    const staged = await store.stage(source);

    const receipt = await verifyStagedArtifact(store, staged.contentDigest, {
      sourceRevision: "git:0123456789abcdef",
      receiptsDir: join(directory, "receipts"),
      chopinVersion: "0.1.0",
      dshVersion: "0.1.1-rc.2",
    });
    expect(receipt.verdict).toBe("pass");
    expect(receipt.checks.find((check) => check.name === "behavioral-canary")?.status).toBe("skipped");
    expect(await readFile(receipt.durableOutputRef, "utf8")).toContain(staged.contentDigest);
  });

  it("an executable entry gets only a syntax check; a syntax error yields a fail receipt instead of running code", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "source");
    await mkdir(source);
    await writeArtifact(source);
    await writeFile(join(source, "index.js"), "const = ;\n", "utf8");
    const store = new ArtifactStore(join(directory, "store"));
    const staged = await store.stage(source);
    const receipt = await verifyStagedArtifact(store, staged.contentDigest, {
      sourceRevision: "git:0123456789abcdef",
      receiptsDir: join(directory, "receipts"),
      chopinVersion: "0.1.0",
      dshVersion: "0.1.1-rc.2",
    });
    expect(receipt.verdict, JSON.stringify(receipt.checks)).toBe("fail");
    expect(receipt.checks.find((check) => check.name === "entry-syntax")?.status).toBe("fail");
  });
});
