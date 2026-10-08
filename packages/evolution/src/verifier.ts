import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { assertCapabilityFixtureSuite, assertFixtureCoverage, capabilityFixtureDigest } from "./fixtures.js";
import { artifactVersionId } from "./manifest.js";
import { assertVerificationReceipt } from "./receipts.js";
import type { ArtifactStore, StagedArtifact } from "./artifact-store.js";
import type { JsonValue, VerificationCheck, VerificationReceipt } from "./types.js";

const executeFile = promisify(execFile);
const SENSITIVE_NAMES = new Set([
  ".env", ".npmrc", ".pypirc", ".netrc", ".git-credentials", "credentials.json", "secrets.json", "secrets.yaml",
]);
const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const CAPABILITY_FIXTURE_FILE = "capability.tests.json";

export interface StaticVerificationOptions {
  sourceRevision: string;
  receiptsDir: string;
  chopinVersion: string;
  dshVersion: string;
}

interface CheckResult {
  status: VerificationCheck["status"];
  detail?: string;
  command?: string[];
  exitCode?: number;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function runCheck(
  name: string,
  kind: VerificationCheck["kind"],
  operation: () => CheckResult | Promise<CheckResult>,
): Promise<VerificationCheck> {
  const startedAt = new Date().toISOString();
  try {
    const result = await operation();
    return { name, kind, startedAt, endedAt: new Date().toISOString(), ...result };
  } catch (error) {
    return { name, kind, status: "fail", startedAt, endedAt: new Date().toISOString(), detail: (error as Error).message };
  }
}

function surfaceCheck(staged: StagedArtifact): CheckResult {
  const provides = staged.manifest.provides;
  const counts = {
    memory: provides.contexts.length,
    skill: provides.skills.length,
    gate: provides.guards.length,
    tool: provides.tools.length,
    plugin: provides.tools.length + provides.guards.length + provides.services.length + provides.workflows.length,
  };
  if (counts[staged.manifest.kind] === 0) throw new Error(`${staged.manifest.kind} manifest declares no matching capability surface`);
  if ((staged.manifest.kind === "memory" || staged.manifest.kind === "skill") && staged.manifest.permissions.length > 0) {
    throw new Error(`${staged.manifest.kind} cannot request executable permissions`);
  }
  return { status: "pass", detail: `${staged.manifest.kind} surface is internally consistent` };
}

async function contentCheck(staged: StagedArtifact): Promise<CheckResult> {
  let totalBytes = 0;
  for (const file of staged.files) {
    const name = basename(file).toLowerCase();
    if (SENSITIVE_NAMES.has(name) || SENSITIVE_EXTENSIONS.has(extname(name))) throw new Error(`sensitive-shaped file is not allowed: ${file}`);
    totalBytes += (await stat(join(staged.path, file))).size;
  }
  if (totalBytes > MAX_ARTIFACT_BYTES) throw new Error(`artifact is ${totalBytes} bytes; limit is ${MAX_ARTIFACT_BYTES}`);
  const entry = await readFile(join(staged.path, staged.manifest.entry), "utf8");
  if (entry.trim() === "" || entry.includes("\uFFFD")) throw new Error("entry must be non-empty valid UTF-8 text");
  return { status: "pass", detail: `${staged.files.length} file(s), ${totalBytes} byte(s)` };
}

async function syntaxCheck(staged: StagedArtifact): Promise<CheckResult> {
  if (staged.manifest.runtime === "data") return { status: "skipped", detail: "data capability has no executable syntax" };
  const entry = join(staged.path, staged.manifest.entry);
  if (![".js", ".mjs", ".cjs"].includes(extname(entry))) throw new Error("executable entry must be built JavaScript (.js/.mjs/.cjs)");
  const command = [process.execPath, "--check", entry];
  try {
    await executeFile(command[0] as string, command.slice(1), { cwd: staged.path, timeout: 10_000, env: {} });
    return { status: "pass", command, exitCode: 0 };
  } catch (error) {
    const failure = error as Error & { code?: number };
    return { status: "fail", command, exitCode: typeof failure.code === "number" ? failure.code : 1, detail: failure.message };
  }
}

async function fixtureContract(staged: StagedArtifact): Promise<{ digest: string; check: CheckResult }> {
  if (staged.manifest.runtime === "data") {
    const value = {
      kind: staged.manifest.kind,
      entry: staged.manifest.entry,
      trigger: staged.manifest.trigger,
      provides: staged.manifest.provides,
    } as unknown as JsonValue;
    return {
      digest: capabilityFixtureDigest(value),
      check: { status: "pass", detail: "data capability contract is derived from its exact manifest and entry" },
    };
  }
  let content: string;
  try {
    content = await readFile(join(staged.path, CAPABILITY_FIXTURE_FILE), "utf8");
  } catch {
    return {
      digest: sha256(`missing:${CAPABILITY_FIXTURE_FILE}`),
      check: { status: "fail", detail: `executable capability requires ${CAPABILITY_FIXTURE_FILE}` },
    };
  }
  const digest = sha256(content);
  try {
    const parsed: unknown = JSON.parse(content);
    assertCapabilityFixtureSuite(parsed);
    assertFixtureCoverage(parsed, staged.manifest);
    return {
      digest: capabilityFixtureDigest(parsed as unknown as JsonValue),
      check: { status: "pass", detail: `${parsed.cases.length} exact behavior fixture case(s)` },
    };
  } catch (error) {
    return { digest, check: { status: "fail", detail: (error as Error).message } };
  }
}

/** Static verification that does not execute candidate logic; real behavioral verification belongs to the post-approval canary. */
export async function verifyStagedArtifact(
  store: ArtifactStore,
  contentDigest: string,
  options: StaticVerificationOptions,
): Promise<VerificationReceipt> {
  const startedAt = new Date().toISOString();
  const staged = await store.inspect(contentDigest);
  const fixture = await fixtureContract(staged);
  const checks = await Promise.all([
    runCheck("manifest-schema", "schema", () => ({ status: "pass", detail: "manifest and content digest validated" })),
    runCheck("runtime-content", "content", () => contentCheck(staged)),
    runCheck("capability-surface", "contract", () => surfaceCheck(staged)),
    runCheck("entry-syntax", "syntax", () => syntaxCheck(staged)),
    runCheck("fixture-contract", "contract", () => fixture.check),
    runCheck("behavioral-canary", "e2e", () => ({ status: "skipped", detail: "runs only after exact-digest approval in canary" })),
  ]);
  const verdict: VerificationReceipt["verdict"] = checks.some((check) => check.status === "fail") ? "fail" : "pass";
  const receiptId = `verify-${randomUUID()}`;
  const details = {
    receiptId,
    artifactId: artifactVersionId(staged.manifest),
    contentDigest,
    manifestDigest: staged.manifestDigest,
    surfaceDigest: staged.surfaceDigest,
    checks,
  };
  await mkdir(options.receiptsDir, { recursive: true });
  const durableOutputRef = join(options.receiptsDir, `${receiptId}.json`);
  const durableContent = `${JSON.stringify(details, null, 2)}\n`;
  await writeFile(durableOutputRef, durableContent, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const receipt: VerificationReceipt = {
    ...details,
    sourceRevision: options.sourceRevision,
    fixtureDigest: fixture.digest,
    policyId: "chopin-static-artifact",
    policyVersion: "1.1.0",
    cwd: staged.path,
    startedAt,
    endedAt: new Date().toISOString(),
    verdict,
    environment: {
      chopinVersion: options.chopinVersion,
      dshVersion: options.dshVersion,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    durableOutputRef,
    durableOutputHash: sha256(durableContent),
  };
  assertVerificationReceipt(receipt);
  return receipt;
}
