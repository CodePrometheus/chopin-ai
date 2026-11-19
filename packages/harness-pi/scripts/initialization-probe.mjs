import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

function required(name) { const value = process.env[name]; if (value === undefined || value === "") throw new Error(`${name} is required`); return value; }
const volume = required("CHOPIN_TEST_STORAGE_DIR");
const home = `${volume}-home`;
const base = required("CHOPIN_CONTROL_URL");
const identity = { agentId: required("CHOPIN_AGENT_ID"), epoch: Number(required("CHOPIN_RUNTIME_EPOCH")), owner: "local" };
const operationId = required("CHOPIN_TEST_INITIALIZATION_OPERATION_ID");
const scenario = process.env.CHOPIN_TEST_INITIALIZATION_SCENARIO ?? "reconcile";
const entered = Promise.withResolvers();
const released = Promise.withResolvers();
const keys = [];
const genesis = [];
let tripped = false;
let proxyFailure;
const proxy = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const path = request.url;
    if (path.endsWith("/anchor/init")) genesis.push(JSON.parse(body.toString()).head);
    const interrupt = !tripped && ((scenario === "genesis-interrupted" && path.endsWith("/anchor/init")) || (scenario === "completion-interrupted" && path.endsWith("/initialization/complete")));
    if (interrupt) {
      tripped = true; entered.resolve();
      await released.promise; response.destroy(); return;
    }
    const result = await fetch(new URL(path, base), { method: "POST", redirect: "error", headers: { authorization: request.headers.authorization, "content-type": "application/json" }, body });
    const bytes = Buffer.from(await result.arrayBuffer());
    if (result.ok && path.endsWith("/initialization/key")) keys.push(JSON.parse(bytes.toString()).serviceKey);
    const lose = !tripped && ((scenario === "key-response-lost" && path.endsWith("/initialization/key")) || (scenario === "completion-response-lost" && path.endsWith("/initialization/complete")));
    if (lose && result.ok) { tripped = true; response.destroy(); return; }
    response.writeHead(result.status, { "content-type": "application/json" }); response.end(bytes);
  } catch (error) { proxyFailure = error; response.destroy(); }
});
proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
const endpoint = `http://127.0.0.1:${proxy.address().port}/`;
await mkdir(home, { mode: 0o700 });
const configuration = `${volume}-configuration.json`;
await writeFile(configuration, JSON.stringify({ version: 1, volume, home, operationId, control: { url: endpoint, ...identity }, storage: { queueCapacity: 1, nativeModule: required("CHOPIN_STORAGE_NATIVE") } }), { mode: 0o600 });
function launch() {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../../apps/tui/dist/bin.js", import.meta.url)), "initialize", "--config", configuration], { env: { ...process.env, CHOPIN_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const result = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })); });
  return { child, result };
}
async function initialize() {
  const result = await launch().result;
  if (result.code !== 0) throw new Error(`the actual initializer command failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
try {
  if (scenario !== "reconcile") {
    const attempt = launch();
    if (scenario.endsWith("-interrupted")) {
      await Promise.race([entered.promise, attempt.result.then((result) => { throw new Error(`initializer exited before the requested phase: ${result.stderr}`); })]);
      attempt.child.kill("SIGKILL");
      const stopped = await attempt.result;
      if (stopped.signal !== "SIGKILL") throw new Error("the original initializer was not actually killed");
      released.resolve();
    } else {
      const failed = await attempt.result;
      if (failed.code === 0 || failed.stdout !== "" || !tripped) throw new Error("the lost response did not prevent a success receipt");
    }
  }
  const first = await initialize();
  const marker = await readFile(join(volume, "key-check"));
  const receipt = await initialize();
  const bytes = await readFile(join(volume, "store", "execution.sqlite"));
  if (proxyFailure !== undefined) throw proxyFailure;
  const stableGenesis = genesis.every((head) => isDeepStrictEqual(head, genesis[0]));
  process.stdout.write(JSON.stringify({
    initialized: first.confirmedHead.sequence > 0,
    reconciled: isDeepStrictEqual(first, receipt) && marker.equals(await readFile(join(volume, "key-check"))) && stableGenesis,
    encrypted: !bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")),
    noProjectStarted: (await readdir(home, { recursive: true })).length === 0,
    keyConsistent: keys.length >= 2 && keys.every((key) => key === keys[0]),
    faultObserved: tripped,
    receipt,
  }));
} finally {
  released.resolve();
  proxy.closeAllConnections();
  await new Promise((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
}
