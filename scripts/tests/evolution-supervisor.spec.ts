import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  reconcileEvolutionGeneration,
  runEvolutionReconcileProcess,
  startEvolutionSupervisor,
  superviseEvolution,
} from "../../apps/cli/src/evolution.js";
import type { EvolutionSupervisorHandle } from "../../apps/cli/src/evolution.js";
import { EVOLUTION_SUPERVISOR_FLAG, planService, shouldSuperviseInvocation } from "../../apps/cli/src/service.js";
import {
  ArtifactStore,
  EvolutionEventStore,
  artifactApproved,
  artifactBuilt,
  artifactCanaryActivated,
  artifactDeploymentRequested,
  artifactDrafted,
  artifactInstalledDisabled,
  artifactVerified,
} from "../../packages/evolution/src/index.js";
import type { CapabilityManifest } from "../../packages/evolution/src/index.js";
import {
  approvalReceipt,
  deploymentReceipt,
  deploymentRequest,
  verificationReceipt,
} from "../../packages/evolution/tests/receipt-fixtures.js";

const temporaryDirectories: string[] = [];
const supervisors: EvolutionSupervisorHandle[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chopin-supervisor-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function manifest(overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    schemaVersion: 1,
    id: "cold-supervisor-tool",
    version: "1.0.0",
    kind: "tool",
    runtime: "dsh-plugin",
    intendedEffect: "preventive",
    summary: "Exercise cold deployment recovery.",
    entry: "index.mjs",
    trigger: { repos: ["chopin"] },
    provides: { contexts: [], skills: [], guards: [], tools: ["cold_supervisor_tool"], services: [], workflows: [] },
    permissions: ["tools:register"],
    dependencies: [],
    conflicts: [],
    requires: { chopinPluginApi: "^1.0.0", dsh: "0.1.1-rc.2" },
    lineage: { candidateIds: ["cold-supervisor-candidate"], proposalIds: ["cold-supervisor-proposal"] },
    ...overrides,
  };
}

function pendingCanaryEvents(value = manifest()) {
  const contentDigest = `sha256:${"9".repeat(64)}`;
  const artifactId = `${value.id}:${value.version}`;
  const draft = artifactDrafted({ artifactId }, { manifest: value, contentDigest });
  const binding = {
    artifactId,
    contentDigest,
    manifestDigest: draft.data.manifestDigest as string,
    surfaceDigest: draft.data.surfaceDigest as string,
    manifest: value,
  };
  return {
    artifactId,
    binding,
    events: [
      draft,
      artifactBuilt({ artifactId }, {
        contentDigest: binding.contentDigest,
        manifestDigest: binding.manifestDigest,
        surfaceDigest: binding.surfaceDigest,
        sourceRevision: "git:0123456789abcdef",
      }),
      artifactVerified({ artifactId }, verificationReceipt(binding)),
      artifactApproved({ artifactId }, approvalReceipt(binding)),
      artifactDeploymentRequested({ artifactId }, deploymentRequest(binding, "disabled")),
      artifactInstalledDisabled({ artifactId }, deploymentReceipt(binding, "disabled")),
      artifactDeploymentRequested({ artifactId }, deploymentRequest(binding, "canary")),
    ],
  };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function saveEnvironment(keys: readonly string[]): () => void {
  const values = new Map(keys.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of values) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

describe("cold evolution supervisor", () => {
  it("ordinary UI runs advance deployment by default; diagnostic and management commands start no supervisor", () => {
    for (const args of [[], ["web"], ["--resume", "session-one"], ["web", "--port", "3000"]]) {
      expect(shouldSuperviseInvocation(args)).toBe(true);
    }
    for (const args of [["help"], ["--help"], ["--version"], ["--dump-config"], ["web", "--dump-default-config"], ["plugin", "list"], ["install"], ["evolution-reconcile", "generation-one"]]) {
      expect(shouldSuperviseInvocation(args)).toBe(false);
    }
  });

  it("scans a generation that was already pending before startup", async () => {
    const directory = await temporaryDirectory();
    const eventsFile = join(directory, "events.jsonl");
    const store = new EvolutionEventStore(eventsFile);
    const fixture = pendingCanaryEvents();
    await store.appendMany(fixture.events);

    const results = await superviseEvolution({
      eventsFile,
      mainScript: join(directory, "unused.mjs"),
      configPath: join(directory, "unused.yml"),
      runGeneration: async () => {
        await store.append(artifactCanaryActivated({ artifactId: fixture.artifactId }, deploymentReceipt(fixture.binding, "canary")));
        return 0;
      },
    });
    expect(results).toEqual([{ generation: "generation-canary", exitCode: 0 }]);
    expect((await store.fold()).artifacts[0]?.state).toBe("canary-active");
  });

  it("wakes on a new JSONL append and two supervisors claim one generation only once", async () => {
    const directory = await temporaryDirectory();
    const eventsFile = join(directory, "events.jsonl");
    const store = new EvolutionEventStore(eventsFile);
    const fixture = pendingCanaryEvents();
    let runs = 0;
    const runGeneration = async (generation: string) => {
      runs += 1;
      expect(generation).toBe("generation-canary");
      await new Promise((resolve) => setTimeout(resolve, 40));
      await store.append(artifactCanaryActivated({ artifactId: fixture.artifactId }, deploymentReceipt(fixture.binding, "canary")));
      return 0;
    };
    const input = {
      eventsFile,
      mainScript: join(directory, "unused.mjs"),
      configPath: join(directory, "unused.yml"),
      pollIntervalMs: 20,
      debounceMs: 5,
      retryDelayMs: 50,
      claimStaleMs: 1_000,
      runGeneration,
    };
    supervisors.push(await startEvolutionSupervisor(input));
    supervisors.push(await startEvolutionSupervisor(input));

    await store.appendMany(fixture.events);
    await waitUntil(async () => (await store.fold()).artifacts[0]?.state === "canary-active");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runs).toBe(1);
  });

  it("runs the reconciler as a quiet child and stops it through AbortSignal", async () => {
    const directory = await temporaryDirectory();
    const script = join(directory, "runner.mjs");
    const trace = join(directory, "trace.json");
    const restore = saveEnvironment(["CHOPIN_TEST_RUNNER_TRACE"]);
    process.env.CHOPIN_TEST_RUNNER_TRACE = trace;
    try {
      await writeFile(script, [
        "import { writeFile } from 'node:fs/promises';",
        "await writeFile(process.env.CHOPIN_TEST_RUNNER_TRACE, JSON.stringify(process.argv.slice(2)));",
        "console.log('this must stay out of the parent output');",
        "if (process.argv.includes('hold-generation')) { setInterval(() => {}, 1000); await new Promise(() => {}); }",
        "",
      ].join("\n"), "utf8");

      expect(await runEvolutionReconcileProcess({
        generation: "process-generation",
        mainScript: script,
        configPath: join(directory, "config.yml"),
      })).toBe(0);
      expect(JSON.parse(await readFile(trace, "utf8"))).toEqual([
        "evolution-reconcile",
        "process-generation",
        "--config",
        join(directory, "config.yml"),
      ]);

      const abort = new AbortController();
      const running = runEvolutionReconcileProcess({
        generation: "hold-generation",
        mainScript: script,
        configPath: join(directory, "config.yml"),
        signal: abort.signal,
      });
      await waitUntil(async () => {
        try {
          return (await readFile(trace, "utf8")).includes("hold-generation");
        } catch {
          return false;
        }
      });
      abort.abort();
      expect(await running).toBe(1);
    } finally {
      restore();
    }
  });

  it("recovers installed-disabled by inspection without importing candidate code", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "source");
    const artifactsDir = join(directory, "artifacts");
    const eventsFile = join(directory, "events.jsonl");
    const receiptsDir = join(directory, "receipts");
    const sentinel = join(directory, "candidate-code-ran");
    await mkdir(source);
    const value = manifest();
    await writeFile(join(source, "capability.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await writeFile(join(source, value.entry), [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.CHOPIN_TEST_SENTINEL, 'candidate code executed');",
      `export default { manifest: ${JSON.stringify(value)}, activate() {} };`,
      "",
    ].join("\n"), "utf8");
    const staged = await new ArtifactStore(artifactsDir).stage(source);
    const artifactId = `${value.id}:${value.version}`;
    const binding = { artifactId, ...staged };
    const store = new EvolutionEventStore(eventsFile);
    await store.appendMany([
      artifactDrafted({ artifactId }, { manifest: value, contentDigest: staged.contentDigest }),
      artifactBuilt({ artifactId }, {
        contentDigest: staged.contentDigest,
        manifestDigest: staged.manifestDigest,
        surfaceDigest: staged.surfaceDigest,
        sourceRevision: "git:0123456789abcdef",
      }),
      artifactVerified({ artifactId }, verificationReceipt(binding)),
      artifactApproved({ artifactId }, approvalReceipt(binding)),
      artifactDeploymentRequested({ artifactId }, deploymentRequest(binding, "disabled")),
    ]);

    const keys = [
      "CHOPIN_EVOLUTION_EVENTS",
      "CHOPIN_EVOLUTION_ARTIFACTS",
      "CHOPIN_EVOLUTION_RECEIPTS",
      "CHOPIN_TEST_SENTINEL",
    ] as const;
    const restore = saveEnvironment(keys);
    Object.assign(process.env, {
      CHOPIN_EVOLUTION_EVENTS: eventsFile,
      CHOPIN_EVOLUTION_ARTIFACTS: artifactsDir,
      CHOPIN_EVOLUTION_RECEIPTS: receiptsDir,
      CHOPIN_TEST_SENTINEL: sentinel,
    });
    try {
      const configPath = fileURLToPath(new URL("../../config/evolution-reconcile.cordis.yml", import.meta.url));
      const result = await reconcileEvolutionGeneration(configPath, "generation-disabled");
      expect(result).toMatchObject({ completedRequestIds: ["operation-disabled"], failedRequestIds: [] });
      expect((await store.fold()).artifacts[0]?.state).toBe("installed-disabled");
      await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restore();
    }
  });
});

describe("launchd service plan", () => {
  it("starts the daemon supervisor sibling and forwards evolution storage overrides", () => {
    const keys = ["CHOPIN_EVOLUTION_EVENTS", "CHOPIN_EVOLUTION_ARTIFACTS", "CHOPIN_EVOLUTION_RECEIPTS"] as const;
    const restore = saveEnvironment(keys);
    Object.assign(process.env, {
      CHOPIN_EVOLUTION_EVENTS: "/tmp/chopin-events.jsonl",
      CHOPIN_EVOLUTION_ARTIFACTS: "/tmp/chopin-artifacts",
      CHOPIN_EVOLUTION_RECEIPTS: "/tmp/chopin-receipts",
    });
    try {
      const plan = planService("/tmp/chopin-main.js", 3080);
      expect(plan.argv.at(-1)).toBe(EVOLUTION_SUPERVISOR_FLAG);
      expect(Object.fromEntries(plan.env)).toMatchObject({
        CHOPIN_EVOLUTION_EVENTS: "/tmp/chopin-events.jsonl",
        CHOPIN_EVOLUTION_ARTIFACTS: "/tmp/chopin-artifacts",
        CHOPIN_EVOLUTION_RECEIPTS: "/tmp/chopin-receipts",
      });
    } finally {
      restore();
    }
  });
});
