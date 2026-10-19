// Builds the dsh workspace image with this adapter, at the dsh version the adapter declares, from local packages.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { tag: { type: "string", default: "chopin-ai-dsh-workspace:local" } } });
const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));
const dsh = manifest.peerDependencies["@deepseek-ai/dsh-tools"];

const packages = await mkdtemp(join(tmpdir(), "chopin-dsh-image-"));
try {
  for (const name of ["core", "workspace", "harness-dsh"]) {
    const output = execFileSync("pnpm", ["--filter", `@chopin-ai/${name}`, "pack", "--pack-destination", packages, "--json"], { encoding: "utf8" });
    await rename(JSON.parse(output).filename, join(packages, `chopin-ai-${name}.tgz`));
  }
  execFileSync("docker", [
    "build", "--build-arg", `DSH_VERSION=${dsh}`, "--build-context", `packages=${packages}`,
    "--tag", values.tag, join(here, "..", "image"),
  ], { stdio: "inherit" });
} finally {
  await rm(packages, { recursive: true, force: true });
}
