import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
async function run(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (code !== 0) throw new Error(`the storage check failed: ${code}`);
}
await run(process.execPath, ["scripts/build-storage.mjs", "--debug"]);
await run("pnpm", ["exec", "vitest", "run", "packages/harness-pi/tests/encrypted-store.spec.ts"], { ...process.env, CHOPIN_TEST_NATIVE_MODULE: join(root, "packages/harness-pi/native/chopin-storage.node") });
