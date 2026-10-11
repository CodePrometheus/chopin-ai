/**
 * A real chopin profile in a temporary DSH_HOME, prepared by the installer's rules minus the
 * third-party shared plugins, for probes that must run inside the whole composition. The
 * real DSH_HOME is never touched.
 *
 * @module scripts/real-profile
 */

import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PROFILE = "chopin-tui";
const run = promisify(execFile);

/** Prepare and install a profile; `step` runs one launcher command and fails the process with its log on error. */
export async function prepareProfile(prefix, profile = PROFILE) {
  try {
    await access(join(repoRoot, "apps/cli/dist/installation.js"));
  } catch {
    console.error("real profile: apps/cli is not built; run `pnpm build` first");
    process.exit(1);
  }
  const { SHARED_BUNDLES } = await import(join(repoRoot, "apps/cli/dist/installation.js"));
  const { dshBin } = await import(join(repoRoot, "apps/cli/dist/environment.js"));
  const home = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const log = join(home, "run.log");
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1" };
  const step = async (label, args, options = {}) => {
    try {
      const { stdout, stderr } = await run(process.execPath, args, { env, maxBuffer: 64 * 1024 * 1024, ...options });
      await writeFile(log, `## ${label}\n${stdout}\n${stderr}\n`, { flag: "a" });
    } catch (error) {
      await writeFile(log, `## ${label} (failed)\n${error.stdout ?? ""}\n${error.stderr ?? ""}\n`, { flag: "a" });
      console.error(`${label} failed: ${error.message.split("\n")[0]}\n       log: ${log}`);
      process.exit(1);
    }
  };

  await step("prepare profile", [join(repoRoot, "apps/cli/dist/main.js"), "install", "--prepare-only"]);
  const manifestPath = join(home, "profiles", profile, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const { name } of SHARED_BUNDLES) delete manifest.dependencies[name];
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((bundle) => !SHARED_BUNDLES.some((shared) => shared.name === bundle));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const dsh = await dshBin();
  await step("install profile", [dsh, "plugin", "--profile", profile, "install"], { env: { ...env, npm_config_ignore_scripts: "true" } });
  return { home, workspace, env, log, dsh, manifestPath, step };
}
