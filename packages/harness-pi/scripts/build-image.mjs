// Builds the workspace image with the execution daemon of the exact version this package depends on.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    tag: { type: "string", default: "chopin-ai-workspace:local" },
    arch: { type: "string", default: process.arch },
  },
});
const arch = { arm64: "arm64", x64: "x64", amd64: "x64" }[values.arch];
if (arch === undefined) throw new Error(`unsupported architecture: ${values.arch}`);

// The package exports only its entry point, `dist/index.js`; the daemons ship next to `dist/`.
const daemonRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-env"))));
const daemon = join(daemonRoot, "bin", `pi-env-linux-${arch}`);
// The listener the socket workspace connects to ships with that package, beside its `dist/`.
const workspace = dirname(dirname(fileURLToPath(import.meta.resolve("@chopin-ai/workspace"))));
const image = join(dirname(fileURLToPath(import.meta.url)), "..", "image");

execFileSync("docker", [
  "build", "--platform", `linux/${arch === "x64" ? "amd64" : "arm64"}`,
  "--build-context", `daemon=${daemon}`, "--build-context", `workspace=${workspace}`, "--tag", values.tag, image,
], { stdio: "inherit" });
