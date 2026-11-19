import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { RecoveryAnchor } from "@chopin-ai/harness-pi";
import { CALL_TIMEOUT_MS, Goal, Goals, connect, type EngineCommand } from "@chopin-ai/harness-pi/protocol";
import { expect, it } from "vitest";
import type { CloudConfiguration } from "../src/cloud.js";
import { Vault } from "../src/vault.js";

const nativeModule = process.env.CHOPIN_TEST_NATIVE_MODULE;
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

type RestartMode = "replacement" | "supervised" | "revoked" | "changed-config";
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

function withinCall<T>(work: Promise<T>, description: string): Promise<T> {
  return Promise.race([work, once(AbortSignal.timeout(CALL_TIMEOUT_MS), "abort").then(() => {
    throw new Error(`timed out waiting for ${description}`);
  })]);
}

async function verifyRestart(mode: RestartMode, onTestFinished: (cleanup: () => Promise<void>) => void) {
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
  const reply = (response: ServerResponse, value: unknown) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); };
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe(`Bearer ${controlToken}`);
    const body = JSON.parse(Buffer.concat(chunks).toString());
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
      case "/internal/v1/authority":
        if (body.action === "model") {
          modelEpochs.push(epoch);
          modelAttempt.resolve();
          reply(response, { allowed: false }); break;
        }
        expect(["owner", "submit"]).toContain(body.action);
        if (body.action === "submit" && epoch === 2) holdReceipt = true;
        reply(response, { allowed: ownerAllowed }); break;
      default: throw new Error(`unexpected fixture route: ${request.url}`);
    }
  }
  const server = createServer((request, response) => { void handle(request, response).catch((error) => { failures.push(error); accepted.reject(error); modelAttempt.reject(error); response.writeHead(500).end(); }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const storage = { queueCapacity: 1, nativeModule: nativeModule! };
  const control = () => ({ url, agentId, epoch, owner: "local" });
  const env = () => ({ PATH: process.env.PATH, CHOPIN_CONTROL_TOKEN: controlToken, CHOPIN_JOB_TOKEN: jobToken, CHOPIN_TOKEN: launchToken,
    CHOPIN_AGENT_ID: agentId, CHOPIN_RUNTIME_EPOCH: String(epoch), CHOPIN_CONTROL_URL: url.slice(0, -1) });
  const children: ReturnType<typeof spawn>[] = [];
  const clients: ReturnType<typeof connect>[] = [];
  async function start() {
    let port = 0;
    if (mode !== "replacement") {
      const reservation = createServer();
      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening");
      port = (reservation.address() as AddressInfo).port;
      await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    }
    const config: CloudConfiguration = {
      version: 1, purpose: "execution", keySource: "custody", volume, home, control: control(),
      jobs: { transport: { url: `${url}commands/`, scopeId: agentId }, domain: operationId, cwd: root, policyRevision: "fixture", inheritEnv: false,
        policy: { pollAfterMs: 1, outputPageBytes: 1, scanPageSize: 1, output: { maxBytes: 1, maxLines: 1 } } },
      storage, server: { hostname: "127.0.0.1", port }, model: { provider: "fixture", modelId: "model" },
      reviewModel: { provider: "fixture", modelId: "model" }, goalRetryAfterMs: CALL_TIMEOUT_MS, vaultSyncMs: CALL_TIMEOUT_MS,
    };
    await writeFile(file, JSON.stringify(config));
    if (mode === "replacement" && epoch === 2) {
      await expect(promisify(execFile)(process.execPath, [bin, "cloud", "--config", file], {
        env: { ...env(), CHOPIN_RUNTIME_EPOCH: "1", CHOPIN_CONTROL_TOKEN: undefined }, timeout: CALL_TIMEOUT_MS,
      })).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("does not match the admitted allocation") });
      expect(keyEpochs).toEqual([]);
    }
    const args = [bin, "cloud", "--config", file, ...(mode === "replacement" ? [] : ["--supervise"])];
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
        if (mode === "replacement" ? event.state !== "restored" : event.event !== "restored") continue;
        const client = connect(`ws://127.0.0.1:${event.port}/`, { token: launchToken });
        clients.push(client);
        return { client, goals: await client.get(Goals, {}), pid: mode === "replacement" ? child.pid! : event.pid as number, port: event.port as number };
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
    key.fill(0);
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(file, JSON.stringify({ version: 1, operationId, volume, home, control: control(), storage }));
  const initialization = await promisify(execFile)(process.execPath, [bin, "initialize", "--config", file], { env: env(), timeout: CALL_TIMEOUT_MS });
  expect(JSON.parse(initialization.stdout)).toMatchObject({ operationId, confirmedHead: anchored?.head });
  const vault = await Vault.openExisting(volume, home, key);
  await writeFile(join(home, "models.json"), JSON.stringify({ providers: { fixture: {
    api: "openai-completions", apiKey: "fixture", baseUrl: url, models: [{ id: "model" }],
  } } }));
  await vault.close();
  const marker = await readFile(join(volume, "key-check"));

  epoch = 2;
  const launched = await start();
  const first = await withinCall(launched.connectRestored(), "the initial cloud listener");
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
