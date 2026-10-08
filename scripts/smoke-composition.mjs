#!/usr/bin/env node
/**
 * Smoke mount: does chopin's whole composition mount in the real launcher.
 *
 * Prepares the terminal profile in a temporary DSH_HOME by the installer's rules (minus the
 * third-party shared plugins), starts it with the dsh launcher plus smoke-overlay.yml: the
 * UI is turned off, a probe creates an agent from the chopin preset and checks that every
 * gated tool and every submit tool is visible to it. No model requests; the real DSH_HOME is untouched.
 *
 * The evolve submit gate's trial-run accepts nothing else: a plugin that was never mounted is a guess about the runtime.
 */

import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { collectGatedTools, collectRows, parseComposition, presetDeclarations, submissionTools } from "./composition-rules.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);
const PROFILE = "chopin-tui";
const BOOT_TIMEOUT_MS = 180_000;

try {
  await access(join(repoRoot, "apps/cli/dist/installation.js"));
} catch {
  console.error("smoke: apps/cli is not built; run `pnpm build` first");
  process.exit(1);
}
const { SHARED_BUNDLES } = await import(join(repoRoot, "apps/cli/dist/installation.js"));
const { dshBin } = await import(join(repoRoot, "apps/cli/dist/environment.js"));

const home = await mkdtemp(join(tmpdir(), "chopin-smoke-"));
const workspace = join(home, "workspace");
await mkdir(workspace);
const log = join(home, "smoke.log");
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1" };

async function step(label, args, options = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, args, { env, maxBuffer: 64 * 1024 * 1024, ...options });
    await writeFile(log, `## ${label}\n${stdout}\n${stderr}\n`, { flag: "a" });
  } catch (error) {
    await writeFile(log, `## ${label} (failed)\n${error.stdout ?? ""}\n${error.stderr ?? ""}\n`, { flag: "a" });
    console.error(`smoke: ${label} failed: ${error.message.split("\n")[0]}\n       log: ${log}`);
    process.exit(1);
  }
}

await step("prepare profile", [join(repoRoot, "apps/cli/dist/main.js"), "install", "--prepare-only"]);
const manifestPath = join(home, "profiles", PROFILE, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
for (const { name } of SHARED_BUNDLES) delete manifest.dependencies[name];
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((bundle) => !SHARED_BUNDLES.some((shared) => shared.name === bundle));
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const dsh = await dshBin();
await step("install profile", [dsh, "plugin", "--profile", PROFILE, "install"], { env: { ...env, npm_config_ignore_scripts: "true" } });

const bundleDir = join(repoRoot, "packages/bundle");
const bundleManifest = JSON.parse(await readFile(join(bundleDir, "package.json"), "utf8"));
const expected = new Set();
for (const file of [bundleManifest.dsh.bundle.patch].flat()) {
  for (const preset of presetDeclarations(parseComposition(await readFile(join(bundleDir, file), "utf8")))) {
    for (const tool of collectGatedTools(preset.plugins)) expected.add(tool);
    for (const tool of submissionTools(collectRows(preset.plugins))) expected.add(tool);
  }
}

const result = join(home, "result.json");
await step("boot", [dsh, "--profile", PROFILE, "--patch", join(repoRoot, "scripts/smoke-overlay.yml")], {
  cwd: workspace,
  timeout: BOOT_TIMEOUT_MS,
  env: { ...env, CHOPIN_SMOKE_RESULT: result, CHOPIN_SMOKE_EXPECT_TOOLS: JSON.stringify([...expected].sort()) },
});

let outcome;
try {
  outcome = JSON.parse(await readFile(result, "utf8"));
} catch {
  console.error(`smoke: the probe reported nothing; the composition did not finish mounting\n       log: ${log}`);
  process.exit(1);
}
if (!outcome.ok) {
  console.error(`smoke: FAIL preset ${outcome.preset ?? "?"}`);
  if (outcome.broken) console.error(`       broken: ${outcome.broken}`);
  if (outcome.missing?.length) console.error(`       tools not visible to the agent: ${outcome.missing.join(", ")}`);
  if (outcome.error) console.error(`       ${outcome.error}`);
  console.error(`       log: ${log}`);
  process.exit(1);
}
console.log(`smoke ok: preset ${outcome.preset} mounted in a real profile; ${outcome.checked} gated or submission tool(s) visible`);
// On failure the temp directory is left for log inspection; on success it is removed.
await rm(home, { recursive: true, force: true });
