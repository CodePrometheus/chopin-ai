import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactStore,
  assertCapabilityFixtureSuite,
  assertFixtureCoverage,
  capabilityFixtureDigest,
  verifyStagedArtifact,
} from "../src/index.js";
import type { CapabilityFixtureSuite, CapabilityManifest } from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chopin-fixtures-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function manifest(): CapabilityManifest {
  return {
    schemaVersion: 1,
    id: "fixture-tool",
    version: "1.0.0",
    kind: "tool",
    runtime: "dsh-plugin",
    intendedEffect: "preventive",
    summary: "Exercise a generated tool contract.",
    entry: "index.mjs",
    trigger: { environments: ["local"] },
    provides: { contexts: [], skills: [], guards: [], tools: ["fixture_echo"], services: [], workflows: [] },
    permissions: ["tools:register"],
    dependencies: [],
    conflicts: [],
    requires: { chopinPluginApi: "^1.0.0", dsh: "0.1.1-rc.2" },
    lineage: { candidateIds: ["fixture-candidate"], proposalIds: ["fixture-proposal"] },
  };
}

function suite(name = "fixture_echo"): CapabilityFixtureSuite {
  return {
    schemaVersion: 1,
    cases: [{
      id: "echo-one",
      kind: "tool",
      name,
      input: { callId: "fixture-call", arguments: { text: "works" } },
      expect: { equals: { echo: "works" } },
    }],
  };
}

async function staged(withFixture: boolean) {
  const directory = await temporaryDirectory();
  const source = join(directory, "source");
  await mkdir(source);
  await writeFile(join(source, "capability.json"), `${JSON.stringify(manifest(), null, 2)}\n`, "utf8");
  await writeFile(join(source, "index.mjs"), "export default { manifest: {}, activate() {} };\n", "utf8");
  if (withFixture) await writeFile(join(source, "capability.tests.json"), `${JSON.stringify(suite(), null, 2)}\n`, "utf8");
  const store = new ArtifactStore(join(directory, "artifacts"));
  return { directory, store, artifact: await store.stage(source) };
}

describe("capability behavior fixtures", () => {
  it("strictly validates cases and requires coverage of every executable surface", () => {
    const value = suite();
    expect(() => assertCapabilityFixtureSuite(value)).not.toThrow();
    expect(() => assertFixtureCoverage(value, manifest())).not.toThrow();
    expect(() => assertFixtureCoverage(suite("undeclared"), manifest())).toThrow(/undeclared surface/);
  });

  it("the verification receipt binds the real fixture bytes digest", async () => {
    const { directory, store, artifact } = await staged(true);
    const receipt = await verifyStagedArtifact(store, artifact.contentDigest, {
      sourceRevision: `host:test:${artifact.contentDigest}`,
      receiptsDir: join(directory, "receipts"),
      chopinVersion: "0.1.0",
      dshVersion: "0.1.1-rc.2",
    });
    const content = JSON.parse(await readFile(join(artifact.path, "capability.tests.json"), "utf8"));
    const expected = capabilityFixtureDigest(content);
    expect(receipt.fixtureDigest).toBe(expected);
    expect(receipt.checks.find((check) => check.name === "fixture-contract")?.status).toBe("pass");
  });

  it("an executable artifact without behavior fixtures fails closed", async () => {
    const { directory, store, artifact } = await staged(false);
    const receipt = await verifyStagedArtifact(store, artifact.contentDigest, {
      sourceRevision: `host:test:${artifact.contentDigest}`,
      receiptsDir: join(directory, "receipts"),
      chopinVersion: "0.1.0",
      dshVersion: "0.1.1-rc.2",
    });
    expect(receipt.verdict).toBe("fail");
    expect(receipt.checks.find((check) => check.name === "fixture-contract")?.detail).toContain("requires capability.tests.json");
  });
});
