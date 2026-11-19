import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { JobClient } from "../../../apps/tui/dist/jobs.js";

function required(name) { const value = process.env[name]; if (value === undefined || value === "") throw new Error(`${name} is required`); return value; }
const operation = required("CHOPIN_TEST_JOB_OPERATION");
const request = JSON.parse(required("CHOPIN_TEST_JOB_REQUEST"));
const credential = required("CHOPIN_TEST_JOB_CREDENTIAL");
const configuration = { url: required("CHOPIN_TEST_JOB_URL"), scopeId: required("CHOPIN_TEST_JOB_SCOPE") };
const mode = process.argv[2];

if (mode !== undefined) {
  const client = await JobClient.connect(configuration, credential);
  try {
    if (mode === "submit") {
      await client.submit(operation, request);
      throw new Error("the original submit unexpectedly received its response before interruption");
    }
    assert.equal(mode, "recover");
    const original = await client.get(operation);
    assert.equal(original?.state.phase, "drained");
    assert.deepEqual(original.state.primaryExit, { kind: "code", value: 23 });
    assert.equal(original.state.outputComplete, true);
    const limit = Number(required("CHOPIN_TEST_JOB_PAGE_BYTES"));
    const chunks = [];
    let cursor;
    do {
      const page = await client.output(operation, limit, cursor);
      chunks.push(Buffer.from(page.data, "base64url"));
      assert.notEqual(page.cursor, cursor);
      cursor = page.cursor;
      if (page.complete) break;
    } while (true);
    assert.deepEqual(Buffer.concat(chunks), Buffer.from(required("CHOPIN_TEST_JOB_OUTPUT"), "base64url"));
    assert.ok(chunks.length > 1);
    await assert.rejects(client.submit(randomUUID(), request), { status: 403 });
    assert.deepEqual(await client.reconcile(operation), original);
    const stopped = await client.stop(operation);
    assert.equal(stopped.state.stopRequested, true);
    process.stdout.write(JSON.stringify({ originalOperation: true, binaryOutput: true, revokedNewWork: true, drained: true }));
  } finally { await client.close(); }
} else {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let failed;
  const proxy = createServer(async (incoming, response) => {
    try {
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const observed = await fetch(new URL(incoming.url, configuration.url), {
        method: incoming.method, redirect: "error", headers: { authorization: incoming.headers.authorization, "content-type": "application/json" },
        ...(chunks.length > 0 && { body: Buffer.concat(chunks) }),
      });
      const bytes = Buffer.from(await observed.arrayBuffer());
      assert.equal(observed.status, 200);
      assert.equal(incoming.method, "PUT");
      assert.equal(JSON.parse(bytes.toString()).operationId, operation);
      entered.resolve(); await release.promise; response.destroy();
    } catch (error) { failed = error; entered.reject(error); response.destroy(); }
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  function launch(mode, url) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode], { env: { ...process.env, CHOPIN_TEST_JOB_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const result = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })); });
    return { child, result };
  }
  const pending = launch("submit", `http://127.0.0.1:${proxy.address().port}/commands/`);
  const input = createInterface({ input: process.stdin });
  try {
    await Promise.race([entered.promise, pending.result.then((result) => { throw new Error(`submit exited before the interruption: ${result.stderr}`); })]);
    pending.child.kill("SIGKILL");
    assert.equal((await pending.result).signal, "SIGKILL");
    release.resolve();
    const resume = once(input, "line");
    process.stdout.write("interrupted\n");
    assert.deepEqual(await resume, ["resume"]);
    const result = await launch("recover", configuration.url).result;
    assert.equal(result.code, 0, result.stderr);
    if (failed !== undefined) throw failed;
    process.stdout.write(JSON.stringify({ interrupted: true, ...JSON.parse(result.stdout) }) + "\n");
  } finally {
    release.resolve(); input.close();
    if (pending.child.exitCode === null && pending.child.signalCode === null) pending.child.kill("SIGKILL");
    await pending.result;
    proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve));
  }
}
