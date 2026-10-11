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

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { collectGatedTools, collectRows, parseComposition, presetDeclarations, submissionTools } from "./composition-rules.mjs";
import { PROFILE, prepareProfile, repoRoot } from "./real-profile.mjs";

const BOOT_TIMEOUT_MS = 180_000;
const { home, workspace, env, log, dsh, step } = await prepareProfile("chopin-smoke-");

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
