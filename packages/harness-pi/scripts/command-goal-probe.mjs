import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ToolResultEntry } from "@earendil-works/pi-durable";
import { openEncryptedStore } from "../dist/index.js";
import { ControlHost } from "../../../apps/tui/dist/control.js";
import { openCloudRuntime } from "../../../apps/tui/dist/cloud.js";
import { Vault } from "../../../apps/tui/dist/vault.js";

function required(name) { const value = process.env[name]; if (value === undefined || value === "") throw new Error(`${name} is required`); return value; }
const identity = { agentId: required("CHOPIN_AGENT_ID"), epoch: Number(required("CHOPIN_RUNTIME_EPOCH")), owner: required("CHOPIN_ENGINE_OWNER") };
const root = required("CHOPIN_TEST_STORAGE_DIR");
const base = required("CHOPIN_CONTROL_URL");
const mode = process.argv[2];
const key = mode === undefined ? Buffer.from(required("CHOPIN_TEST_STORE_KEY"), "base64url") : undefined;
const control = await ControlHost.connect({ url: base, ...identity }, required("CHOPIN_CONTROL_TOKEN"));
const volume = join(root, "volume"); const home = join(root, "home");
const store = { dir: join(volume, "store"), key, anchor: control.anchors(), queueCapacity: 1, nativeModule: required("CHOPIN_STORAGE_NATIVE") };

if (mode !== undefined) {
  const policy = JSON.parse(required("CHOPIN_TEST_COMMAND_POLICY"));
  const envelope = { version: 1, requestId: required("CHOPIN_TEST_GOAL_REQUEST"), command: { kind: "goal.submit", objective: "Recover the original command goal", completionCriteria: ["The original command result is committed exactly once"], grant: JSON.parse(required("CHOPIN_TEST_GOAL_GRANT")) } };
  const provider = fauxProvider(); const models = createModels(); models.setProvider(provider.provider); const model = provider.getModel();
  const errors = [];
  const outputPages = [];
  const readNext = (request) => {
    const message = request.messages.findLast((message) => message.role === "toolResult");
    assert.ok(message && !message.isError);
    const diagnostic = message.content.find((part) => part.type === "text" && part.text.startsWith("<harness>"));
    assert.ok(diagnostic);
    const line = diagnostic.text.split("\n").find((line) => line.startsWith("[info] {"));
    assert.ok(line);
    const metadata = JSON.parse(line.slice("[info] ".length));
    if (message.toolName === "command_output") {
      assert.equal(message.content[0].type, "text"); outputPages.push(Buffer.from(JSON.parse(message.content[0].text), "base64url"));
      if (metadata.complete) { assert.deepEqual(Buffer.concat(outputPages), Buffer.from(required("CHOPIN_TEST_JOB_OUTPUT"), "base64url")); return fauxAssistantMessage("Original command output read"); }
    } else assert.equal(message.toolName, "command");
    provider.appendResponses([readNext]);
    return fauxAssistantMessage(fauxToolCall("command_output", { operationId: metadata.operationId, ...(message.toolName === "command_output" && { cursor: metadata.cursor }), encoding: "base64url" }), { stopReason: "toolUse" });
  };
  const runtime = await openCloudRuntime({
    version: 1, purpose: "execution", keySource: "custody", volume, home, control: { url: base, ...identity },
    jobs: { transport: { url: required("CHOPIN_TEST_JOB_URL"), scopeId: identity.agentId }, domain: required("CHOPIN_TEST_JOB_DOMAIN"), cwd: "/workspace", policyRevision: mode === "recover" ? "replacement" : "fixture", inheritEnv: false, policy },
    storage: { queueCapacity: 1, nativeModule: required("CHOPIN_STORAGE_NATIVE") },
    server: { port: 0 }, model: { provider: model.provider, modelId: model.id }, reviewModel: { provider: model.provider, modelId: model.id },
    goalRetryAfterMs: policy.pollAfterMs, vaultSyncMs: Number(required("CHOPIN_TEST_VAULT_SYNC_MS")),
  }, { controlToken: required("CHOPIN_CONTROL_TOKEN"), jobToken: required("CHOPIN_TEST_JOB_CREDENTIAL"), launchToken: "synthetic-launch-credential" }, {
    models: async () => models, report: (error) => errors.push(error),
    review: async (input) => {
        let tool; let cursor;
        do {
          const page = await input.entries(policy.scanPageSize, cursor);
          tool = page.items.find((entry) => entry.kind === ToolResultEntry.kind && entry.model.some((message) => message.role === "toolResult" && message.toolName === "command")); cursor = page.next;
        } while (tool === undefined && cursor !== undefined);
        if (tool === undefined) throw new Error("the original command has no committed result");
        const expected = Buffer.from(required("CHOPIN_TEST_JOB_OUTPUT"), "base64url").toString("utf8");
        assert.ok(tool.model.some((message) => message.role === "toolResult" && !message.isError && message.content.some((content) => content.type === "text" && content.text === expected)));
        return { kind: "complete", summary: "Original command output verified", evidence: [{ kind: "tool", criterion: 0, entryId: Number(tool.id) }] };
    },
  });
  const service = runtime.service;
  try {
    const goals = await service.goals(identity.owner);
    assert.deepEqual((await service.loaded(identity.owner, context)).projectInstructions, []);
    await assert.rejects(service.shell(identity.owner, "exit 0", async () => {}, context), { code: "workspace_unavailable" });
    assert.equal(await service.setMcpServer(identity.owner, "untrusted", base, {}), "this service takes MCP servers from its trusted configuration");
    assert.deepEqual(await service.mcpServers(identity.owner), []);
    let receipt;
    if (mode === "submit") {
      provider.setResponses([fauxAssistantMessage(fauxToolCall("command", { argv: JSON.parse(required("CHOPIN_TEST_JOB_ARGV")) }, { id: "original-command-call" }), { stopReason: "toolUse" }), readNext]);
      receipt = await service.executeGoal(identity.owner, envelope, context);
    } else {
      assert.equal(mode, "recover");
      provider.setResponses([readNext]);
      receipt = await goals.request(envelope.requestId, context);
      assert.ok(receipt);
      assert.notEqual((await goals.snapshot(receipt.goalId, context)).status, "completed");
      await goals.resume(context);
    }
    await goals.store.harness.waitForTask(await goals.store.driverId(receipt.goalId, context), context);
    const goal = await goals.snapshot(receipt.goalId, context);
    assert.equal(goal.status, "completed", errors.map(String).join("; "));
    assert.equal(goal.goalId, envelope.requestId);
    assert.deepEqual(await goals.execute(envelope, undefined, context), receipt);
    assert.deepEqual(errors, []);
    assert.equal(process.env.CHOPIN_TEST_STORE_KEY, undefined);
    assert.ok(outputPages.length > 0);
    process.stdout.write(JSON.stringify({ originalGoal: true, committedToolOutput: true, originalRequest: true, reusedIntent: mode === "recover", custodyUnlock: true, completeOutputRead: true, completed: true }));
  } finally { await runtime.close(); await control.close(); }
} else {
  await mkdir(root, { mode: 0o700 });
  await mkdir(volume, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  // Test preparation supplies a new protected store; the execution children can only reopen it.
  const vault = await Vault.initialize(volume, home, key, async () => {});
  const protectedStore = vault.store;
  try { const seeded = await openEncryptedStore({ ...store, ...protectedStore, create: true }); await seeded.close(context); }
  finally { protectedStore.key.fill(0); await vault.close(); }
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  let failure;
  const proxy = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const observed = await fetch(new URL(request.url, required("CHOPIN_TEST_JOB_URL")), { method: request.method, redirect: "error", headers: { authorization: request.headers.authorization, "content-type": "application/json" }, ...(chunks.length > 0 && { body: Buffer.concat(chunks) }) });
      const bytes = Buffer.from(await observed.arrayBuffer());
      if (request.method === "PUT") {
        assert.equal(observed.status, 200); assert.equal(JSON.parse(bytes.toString()).scopeId, identity.agentId);
        entered.resolve(); await release.promise; response.destroy();
      } else { response.writeHead(observed.status, { "content-type": "application/json" }); response.end(bytes); }
    } catch (error) { failure = error; entered.reject(error); response.destroy(); }
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  function launch(mode, url) {
    const env = { ...process.env, CHOPIN_TEST_JOB_URL: url }; delete env.CHOPIN_TEST_STORE_KEY;
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const result = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })); });
    return { child, result };
  }
  const pending = launch("submit", `http://127.0.0.1:${proxy.address().port}/commands/`);
  const input = createInterface({ input: process.stdin });
  try {
    await Promise.race([entered.promise, pending.result.then((result) => { throw new Error(`goal process exited before acceptance: ${result.stderr}`); })]);
    pending.child.kill("SIGKILL"); assert.equal((await pending.result).signal, "SIGKILL"); release.resolve();
    const resume = once(input, "line"); process.stdout.write("interrupted\n"); assert.deepEqual(await resume, ["resume"]);
    const recovered = await launch("recover", required("CHOPIN_TEST_JOB_URL")).result;
    assert.equal(recovered.code, 0, recovered.stderr);
    if (failure !== undefined) throw failure;
    const bytes = await readFile(join(store.dir, "execution.sqlite"));
    const anchor = await control.anchors().read();
    process.stdout.write(JSON.stringify({ interrupted: true, encrypted: !bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")), anchored: anchor.head.sequence > 0 && anchor.pending === null, ...JSON.parse(recovered.stdout) }) + "\n");
  } finally {
    release.resolve(); input.close();
    if (pending.child.exitCode === null && pending.child.signalCode === null) pending.child.kill("SIGKILL");
    await pending.result;
    proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve));
    await control.close(); key.fill(0);
  }
}
