import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { RecoveryAnchor } from "@chopin-ai/harness-pi";
import { CALL_TIMEOUT_MS, Conversations, Credentials, Goal, Goals, connect, subscribe, type EngineCommand, type GoalSnapshot } from "@chopin-ai/harness-pi/protocol";
import { expect, it } from "vitest";
import type { CloudConfiguration } from "../src/cloud.js";
import { Vault } from "../src/vault.js";

const nativeModule = process.env.CHOPIN_TEST_NATIVE_MODULE;
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

type RestartMode = "replacement" | "supervised" | "revoked" | "changed-config" | "personal";
type SupervisorEvent = {
  source: "cloud-supervisor";
  event: "started" | "exited" | "restored";
  pid: number;
  attempt: number;
  at: string;
  elapsedMs: number;
  port?: number;
  code?: number | null;
  signal?: string | null;
  requested?: boolean;
};

const restart = it.skipIf(nativeModule === undefined);
const withShutdown = { timeout: 6 * CALL_TIMEOUT_MS };
const withStartupRefusal = { timeout: 4 * CALL_TIMEOUT_MS };
restart("reconnects to the original encrypted goal after a cloud CLI process is killed", withShutdown,
  ({ onTestFinished }) => verifyRestart("replacement", onTestFinished));
restart("automatically restores the same cloud allocation and exits cleanly when the supervisor is stopped", withShutdown,
  ({ onTestFinished }) => verifyRestart("supervised", onTestFinished));
restart("ends the supervised allocation when renewed custody is denied", withStartupRefusal,
  ({ onTestFinished }) => verifyRestart("revoked", onTestFinished));
restart("rejects replacement configuration before requesting custody", withStartupRefusal,
  ({ onTestFinished }) => verifyRestart("changed-config", onTestFinished));
restart("keeps owner's model calls and private review on sealed personal keys across lost processes", { timeout: 12 * CALL_TIMEOUT_MS },
  ({ onTestFinished }) => verifyRestart("personal", onTestFinished));

function withinCall<T>(work: Promise<T>, description: string): Promise<T> {
  return Promise.race([work, once(AbortSignal.timeout(CALL_TIMEOUT_MS), "abort").then(() => {
    throw new Error(`timed out waiting for ${description}`);
  })]);
}

type Change = { kind: "set"; provider: string; key: string } | { kind: "remove"; provider: string };

function modelFixture() {
  const keys = {
    environment: randomUUID(), configured: randomUUID(), initial: randomUUID(),
    replacement: randomUUID(), rejected: randomUUID(),
  };
  const execution = { provider: "openai", modelId: "worker" };
  const review = { provider: "openai", modelId: "reviewer" };
  const calls: { model: string; authorization: string | undefined }[] = [];
  const claims: string[] = [];
  const pending = new Map<string, { change: Change; delay: boolean; dropped: boolean; entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }>();
  const unblocks = new Set<() => void>();
  const mentionsKey = (text: string) => Object.values(keys).some((key) => text.includes(key));
  function stage(change: Change, mode?: "delay" | "drop") {
    const operationId = randomUUID();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    if (mode === "delay") unblocks.add(release.resolve);
    pending.set(operationId, { change, delay: mode === "delay", dropped: mode === "drop", entered, release });
    return { operationId, entered: entered.promise, release: release.resolve };
  }
  async function claim(operationId: string, response: ServerResponse) {
    claims.push(operationId);
    const entry = pending.get(operationId);
    pending.delete(operationId);
    if (entry === undefined) { response.writeHead(404).end(); return; }
    if (entry.dropped) { response.destroy(); return; }
    const body = JSON.stringify(entry.change);
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    if (entry.delay) {
      response.write(body.slice(0, 1));
      entry.entered.resolve();
      await entry.release.promise;
      unblocks.delete(entry.release.resolve);
      response.end(body.slice(1));
    } else {
      entry.entered.resolve();
      response.end(body);
    }
  }
  function reply(request: IncomingMessage, response: ServerResponse, body: string): void {
    expect(request.method).toBe("POST");
    expect(mentionsKey(body)).toBe(false);
    const input = JSON.parse(body) as {
      model: string;
      messages: { role: string; content: string }[];
      tools?: { function: { name: string } }[];
    };
    const authorization = Object.entries(keys).find(([, key]) => request.headers.authorization === `Bearer ${key}`)?.[0];
    calls.push({ model: input.model, authorization });
    if (authorization !== "initial" && authorization !== "replacement") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: request.headers.authorization } }));
      return;
    }
    const write = (delta: object, finish_reason: string | null) => {
      const event = { id: "fixture-completion", model: input.model, object: "chat.completion.chunk", created: 1,
        choices: [{ index: 0, delta, finish_reason }] };
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const tool = (name: string, args: object) => ({
      role: "assistant",
      tool_calls: [{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (input.model === execution.modelId) {
      expect(input.tools?.some(({ function: f }) => f.name === "goal_decide") ?? false).toBe(false);
      write({ role: "assistant", content: "Hello" }, null);
      write({}, "stop");
    } else {
      expect(input.model).toBe(review.modelId);
      expect(input.tools?.map(({ function: f }) => f.name).sort()).toEqual(["goal_decide", "goal_history"]);
      const source = input.messages.findLast(({ role }) => role === "tool");
      const delta = source === undefined ? tool("goal_history", { limit: 1 }) : tool("goal_decide", {
        kind: "complete", summary: "Verified the original result",
        evidence: [{ kind: "assistant", criterion: 0, entryId: JSON.parse(source.content).entries[0].id }],
      });
      write(delta, null);
      write({}, "tool_calls");
    }
    response.end("data: [DONE]\n\n");
  }
  function catalog(url: string) {
    const definition = { api: "openai-completions", apiKey: keys.configured, baseUrl: new URL("v1", url).href,
      headers: { Authorization: `Bearer ${keys.configured}` } };
    return {
      openai: { ...definition, models: [{ id: execution.modelId }, { id: review.modelId }, { id: "unused" }] },
      other: { ...definition, models: [{ id: "unrelated" }] },
    };
  }
  return { keys, execution, review, calls, claims, stage, claim, mentionsKey, reply, catalog,
    unblock: () => { for (const release of unblocks) release(); } };
}

async function verifyPersonal(
  first: { client: ReturnType<typeof connect>; port: number },
  fixture: ReturnType<typeof modelFixture>,
  volume: string,
  reopen: () => Promise<{ client: ReturnType<typeof connect>; port: number }>,
  anotherClient: (port: number) => ReturnType<typeof connect>,
  allowOwner: (allowed: boolean) => void,
  runProbe?: (port: number, operationId: string) => Promise<void>,
): Promise<void> {
  const { keys, execution, review, calls } = fixture;
  const file = join(volume, "personal-credentials");
  let client = first.client;
  let port = first.port;
  let credentials = await client.get(Credentials, {});
  const snapshot = () => client.root((ctx) => credentials.snapshot(ctx));
  const invoke = (operationId: string) => client.root((ctx) => credentials.applyPersonalCredentialChange({ operationId }, ctx));
  const set = (key: string, provider = execution.provider): Change => ({ kind: "set", key, provider });
  const put = (key: string, provider = execution.provider) => invoke(fixture.stage(set(key, provider)).operationId);
  const removes: Change = { kind: "remove", provider: execution.provider };
  const remove = () => invoke(fixture.stage(removes).operationId);
  const reconnect = async () => {
    const old = client;
    ({ client, port } = await reopen());
    await old.close();
    credentials = await client.get(Credentials, {});
  };
  const whileDelayed = async (old: Change, newer: Change) => {
    const peer = anotherClient(port);
    const ref = await peer.get(Credentials, {});
    const before = await snapshot();
    const first = fixture.stage(old, "delay");
    const second = fixture.stage(newer);
    const from = fixture.claims.length;
    const earlier = invoke(first.operationId);
    void earlier.catch(() => {});
    try {
      await withinCall(first.entered, "first HTTPS claim response headers");
      const latest = peer.root((ctx) => ref.applyPersonalCredentialChange({ operationId: second.operationId }, ctx));
      void latest.catch(() => {});
      expect(await peer.root((ctx) => ref.snapshot(ctx))).toEqual(before);
      expect(fixture.claims.slice(from)).toEqual([first.operationId]);
      first.release();
      expect(await earlier).toBeNull();
      expect(await latest).toBeNull();
      expect(fixture.claims.slice(from)).toEqual([first.operationId, second.operationId]);
    } finally {
      first.release();
      await peer.close();
    }
  };
  const submit = async (status: GoalSnapshot["status"]) => {
    const goals = await client.get(Goals, {});
    const requestId = randomUUID();
    await client.root((ctx) => goals.execute({ version: 1, requestId, command: {
      kind: "goal.submit", objective: "Return Hello", completionCriteria: ["The answer is Hello"], grant: { id: randomUUID(), version: 1 },
    } }, ctx));
    const goal = await client.get(Goal, { goal: requestId });
    const ready = Promise.withResolvers<GoalSnapshot>();
    const stop = subscribe(goal.snapshot, (value) => { if (value?.status === status) ready.resolve(value); }, ready.reject);
    try {
      const current = goal.snapshot.value;
      return current?.status === status ? current : await withinCall(ready.promise, `goal status ${status}`);
    } finally { stop(); }
  };
  const empty = expect.objectContaining({
    providers: [expect.objectContaining({ id: execution.provider, ways: [expect.objectContaining({ type: "api_key" })] })],
    credentials: [], models: [], execution: null, review: null,
  });
  expect(await snapshot()).toEqual(empty);
  const conversations = await client.get(Conversations, {});
  expect(await client.root((ctx) => conversations.models(ctx))).toEqual({ models: [], current: null });
  await expect(client.root((ctx) => credentials.setKey({ provider: execution.provider, key: "unsafe-direct-argument" }, ctx))).rejects.toThrow("trusted host");
  await expect(client.root((ctx) => credentials.remove({ provider: execution.provider }, ctx))).rejects.toThrow("trusted host");
  expect(fixture.claims).toEqual([]);
  await expect(put(keys.initial, "other")).rejects.toThrow("does not admit");
  await expect(invoke(fixture.stage({ kind: "remove", provider: "other" }).operationId)).rejects.toThrow("does not admit");
  await expect(invoke(randomUUID())).rejects.toThrow("has not admitted");
  allowOwner(false);
  await expect(snapshot()).rejects.toThrow("current owner authority");
  await expect(put(keys.initial)).rejects.toThrow("current owner authority");
  await expect(remove()).rejects.toThrow("current owner authority");
  allowOwner(true);
  await submit("waiting_dependency");
  expect(calls).toEqual([]);

  const original = fixture.stage(set(keys.initial)).operationId;
  if (runProbe === undefined) expect(await invoke(original)).toBeNull();
  else await runProbe(port, original);
  expect(fixture.claims.filter((id) => id === original)).toHaveLength(1);
  await reconnect();
  const connected = await snapshot();
  expect(connected.credentials).toEqual([{ provider: execution.provider, type: "api_key" }]);
  expect(new Set(connected.models.map((model) => model.modelId))).toEqual(new Set([execution.modelId, review.modelId]));
  expect(connected.execution).toEqual(execution);
  expect(connected.review).toEqual(review);
  expect(fixture.mentionsKey(JSON.stringify(connected))).toBe(false);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(fixture.mentionsKey((await readFile(file)).toString("latin1"))).toBe(false);
  await submit("completed");
  const expected = (authorization: string) => [execution.modelId, review.modelId, review.modelId].map((model) => ({ model, authorization }));
  expect(calls).toEqual(expected("initial"));

  await mkdir(file + ".partial");
  await expect(put(keys.replacement)).rejects.toThrow("protected model credentials are unavailable");
  await rename(file + ".partial", file + ".fixture-blocker");
  expect(await snapshot()).toEqual(connected);
  await submit("completed");
  expect(calls.slice(-3)).toEqual(expected("initial"));

  const dropped = fixture.stage(set(keys.rejected), "drop").operationId;
  await expect(invoke(dropped)).rejects.toThrow("claim outcome could not be observed");
  expect(fixture.claims.filter((id) => id === dropped)).toHaveLength(1);
  expect(await snapshot()).toEqual(connected);

  await whileDelayed(set(keys.rejected), set(keys.replacement));
  await reconnect();
  expect(await snapshot()).toEqual(connected);
  await submit("completed");
  expect(calls.slice(-3)).toEqual(expected("replacement"));

  await put(keys.rejected);
  const failed = await submit("waiting_dependency");
  expect(fixture.mentionsKey(JSON.stringify(failed))).toBe(false);
  expect(calls.at(-1)).toEqual({ model: execution.modelId, authorization: "rejected" });
  const count = calls.length;
  await whileDelayed(set(keys.initial), removes);
  await reconnect();
  expect(await snapshot()).toEqual(empty);
  await submit("waiting_dependency");
  expect(calls).toHaveLength(count);
  expect(await remove()).toBeNull();
  console.log(JSON.stringify({ sealedRestarts: 3, modelRequests: calls.length, verified: ["cold", "execution", "review", "reopened", "replaced", "removed", "ordered-https-claims", "lost-claim", "write-failure", "provider-failure"] }));
}

async function loopbackCertificate(directory: string) {
  const key = join(directory, "fixture-key.pem");
  const caFile = join(directory, "fixture-ca.pem");
  const config = join(directory, "fixture-tls.conf");
  await writeFile(config, "[req]\nprompt=no\ndistinguished_name=subject\nx509_extensions=extensions\n[subject]\nCN=localhost\n[extensions]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n");
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", caFile, "-config", config]);
  return { caFile, options: { key: await readFile(key), cert: await readFile(caFile) } };
}

async function verifyRestart(mode: RestartMode, onTestFinished: (cleanup: () => Promise<void>) => void) {
  const personal = mode === "personal";
  const supervised = mode !== "replacement" && !personal;
  const root = await mkdtemp(join(tmpdir(), "cloud-cli-restart-"));
  const volume = join(root, "sealed");
  const home = join(root, "restored");
  const file = join(root, "configuration.json");
  const agentId = randomUUID();
  const operationId = randomUUID();
  const key = randomBytes(32);
  const launchToken = randomUUID();
  const controlToken = randomUUID();
  const jobToken = randomUUID();
  const accepted = Promise.withResolvers<void>();
  const releaseReceipt = Promise.withResolvers<void>();
  const modelAttempt = Promise.withResolvers<void>();
  let holdReceipt = false;
  let anchored: RecoveryAnchor | undefined;
  let initialized = false;
  let epoch = 1;
  let ownerAllowed = true;
  const keyEpochs: number[] = [];
  const modelEpochs: number[] = [];
  const failures: unknown[] = [];
  const fixture = personal ? modelFixture() : undefined;
  const tls = fixture === undefined ? undefined : await loopbackCertificate(root);
  const reply = (response: ServerResponse, value: unknown) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); };
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks).toString();
    expect(request.method).toBe("POST");
    expect(request.headers.authorization === `Bearer ${controlToken}`).toBe(true);
    const body = JSON.parse(bytes);
    expect({ agentId: body.agentId, epoch: body.epoch, owner: body.owner }).toEqual({ agentId, epoch, owner: "local" });
    switch (request.url) {
      case "/internal/v1/initialization/key":
        expect(body.operationId).toBe(operationId); expect(initialized).toBe(false);
        reply(response, { operationId, serviceKey: key.toString("base64url") }); break;
      case "/internal/v1/initialization/verify":
        expect(body.operationId).toBe(operationId); reply(response, { allowed: !initialized }); break;
      case "/internal/v1/initialization/complete":
        expect(body.operationId).toBe(operationId); expect(body.head).toEqual(anchored?.head);
        initialized = true; reply(response, { operationId, revision: 1, action: "enrolled", createdAt: new Date().toISOString() }); break;
      case "/internal/v1/anchor/read":
        if (anchored === undefined) { response.writeHead(404).end(); break; }
        reply(response, anchored); break;
      case "/internal/v1/anchor/init":
        expect(initialized).toBe(false); expect(anchored).toBeUndefined();
        anchored = { head: body.head, pending: null }; reply(response, anchored); break;
      case "/internal/v1/anchor/prepare":
        expect(anchored).toEqual({ head: body.expected, pending: null }); expect(body.pending.generation).toBe(epoch);
        anchored = { head: body.expected, pending: body.pending }; reply(response, anchored); break;
      case "/internal/v1/anchor/confirm":
        expect(anchored?.pending).toEqual(body.pending); expect(body.local).toEqual(body.pending.next);
        anchored = { head: body.local, pending: null };
        if (holdReceipt) {
          holdReceipt = false;
          accepted.resolve();
          await releaseReceipt.promise;
        }
        reply(response, anchored); break;
      case "/internal/v1/execution/key":
        expect(initialized).toBe(true); keyEpochs.push(epoch);
        if (mode === "revoked" && keyEpochs.length > 1) { response.writeHead(403).end(); break; }
        reply(response, { revision: 1, serviceKey: key.toString("base64url") }); break;
      case "/internal/v1/wake": response.writeHead(204).end(); break;
      case "/internal/v1/personal-model/claim":
        expect(fixture).toBeDefined();
        expect(typeof body.operationId).toBe("string");
        expect(Object.keys(body).sort()).toEqual(["agentId", "epoch", "operationId", "owner"]);
        await fixture!.claim(body.operationId, response);
        break;
      case "/internal/v1/authority":
        if (body.action === "model") {
          modelEpochs.push(epoch);
          modelAttempt.resolve();
          reply(response, { allowed: personal }); break;
        }
        expect(personal ? ["owner", "submit", "tool"] : ["owner", "submit"]).toContain(body.action);
        if (!personal && body.action === "submit" && epoch === 2) holdReceipt = true;
        reply(response, { allowed: ownerAllowed }); break;
      default: throw new Error(`unexpected fixture route: ${request.url}`);
    }
  }
  const listener = (request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response).catch((error) => {
      failures.push(error);
      if (fixture === undefined) { accepted.reject(error); modelAttempt.reject(error); }
      if (response.headersSent) response.destroy();
      else response.writeHead(500).end();
    });
  };
  const server = tls === undefined ? createServer(listener) : createSecureServer(tls.options, listener);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `${tls === undefined ? "http" : "https"}://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const modelServer = fixture === undefined ? undefined : createServer((request, response) => {
    void (async () => {
      expect(request.url).toBe("/v1/chat/completions");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      fixture.reply(request, response, Buffer.concat(chunks).toString());
    })().catch((error) => {
      failures.push(error);
      if (response.headersSent) response.destroy();
      else response.writeHead(500).end();
    });
  });
  if (modelServer !== undefined) {
    modelServer.listen(0, "127.0.0.1");
    await once(modelServer, "listening");
  }
  const modelUrl = modelServer === undefined ? url : `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/`;
  const storage = { queueCapacity: 1, nativeModule: nativeModule! };
  const control = () => ({ url, agentId, epoch, owner: "local", ...(tls === undefined ? {} : { caFile: tls.caFile, requestTimeoutMs: CALL_TIMEOUT_MS }) });
  const env = () => ({ PATH: process.env.PATH, CHOPIN_CONTROL_TOKEN: controlToken, CHOPIN_JOB_TOKEN: jobToken, CHOPIN_TOKEN: launchToken,
    CHOPIN_AGENT_ID: agentId, CHOPIN_RUNTIME_EPOCH: String(epoch), CHOPIN_CONTROL_URL: url.slice(0, -1),
    ...(fixture === undefined ? {} : { OPENAI_API_KEY: fixture.keys.environment }) });
  const children: ReturnType<typeof spawn>[] = [];
  const clients: ReturnType<typeof connect>[] = [];
  const openClient = (port: number) => {
    const client = connect(`ws://127.0.0.1:${port}/`, { token: launchToken });
    clients.push(client);
    return client;
  };
  async function start() {
    let port = 0;
    if (supervised) {
      const reservation = createServer();
      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening");
      port = (reservation.address() as AddressInfo).port;
      await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    }
    const config: CloudConfiguration = {
      version: 1, purpose: "execution", keySource: "custody", volume, home, control: control(),
      jobs: { transport: { url: `${url}commands/`, scopeId: agentId, ...(tls === undefined ? {} : { caFile: tls.caFile }) }, domain: operationId, cwd: root, policyRevision: "fixture", inheritEnv: false,
        policy: { pollAfterMs: 1, outputPageBytes: 1, scanPageSize: 1, output: { maxBytes: 1, maxLines: 1 } } },
      storage, server: { hostname: "127.0.0.1", port }, model: fixture?.execution ?? { provider: "fixture", modelId: "model" },
      reviewModel: fixture?.review ?? { provider: "fixture", modelId: "model" }, goalRetryAfterMs: CALL_TIMEOUT_MS, vaultSyncMs: CALL_TIMEOUT_MS,
      ...(personal ? { personalModels: true } : {}),
    };
    await writeFile(file, JSON.stringify(config));
    if (mode === "replacement" && epoch === 2) {
      await expect(promisify(execFile)(process.execPath, [bin, "cloud", "--config", file], {
        env: { ...env(), CHOPIN_RUNTIME_EPOCH: "1", CHOPIN_CONTROL_TOKEN: undefined }, timeout: CALL_TIMEOUT_MS,
      })).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("does not match the admitted allocation") });
      expect(keyEpochs).toEqual([]);
    }
    const args = [bin, "cloud", "--config", file, ...(supervised ? ["--supervise"] : [])];
    const child = spawn(process.execPath, args, { env: env(), stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const exited = once(child, "close");
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const events: SupervisorEvent[] = [];
    async function read() {
      const line = await lines.next();
      if (line.done) return undefined;
      const event = JSON.parse(line.value);
      if (event.source === "cloud-supervisor") events.push(event);
      return event;
    }
    async function connectRestored() {
      for (let event = await read(); event !== undefined; event = await read()) {
        if (supervised ? event.event !== "restored" : event.state !== "restored") continue;
        const client = openClient(event.port);
        return { client, goals: await client.get(Goals, {}), pid: supervised ? event.pid as number : child.pid!, port: event.port as number };
      }
      throw new Error(`cloud exited before restoring: ${stderr}`);
    }
    async function collect(rejectRestored = false) {
      for (let event = await read(); event !== undefined; event = await read()) {
        if (rejectRestored && event.source === "cloud-supervisor" && event.event === "restored") {
          throw new Error("replacement cloud unexpectedly restored");
        }
      }
    }
    return { child, exited, connectRestored, collect, events, stderr: () => stderr };
  }
  onTestFinished(async () => {
    releaseReceipt.resolve();
    fixture?.unblock();
    for (const client of clients) await client.close();
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const closed = once(child, "close");
      child.kill("SIGTERM");
      if (await Promise.race([closed.then(() => false), setTimeout(CALL_TIMEOUT_MS, true, { ref: false })])) {
        child.kill("SIGKILL");
        await closed;
      }
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (modelServer !== undefined) {
      modelServer.closeAllConnections();
      await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    }
    key.fill(0);
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(file, JSON.stringify({ version: 1, operationId, volume, home, control: control(), storage }));
  const initialization = await promisify(execFile)(process.execPath, [bin, "initialize", "--config", file], { env: env(), timeout: CALL_TIMEOUT_MS });
  expect(JSON.parse(initialization.stdout)).toMatchObject({ operationId, confirmedHead: anchored?.head });
  const vault = await Vault.openExisting(volume, home, key);
  await writeFile(join(home, "models.json"), JSON.stringify({ providers: fixture?.catalog(modelUrl) ?? { fixture: {
    api: "openai-completions", apiKey: "fixture", baseUrl: url, models: [{ id: "model" }],
  } } }));
  await vault.close();
  const marker = await readFile(join(volume, "key-check"));

  epoch = 2;
  const launched = await start();
  const first = await withinCall(launched.connectRestored(), "the initial cloud listener");
  if (fixture !== undefined) {
    const otherIdentity = await fetch(`http://127.0.0.1:${first.port}/status`, {
      headers: { authorization: `Bearer ${randomUUID()}` },
    });
    expect(otherIdentity.status).toBe(401);
    await otherIdentity.body?.cancel();
    const sessions = [launched];
    let previous = launched;
    const probe = process.env.CHOPIN_TEST_PERSONAL_MODEL_PROBE;
    const runProbe = probe === undefined ? undefined : async (port: number, operationId: string) => {
      try {
        await promisify(execFile)(probe, [], {
          timeout: CALL_TIMEOUT_MS,
          env: { PATH: process.env.PATH, CHOPIN_TEST_PERSONAL_MODEL_FIXTURE: JSON.stringify({
            endpoint: `ws://127.0.0.1:${port}/`, launch: launchToken, operationId, provider: fixture.execution.provider,
          }) },
        });
      } catch {
        throw new Error("the external personal model protocol probe failed");
      }
    };
    const reopen = async () => {
      previous.child.kill("SIGKILL");
      expect(await withinCall(previous.exited, "personal runtime exit")).toEqual([null, "SIGKILL"]);
      await rename(home, join(root, `previous-home-${epoch}`));
      epoch++;
      previous = await start();
      sessions.push(previous);
      return withinCall(previous.connectRestored(), "personal runtime restoration");
    };
    await verifyPersonal(first, fixture, volume, reopen, openClient, (allowed) => { ownerAllowed = allowed; }, runProbe);
    for (const session of sessions) expect(fixture.mentionsKey(session.stderr())).toBe(false);
    expect(failures).toEqual([]);
    return;
  }
  const command = { version: 1, requestId: randomUUID(), command: { kind: "goal.submit",
    objective: "Retain the original goal", completionCriteria: ["The original receipt survives"], grant: { id: randomUUID(), version: 1 } } } satisfies EngineCommand;
  const pending = first.client.root((ctx) => first.goals.execute(command, ctx)).then(
    () => { throw new Error("the original response escaped the injected loss"); },
    () => undefined,
  );
  await withinCall(Promise.race([accepted.promise, pending.then(() => { throw new Error("the submit ended before the native commit"); })]),
    "the original goal's native commit");
  await first.client.close();
  if (mode === "changed-config") {
    const changed = JSON.parse(await readFile(file, "utf8"));
    changed.jobs.cwd = join(root, "other-workspace");
    await writeFile(file, JSON.stringify(changed));
  }
  process.kill(first.pid, "SIGKILL");
  releaseReceipt.resolve();
  await pending;

  if (mode === "revoked" || mode === "changed-config") {
    await withinCall(launched.collect(true), "refusal of the replacement child");
    expect(await launched.exited).toEqual([1, null]);
    expect(launched.events.map(({ event, attempt }) => [event, attempt])).toEqual([
      ["started", 1], ["restored", 1], ["exited", 1], ["started", 2], ["exited", 2],
    ]);
    expect(launched.events[2]).toMatchObject({ pid: first.pid, signal: "SIGKILL", requested: false });
    expect(launched.events[4]).toMatchObject({ code: 1, requested: false });
    expect(launched.stderr()).toContain(mode === "revoked" ? "refused the operation: 403" : "supervised cloud configuration changed");
    expect(keyEpochs).toEqual(mode === "revoked" ? [2, 2] : [2]);
    expect(modelEpochs).toEqual([]);
    expect(await readFile(join(volume, "key-check"))).toEqual(marker);
    expect(failures).toEqual([]);
    return;
  }

  let recovered = launched;
  if (mode === "replacement") {
    expect(await withinCall(launched.exited, "the original process exit")).toEqual([null, "SIGKILL"]);
    await rename(home, join(root, "previous-home"));
    epoch = 3;
    recovered = await start();
  }
  const second = await withinCall(recovered.connectRestored(), "the restored cloud listener");
  expect(second.pid).not.toBe(first.pid);
  if (mode === "supervised") {
    expect(second.port).toBe(first.port);
    expect(recovered.events.map(({ event, attempt }) => [event, attempt])).toEqual([
      ["started", 1], ["restored", 1], ["exited", 1], ["started", 2], ["restored", 2],
    ]);
    expect(recovered.events[2]).toMatchObject({ pid: first.pid, signal: "SIGKILL", requested: false });
    expect(recovered.events[4]).toMatchObject({ pid: second.pid });
    expect(recovered.events[4]?.elapsedMs).toBeGreaterThanOrEqual(recovered.events[2]!.elapsedMs);
    for (const event of recovered.events) expect(Number.isFinite(Date.parse(event.at))).toBe(true);
  }
  expect(keyEpochs).toEqual(mode === "supervised" ? [2, 2] : [2, 3]);
  expect(await readFile(join(volume, "key-check"))).toEqual(marker);
  const receipt = await second.client.root((ctx) => second.goals.request({ requestId: command.requestId }, ctx));
  expect(receipt?.goalId).toBe(command.requestId);
  const goal = await second.client.get(Goal, { goal: command.requestId });
  expect(goal.snapshot.value).toMatchObject({ objective: command.command.objective, status: "accepted" });
  expect(await second.client.root((ctx) => second.goals.execute(command, ctx))).toEqual(receipt);
  const paused = anchored?.head;
  ownerAllowed = false;
  await expect(second.client.root((ctx) => second.goals.resume(ctx))).rejects.toThrow("current goal authority");
  expect(await Promise.race([
    setTimeout(CALL_TIMEOUT_MS, "paused", { ref: false }),
    modelAttempt.promise.then(() => "scheduled"),
  ])).toBe("paused");
  expect(modelEpochs).toEqual([]);
  expect(anchored?.head).toEqual(paused);
  ownerAllowed = true;
  await second.client.root((ctx) => second.goals.resume(ctx));
  await second.client.close();
  await withinCall(modelAttempt.promise, "model admission after authorized resume");
  expect(modelEpochs).toEqual([epoch]);
  expect(anchored?.head).not.toEqual(paused);
  expect(failures).toEqual([]);
  if (mode === "supervised") {
    const observer = connect(`ws://127.0.0.1:${second.port}/`, { token: launchToken });
    clients.push(observer);
    expect((await observer.get(Goal, { goal: command.requestId })).snapshot.value?.goalId).toBe(command.requestId);
  }
  recovered.child.kill("SIGTERM");
  expect(await withinCall(recovered.exited, "normal shutdown")).toEqual([0, null]);
  await recovered.collect();
  if (mode === "supervised") {
    expect(recovered.events).toHaveLength(6);
    expect(recovered.events[5]).toMatchObject({ event: "exited", attempt: 2, pid: second.pid, code: 0, signal: null, requested: true });
    console.log(JSON.stringify({ originalGoalId: receipt?.goalId, custodyEpochs: keyEpochs, supervisorPid: recovered.child.pid,
      cloudEvents: recovered.events }));
  }
}
