import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ArtifactStore,
  EvolutionEventStore,
  artifactActivated,
  artifactApproved,
  artifactBuilt,
  artifactCanaryActivated,
  artifactDeploymentRequested,
  artifactDrafted,
  artifactInstalledDisabled,
  artifactQuarantined,
  artifactRetired,
  artifactRolledBack,
  artifactVerified,
  capabilityPermissionDigest,
  capabilityProvidesDigest,
  capabilityFixtureDigest,
} from "@chopin/evolution";
import type {
  ApprovalReceipt,
  ArtifactReference,
  CapabilityFixtureSuite,
  JsonValue,
  CapabilityManifest,
  DeploymentMode,
  DeploymentReceipt,
  DeploymentRequest,
  VerificationReceipt,
} from "@chopin/evolution";

const time = "2026-08-31T00:00:00.000Z";

function contentHash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const manifestV1: CapabilityManifest = {
  schemaVersion: 1,
  id: "learned-echo",
  version: "1.0.0",
  kind: "plugin",
  runtime: "dsh-plugin",
  intendedEffect: "preventive",
  summary: "Echo one string through a learned typed tool.",
  entry: "index.mjs",
  trigger: { environments: ["local"], taskKinds: ["fixture-work"] },
  provides: { contexts: ["version_note"], skills: [], guards: [], tools: ["learned_echo"], services: [], workflows: [] },
  permissions: ["tools:register", "system-prompt:context"],
  dependencies: [],
  conflicts: [],
  requires: { chopinPluginApi: "^1.0.0", dsh: "0.1.3-alpha.1" },
  lineage: { candidateIds: ["learned-echo-candidate"], proposalIds: ["learned-echo-tool"] },
};

function fixtureSuite(prefix: string): CapabilityFixtureSuite {
  return {
    schemaVersion: 1,
    cases: [{
      id: "learned-echo-contract",
      kind: "tool",
      name: "learned_echo",
      input: { callId: "fixture-call", arguments: { text: "fixture works" } },
      expect: { equals: { echo: `${prefix}:fixture works` } },
    }, {
      id: "learned-context-contract", kind: "context", name: "version_note",
      input: { workspace: "fixture", prompt: "fixture prompt" },
      expect: { equals: `${prefix}:{{literal_value}}:fixture prompt` },
    }],
  };
}

type Staged = Awaited<ReturnType<ArtifactStore["stage"]>>;

let preparedV2: { staged: Staged; fixtures: CapabilityFixtureSuite } | undefined;
let preparedV1: { staged: Staged; fixtures: CapabilityFixtureSuite } | undefined;

function binding(staged: Staged) {
  return {
    artifactId: `${staged.manifest.id}:${staged.manifest.version}`,
    contentDigest: staged.contentDigest,
    manifestDigest: staged.manifestDigest,
    surfaceDigest: staged.surfaceDigest,
  };
}

function reference(staged: Staged): ArtifactReference {
  const value = binding(staged);
  return {
    artifactId: value.artifactId,
    contentDigest: value.contentDigest,
    surfaceDigest: value.surfaceDigest,
  };
}

function key(staged: Staged): string {
  return staged.manifest.version.replaceAll(".", "-");
}

function verification(staged: Staged, fixtures: CapabilityFixtureSuite): VerificationReceipt {
  const id = key(staged);
  return {
    receiptId: `verify-learned-echo-${id}`,
    ...binding(staged),
    sourceRevision: `git:e2e-fixture-${id}`,
    fixtureDigest: capabilityFixtureDigest(fixtures as unknown as JsonValue),
    policyId: "e2e-fixture",
    policyVersion: "1.0.0",
    cwd: process.cwd(),
    startedAt: time,
    endedAt: time,
    verdict: "pass",
    checks: [{ name: "fixture-check", kind: "contract", status: "pass", startedAt: time, endedAt: time }],
    environment: {
      chopinVersion: "0.1.0",
      dshVersion: "0.1.3-alpha.1",
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    durableOutputRef: join(process.cwd(), ".evolution", `fixture-verification-${id}.json`),
    durableOutputHash: contentHash("{}\n"),
  };
}

function approval(staged: Staged): ApprovalReceipt {
  const id = key(staged);
  return {
    receiptId: `approve-learned-echo-${id}`,
    ...binding(staged),
    permissionDigest: capabilityPermissionDigest(staged.manifest),
    capabilityDigest: capabilityProvidesDigest(staged.manifest),
    decision: "allowed-once",
    actor: "e2e-user",
    sessionId: "e2e-seed",
    approvalAuditId: `e2e-approval-${id}`,
    decidedAt: time,
  };
}

function request(staged: Staged, mode: DeploymentMode, rollbackTarget?: ArtifactReference): DeploymentRequest {
  const id = key(staged);
  return {
    requestId: `e2e-request-${id}-${mode}`,
    ...binding(staged),
    mode,
    targetGeneration: `seed-generation-${id}-${mode}`,
    approvalReceiptId: `approve-learned-echo-${id}`,
    requestedAt: time,
    requestedBy: "e2e-user",
    ...(rollbackTarget === undefined ? {} : { rollbackTarget }),
  };
}

function deployment(
  staged: Staged,
  mode: DeploymentMode,
  rollbackTarget?: ArtifactReference,
  endedAt = time,
): DeploymentReceipt {
  const id = key(staged);
  return {
    receiptId: `e2e-deploy-${id}-${mode}`,
    ...binding(staged),
    mode,
    operationId: `e2e-request-${id}-${mode}`,
    processGeneration: `seed-generation-${id}-${mode}`,
    dshVersion: "0.1.3-alpha.1",
    chopinVersion: "0.1.0",
    loadedSurfaceDigest: staged.surfaceDigest,
    health: "pass",
    startedAt: endedAt,
    endedAt,
    ...(rollbackTarget === undefined ? {} : { rollbackTarget }),
  };
}

async function stageVersion(root: string, manifest: CapabilityManifest, prefix: string): Promise<{ staged: Staged; fixtures: CapabilityFixtureSuite }> {
  const source = join(root, `source-${manifest.version}`);
  const fixtures = fixtureSuite(prefix);
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "capability.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(source, "capability.tests.json"), `${JSON.stringify(fixtures, null, 2)}\n`, "utf8");
  await writeFile(join(source, "index.mjs"), [
    `const manifest = ${JSON.stringify(manifest)};`,
    "export default {",
    "  manifest,",
    "  activate(context) {",
    `    context.registerContext({ name: 'version_note', order: 10, render(input) { return '${prefix}:{{literal_value}}:' + input.prompt; } });`,
    "    context.registerTool({",
    "      name: 'learned_echo',",
    "      description: 'Echo one string.',",
    "      inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },",
    "      outputSchema: { type: 'object', additionalProperties: false, required: ['echo'], properties: { echo: { type: 'string' } } },",
    `      async execute(execution) { return { echo: '${prefix}:' + execution.arguments.text }; },`,
    "    });",
    "  },",
    "};",
    "",
  ].join("\n"), "utf8");
  return { staged: await new ArtifactStore(join(root, "artifacts")).stage(source), fixtures };
}

async function appendActiveLifecycle(staged: Staged, fixtures: CapabilityFixtureSuite): Promise<void> {
  const artifactId = binding(staged).artifactId;
  const verified = verification(staged, fixtures);
  await writeFile(verified.durableOutputRef, "{}\n", "utf8");
  await new EvolutionEventStore(join(process.cwd(), ".evolution", "events.jsonl")).appendMany([
    artifactDrafted({ artifactId }, { manifest: staged.manifest, contentDigest: staged.contentDigest }),
    artifactBuilt({ artifactId }, {
      contentDigest: staged.contentDigest,
      manifestDigest: staged.manifestDigest,
      surfaceDigest: staged.surfaceDigest,
      sourceRevision: verified.sourceRevision,
    }),
    artifactVerified({ artifactId }, verified),
    artifactApproved({ artifactId }, approval(staged)),
    artifactDeploymentRequested({ artifactId }, request(staged, "disabled")),
    artifactInstalledDisabled({ artifactId }, deployment(staged, "disabled")),
    artifactDeploymentRequested({ artifactId }, request(staged, "canary")),
    artifactCanaryActivated({ artifactId }, deployment(staged, "canary")),
    artifactDeploymentRequested({ artifactId }, request(staged, "active")),
    artifactActivated({ artifactId }, deployment(staged, "active")),
  ]);
}

export async function seedEvolutionFixture(): Promise<void> {
  const root = join(process.cwd(), ".evolution");
  const v1 = await stageVersion(root, manifestV1, "v1");
  preparedV1 = v1;
  const manifestV2: CapabilityManifest = {
    ...manifestV1,
    version: "2.0.0",
    lineage: {
      ...manifestV1.lineage,
      supersedes: {
        artifactId: binding(v1.staged).artifactId,
        contentDigest: v1.staged.contentDigest,
        surfaceDigest: v1.staged.surfaceDigest,
      },
    },
  };
  preparedV2 = await stageVersion(root, manifestV2, "v2");
  await appendActiveLifecycle(v1.staged, v1.fixtures);
}

export async function activateEvolutionFixtureV2(): Promise<string> {
  if (preparedV2 === undefined) throw new Error("evolution v2 fixture was not prepared");
  await appendActiveLifecycle(preparedV2.staged, preparedV2.fixtures);
  return binding(preparedV2.staged).artifactId;
}

export async function rollbackEvolutionFixtureToV1(): Promise<string> {
  if (preparedV1 === undefined || preparedV2 === undefined) throw new Error("evolution rollback fixtures were not prepared");
  const v1 = preparedV1.staged;
  const v2 = preparedV2.staged;
  const v1Ref = reference(v1);
  const v2Id = binding(v2).artifactId;
  const base = Date.now();
  const at = (offset: number) => new Date(base + offset).toISOString();
  const rollbackRequest = {
    ...request(v2, "rollback", v1Ref),
    requestedAt: at(2),
  };
  const rollbackReceipt = {
    ...deployment(v2, "rollback", v1Ref, at(3)),
    operationId: rollbackRequest.requestId,
    loadedSurfaceDigest: v1Ref.surfaceDigest,
  };
  await new EvolutionEventStore(join(process.cwd(), ".evolution", "events.jsonl")).appendMany([
    artifactRetired({ artifactId: v1Ref.artifactId, occurredAt: at(0) }, "superseded by v2"),
    artifactQuarantined({ artifactId: v2Id, occurredAt: at(1) }, "fixture requests rollback"),
    artifactDeploymentRequested({ artifactId: v2Id, occurredAt: at(2) }, rollbackRequest),
    artifactRolledBack({ artifactId: v2Id, occurredAt: at(3) }, rollbackReceipt),
  ]);
  return v1Ref.artifactId;
}
