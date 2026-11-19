import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, type TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, ToolResultEntry, type ConversationId, type EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, it } from "vitest";
import { CommandJobs, type CommandPolicy } from "../src/commands.js";
import { CommandRefusal, isJobRequest, type CommandBroker, type JobRequest, type JobSnapshot } from "../src/jobs.js";
import { GoalEngine } from "../src/goals/engine.js";
import { GoalDoc } from "../src/goals/store.js";
import { terminal, type EngineCommand, type GoalSnapshot } from "../src/goals/contracts.js";
import { CALL_TIMEOUT_MS } from "../src/protocol.js";
import { AgentService } from "../src/service.js";
import { localWorkspace } from "./local-workspace.js";
import { ModeDoc } from "../src/mode.js";

type Row = { request: JobRequest; snapshot: JobSnapshot; child?: ChildProcess; frames: { stream: "stdout" | "stderr"; bytes: Buffer }[] };

/** Local process fixture; production broker authority and physical isolation are verified separately. */
class ProcessBroker implements CommandBroker {
  readonly rows = new Map<string, Row>();
  readonly reads: { operation: string; cursor?: string }[] = [];
  readonly stopped = Promise.withResolvers<void>();
  readonly closed = Promise.withResolvers<void>();
  readonly closedOperations = new Set<string>();
  readonly scope = randomUUID();
  submits = 0;
  spawns = 0;
  loseAcknowledgement = false;
  unavailable = 0;
  hideStop = false;
  holdOutput = false;

  async get(operation: string): Promise<JobSnapshot | undefined> {
    if (this.unavailable > 0) { this.unavailable--; throw new Error("original observation unavailable"); }
    return structuredClone(this.rows.get(operation)?.snapshot);
  }
  async submit(operation: string, request: JobRequest): Promise<JobSnapshot> {
    this.submits++;
    expect(isJobRequest(request)).toBe(true);
    const previous = this.rows.get(operation);
    if (previous !== undefined) { expect(previous.request).toEqual(request); return structuredClone(previous.snapshot); }
    const row = this.#row(operation, request);
    this.spawns++;
    const child = row.child = spawn(request.argv[0]!, request.argv.slice(1), { cwd: request.cwd, env: { ...request.env }, stdio: ["pipe", "pipe", "pipe"] });
    row.snapshot.state.phase = "running"; row.snapshot.state.started = true; row.snapshot.state.released = true;
    for (const [stream, source] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) source!.on("data", (bytes: Buffer) => {
      row.frames.push({ stream, bytes: Buffer.from(bytes) }); row.snapshot.state.lastSequence++; row.snapshot.state.version++;
    });
    child.once("exit", (code, signal) => {
      row.snapshot.state.phase = "exited"; row.snapshot.state.version++;
      row.snapshot.state.primaryExit = signal === null ? { kind: "code", value: code! } : { kind: "signal", value: constants.signals[signal] };
    });
    child.once("close", () => {
      this.closedOperations.add(operation);
      if (!this.holdOutput) { row.snapshot.state.phase = "drained"; row.snapshot.state.outputComplete = true; row.snapshot.state.version++; }
      this.closed.resolve();
    });
    if (this.loseAcknowledgement) { this.loseAcknowledgement = false; throw new Error("acceptance response was lost"); }
    return structuredClone(row.snapshot);
  }
  async reconcile(operation: string): Promise<JobSnapshot> {
    const row = await this.get(operation);
    if (row === undefined) throw new CommandRefusal(404);
    return row;
  }
  async cancel(operation: string, request: JobRequest): Promise<JobSnapshot> {
    const row = this.rows.get(operation) ?? this.#row(operation, request);
    row.snapshot.state.stopRequested = true; row.snapshot.state.version++;
    if (row.child === undefined) { row.snapshot.state.phase = "drained"; row.snapshot.state.outputComplete = true; }
    else if (row.child.exitCode === null && row.child.signalCode === null) row.child.kill("SIGTERM");
    this.stopped.resolve();
    if (this.hideStop) throw new Error("stop observation unavailable");
    return structuredClone(row.snapshot);
  }
  async stop(operation: string): Promise<JobSnapshot> {
    const row = this.rows.get(operation);
    if (row === undefined) throw new CommandRefusal(404);
    return this.cancel(operation, row.request);
  }
  releaseOutput(): void {
    this.holdOutput = false;
    for (const operation of this.closedOperations) {
      const row = this.rows.get(operation)!;
      row.snapshot.state.phase = "drained"; row.snapshot.state.outputComplete = true; row.snapshot.state.version++;
    }
  }
  async close(): Promise<void> {
    await Promise.all([...this.rows.values()].map(async ({ child }) => {
      if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, "close"); child.kill("SIGTERM"); await closed;
    }));
  }
  async output(operation: string, limit: number, cursor?: string) {
    this.reads.push({ operation, ...(cursor !== undefined && { cursor }) });
    const row = this.rows.get(operation);
    if (row === undefined) throw new CommandRefusal(404);
    const at: { operation: string; frame: number; offset: number } = cursor === undefined ? { operation, frame: 0, offset: 0 } : JSON.parse(Buffer.from(cursor, "base64url").toString());
    expect(at.operation).toBe(operation);
    const frame = row.frames[at.frame];
    const data = frame?.bytes.subarray(at.offset, at.offset + limit) ?? Buffer.alloc(0);
    if (frame !== undefined) { at.offset += data.length; if (at.offset === frame.bytes.length) { at.frame++; at.offset = 0; } }
    return { stream: frame?.stream ?? null, data: data.toString("base64url"), cursor: Buffer.from(JSON.stringify(at)).toString("base64url"), complete: row.snapshot.state.outputComplete && at.frame === row.frames.length };
  }
  #row(operation: string, request: JobRequest): Row {
    const row: Row = { request: structuredClone(request), frames: [], snapshot: { scopeId: this.scope, operationId: operation, state: {
      version: 1, phase: "pending", stopRequested: false, worker: null, process: null, released: false, started: false, primaryExit: null, outputComplete: false, lastSequence: 0,
    } } };
    this.rows.set(operation, row); return row;
  }
}

const policy: CommandPolicy = { pollAfterMs: 1, outputPageBytes: 1, scanPageSize: 1, output: { maxBytes: 64, maxLines: 4 } };

async function fixture(broker: ProcessBroker, directory?: string, changed = false) {
  const root = directory ?? await mkdtemp(join(tmpdir(), "chopin-command-goal-"));
  const storage = await openNodeSqliteStorage(join(root, "store.sqlite"));
  const provider = fauxProvider(); const models = createModels(); models.setProvider(provider.provider); const model = provider.getModel();
  const errors: unknown[] = []; let prepared = 0;
  const hooks: { prepare?: () => Promise<void>; settled?: () => void } = {};
  let engine: GoalEngine;
  const jobs = new CommandJobs({ broker, policy, report: (error) => errors.push(error), prepare: async (api, ctx) => {
    prepared++;
    const goal = await engine.forExecution(api.conversationId, ctx);
    await hooks.prepare?.();
    return { goal, domain: changed ? randomUUID() : broker.scope, policyRevision: changed ? "replacement" : "original", cwd: changed ? "/unavailable-replacement" : root, inheritEnv: false };
  } });
  engine = new GoalEngine({ authorize: async () => ({ allowed: true }), settled: async (goal, ctx) => { try { await jobs.settled(engine.store, goal, ctx); } finally { hooks.settled?.(); } }, retryAfterMs: policy.pollAfterMs, report: (error) => errors.push(error), review: async (input) => {
    const page = await input.entries(16);
    const tool = page.items.find((entry) => entry.kind === ToolResultEntry.kind);
    if (tool === undefined) throw new Error("the original command has no committed result");
    expect(await readFile(join(root, "runs"), "utf8")).toBe("run\n");
    return { kind: "complete", summary: "Original command completed", evidence: [{ kind: "tool", criterion: 0, entryId: Number(tool.id) }] };
  } });
  const registry = createRegistry(); for (const extension of [...engine.extensions, jobs.extension]) registry.install(extension);
  const harness = await Harness.open(storage, { registry, models, settings: () => engine.settings(registry), onReport: (error) => errors.push(error) }, context);
  engine.attach(harness, storage);
  await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  return { root, engine, jobs, harness, storage, provider, errors, hooks, prepared: () => prepared, close: async () => { await harness.close(context); await engine.close(); } };
}

async function until(f: Pick<Awaited<ReturnType<typeof fixture>>, "harness" | "errors">, id: string, predicate: (goal: GoalSnapshot) => boolean): Promise<GoalSnapshot> {
  const watch = await f.harness.watchDoc(GoalDoc, id, withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), context));
  if (watch === undefined) throw new Error("the original goal is missing");
  try {
    if (watch.value.snapshot !== null && predicate(watch.value.snapshot)) return structuredClone(watch.value.snapshot);
    return await new Promise((resolve, reject) => {
      watch.start(async (change) => {
        if (change.kind === "failed") reject(change.error);
        else if (change.value.snapshot !== null) {
          if (predicate(change.value.snapshot)) resolve(structuredClone(change.value.snapshot));
          else if (terminal(change.value.snapshot.status)) reject(new Error(`unexpected goal terminal state: ${change.value.snapshot.status}`));
          else if (change.value.snapshot.status === "waiting_dependency") reject(new Error(`unexpected dependency failure: ${f.errors.map(String).join("; ")}`));
        }
      });
      void watch.closed.then((end) => reject(new Error(`goal observation ended: ${end.kind}`)));
    });
  } finally { await watch.stop(); }
}

function request(): EngineCommand { return { version: 1, requestId: randomUUID(), command: { kind: "goal.submit", objective: "Run the original command once", completionCriteria: ["The original command records exactly one run"], grant: { id: randomUUID(), version: 1 } } }; }
function call(root: string, wait = false) {
  const program = `import {appendFile} from "node:fs/promises"; import {once} from "node:events"; await appendFile(${JSON.stringify(join(root, "runs"))}, ${JSON.stringify("run\n")}); process.stdout.write(${JSON.stringify("€begin\n")}); ${wait ? 'await once(process.stdin, "data");' : ""} process.stdout.write(process.env.SOURCE); process.stdin.destroy();`;
  return fauxAssistantMessage(fauxToolCall("command", { argv: [process.execPath, "--input-type=module", "--eval", program], env: { SOURCE: "original" } }, { id: "original-command-call" }), { stopReason: "toolUse" });
}

async function toolEntries(f: Awaited<ReturnType<typeof fixture>>, goal: GoalSnapshot): Promise<EntryRecord[]> {
  return (await f.storage.scanEntries({ conversationId: goal.conversationId as ConversationId, order: "ascending" }, 16, undefined, context)).items.filter((entry) => entry.kind === ToolResultEntry.kind);
}

it("completes a real goal only after the original local process and its committed tool result", async () => {
  const broker = new ProcessBroker(); const f = await fixture(broker);
  f.provider.setResponses([call(f.root), fauxAssistantMessage("Done")]);
  try {
    const receipt = await f.engine.execute(request(), undefined, context);
    const goal = await until(f, receipt.goalId, (goal) => goal.status === "completed");
    expect(broker.spawns).toBe(1); expect(broker.submits).toBe(1); expect(f.prepared()).toBe(1);
    const entries = await toolEntries(f, goal);
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0]!.model)).toContain("€begin\\noriginal");
    expect(await readFile(join(f.root, "runs"), "utf8")).toBe("run\n");
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

it("reads every original binary output byte through model-visible pages after the command reference retires", async () => {
  const broker = new ProcessBroker(); const f = await fixture(broker);
  const expected = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const received: Buffer[] = []; let pages = 0;
  const next = (request: TranscriptContext) => {
    const message = request.messages.findLast((message) => message.role === "toolResult");
    if (message?.role !== "toolResult") throw new Error("the model has no original tool result");
    const operation = [...broker.rows.keys()][0]!;
    let cursor: string | undefined;
    if (message.toolName === "command_output") {
      expect(message.isError).toBe(false);
      const text = message.content[0]; if (text?.type !== "text") throw new Error("the output page has no bytes");
      received.push(Buffer.from(JSON.parse(text.text), "base64url")); pages++;
      const metadata = message.content.find((part) => part.type === "text" && part.text.startsWith("<harness>"));
      if (metadata?.type !== "text") throw new Error("the output cursor was not shown to the model");
      const line = metadata.text.split("\n").find((line) => line.startsWith("[info] {"));
      if (line === undefined) throw new Error("the output page metadata is missing");
      const page = JSON.parse(line.slice("[info] ".length));
      expect(page.operationId).toBe(operation); expect(page.stream).toBe("stdout");
      if (page.complete) return fauxAssistantMessage("Original output fully read");
      cursor = page.cursor;
    }
    f.provider.appendResponses([next]);
    return fauxAssistantMessage(fauxToolCall("command_output", { operationId: operation, ...(cursor !== undefined && { cursor }), encoding: "base64url" }), { stopReason: "toolUse" });
  };
  const program = `import {appendFile} from 'node:fs/promises'; await appendFile(${JSON.stringify(join(f.root, "runs"))}, 'run\\n'); process.stdout.write(Buffer.from(${JSON.stringify([...expected])}));`;
  f.provider.setResponses([fauxAssistantMessage(fauxToolCall("command", { argv: [process.execPath, "--input-type=module", "--eval", program] }), { stopReason: "toolUse" }), next]);
  try {
    const receipt = await f.engine.execute(request(), undefined, context);
    await until(f, receipt.goalId, (goal) => goal.status === "completed");
    expect(Buffer.concat(received)).toEqual(expected); expect(pages).toBeGreaterThan(1);
    expect(broker.spawns).toBe(1);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); await broker.close(); }
});

it("rejects an output read from another goal before contacting the broker", async () => {
  const broker = new ProcessBroker(); const f = await fixture(broker);
  f.provider.setResponses([call(f.root), fauxAssistantMessage("Done")]);
  try {
    const first = await f.engine.execute(request(), undefined, context);
    await until(f, first.goalId, (goal) => goal.status === "completed");
    const operation = [...broker.rows.keys()][0]!; const reads = broker.reads.length;
    const denied = Promise.withResolvers<EntryRecord>();
    const observation = f.harness.observeCommits({ advance: (commit) => {
      for (const change of commit.changes) if (change.type === "entry" && change.value.kind === ToolResultEntry.kind) denied.resolve(change.value);
    }, end: () => {} });
    f.provider.setResponses([fauxAssistantMessage(fauxToolCall("command_output", { operationId: operation }), { stopReason: "toolUse" }), fauxAssistantMessage("Access denied")]);
    await f.engine.execute(request(), undefined, context);
    const entry = await awaitWithContext(denied.promise, withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), context));
    observation.detach();
    expect(JSON.stringify(entry.model)).toContain("does not belong to this goal");
    expect(broker.reads.length).toBe(reads); expect(broker.spawns).toBe(1);
  } finally { await f.close(); await broker.close(); }
});

it("reopens an interrupted output tool with its original committed page and no new broker read", async () => {
  const broker = new ProcessBroker(); const f = await fixture(broker);
  const prepared = Promise.withResolvers<void>(); const blocked = Promise.withResolvers<void>();
  const execute = f.jobs.outputTool.execute;
  f.jobs.outputTool.execute = async (...args) => {
    const result = await execute(...args); prepared.resolve();
    await awaitWithContext(blocked.promise, args[2]);
    return result;
  };
  f.provider.setResponses([call(f.root), () => fauxAssistantMessage(fauxToolCall("command_output", { operationId: [...broker.rows.keys()][0]!, encoding: "base64url" }), { stopReason: "toolUse" })]);
  const receipt = await f.engine.execute(request(), undefined, context);
  await awaitWithContext(prepared.promise, withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), context));
  const reads = broker.reads.length;
  await f.close();
  const reopened = await fixture(broker, f.root, true);
  reopened.provider.setResponses([(request) => {
    const result = request.messages.findLast((message) => message.role === "toolResult" && message.toolName === "command_output");
    if (result?.role !== "toolResult" || result.content[0]?.type !== "text") throw new Error("the original output result was not recovered");
    expect(result.isError).toBe(false);
    expect(Buffer.from(JSON.parse(result.content[0].text), "base64url")).toEqual(Buffer.from("€").subarray(0, 1));
    return fauxAssistantMessage("Original page recovered");
  }]);
  try {
    await reopened.engine.resume(context);
    await until(reopened, receipt.goalId, (goal) => goal.status === "completed");
    expect(broker.reads.length).toBe(reads); expect(broker.spawns).toBe(1);
    expect(reopened.errors).toEqual([]);
  } finally { await reopened.close(); await broker.close(); }
});

it("reopens the native tool at its durable cursor without changing the original process or request", async () => {
  const broker = new ProcessBroker(); broker.loseAcknowledgement = true;
  const f = await fixture(broker); f.provider.setResponses([call(f.root, true)]);
  const progressed = Promise.withResolvers<void>();
  const observation = f.harness.observeCommits({ advance: (commit) => {
    if (commit.changes.some((change) => change.type === "document" && change.kind === "change" && change.record.kind === "chopin.command-call" && typeof change.value.cursor === "string")) progressed.resolve();
  }, end: () => {} });
  const envelope = request(); const receipt = await f.engine.execute(envelope, undefined, context);
  await awaitWithContext(progressed.promise, withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), context));
  observation.detach(); await f.close();
  const original = [...broker.rows.values()][0]!; const pid = original.child!.pid;
  expect(original.child!.exitCode).toBeNull(); expect(broker.spawns).toBe(1);
  const reopened = await fixture(broker, f.root, true); reopened.provider.setResponses([fauxAssistantMessage("Done")]);
  try {
    const source = original.request.source;
    if (source.kind !== "tool") throw new Error("the original source is not a tool");
    const doc = await reopened.storage.findDocument({ kind: "chopin.command-call", scope: { kind: "task", taskId: source.taskId as import("@earendil-works/pi-durable").TaskId }, key: "command" }, "current", context);
    const stored = await reopened.storage.document(doc!.id, "current", context);
    const cursor = stored!.value.cursor;
    const readAt = broker.reads.length; broker.unavailable = 1;
    await reopened.engine.resume(context);
    original.child!.stdin!.end("resume\n");
    const goal = await until(reopened, receipt.goalId, (goal) => goal.status === "completed");
    expect(broker.reads[readAt]?.cursor).toBe(cursor);
    expect(original.child!.pid).toBe(pid); expect(broker.spawns).toBe(1); expect(broker.submits).toBe(1); expect(reopened.prepared()).toBe(0);
    expect(original.request.policyRevision).toBe("original");
    expect(await reopened.engine.request(envelope.requestId, context)).toEqual(receipt);
    expect(JSON.stringify((await toolEntries(reopened, goal))[0]!.model)).toContain("€begin\\noriginal");
    expect(await readFile(join(f.root, "runs"), "utf8")).toBe("run\n");
  } finally { original.child!.stdin?.end(); await reopened.close(); }
});

it("keeps stop pending while the real original process outcome cannot be observed", async () => {
  const broker = new ProcessBroker(); const f = await fixture(broker);
  f.provider.setResponses([call(f.root, true)]);
  const progressed = Promise.withResolvers<void>();
  const observation = f.harness.observeCommits({ advance: (commit) => {
    if (commit.changes.some((change) => change.type === "document" && change.kind === "change" && change.record.kind === "chopin.command-call" && typeof change.value.cursor === "string")) progressed.resolve();
  }, end: () => {} });
  try {
    const receipt = await f.engine.execute(request(), undefined, context);
    await awaitWithContext(progressed.promise, withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), context));
    broker.hideStop = true;
    const current = await f.engine.snapshot(receipt.goalId, context);
    await f.engine.execute({ version: 1, requestId: randomUUID(), command: { kind: "goal.stop", goalId: current.goalId, expectedVersion: current.version } }, undefined, context);
    await broker.stopped.promise;
    expect((await f.engine.snapshot(receipt.goalId, context)).status).toBe("stopping");
    broker.hideStop = false;
    const stopped = await until(f, receipt.goalId, (goal) => goal.status === "stopped");
    await f.jobs.settled(f.engine.store, stopped, context);
    expect(broker.spawns).toBe(1); expect([...broker.rows.values()][0]!.snapshot.state.outputComplete).toBe(true);
    expect(await readFile(join(f.root, "runs"), "utf8")).toBe("run\n");
  } finally { observation.detach(); broker.hideStop = false; await f.close(); await broker.close(); }
});

it("isolates owner commands and retains output access after read-only selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "chopin-command-service-"));
  const owners = ["first", "second"];
  const configured = new Map<string, { broker: ProcessBroker; models: ReturnType<typeof createModels>; provider: ReturnType<typeof fauxProvider> }>();
  for (const owner of owners) {
    await mkdir(join(root, owner));
    const provider = fauxProvider(); const models = createModels(); models.setProvider(provider.provider);
    configured.set(owner, { broker: new ProcessBroker(), models, provider });
  }
  const jobs = new Map<string, CommandJobs>(); const created: string[] = [];
  const patched = new Set<string>();
  const workspaceCommands = new Map<string, number>();
  const service = new AgentService({
    dataDir: join(root, "execution"), startPaused: true,
    workspaces: { list: async () => [], open: (owner) => {
      const workspace = localWorkspace(join(root, owner)).open(owner);
      return { ...workspace, command: (...args) => { workspaceCommands.set(owner, (workspaceCommands.get(owner) ?? 0) + 1); return workspace.command(...args); } };
    } },
    models: (owner) => configured.get(owner)!.models,
    extensions: async (owner) => {
      const command = new CommandJobs({ broker: configured.get(owner)!.broker, policy, report: (error) => { throw error; }, prepare: async (api, ctx) => ({
        goal: await (await service.goals(owner)).forExecution(api.conversationId, ctx), domain: configured.get(owner)!.broker.scope, policyRevision: "owner-policy", cwd: join(root, owner), inheritEnv: false,
      }) });
      jobs.set(owner, command); created.push(owner); return [command.extension];
    },
    agent: async (owner) => { const model = configured.get(owner)!.provider.getModel(); const command = jobs.get(owner)!.extension; return { model: { provider: model.provider, modelId: model.id }, extensions: patched.has(owner) ? { add: [command], remove: [defineExtension({ name: "chopin-mode" })] } : [command] }; },
    goals: (owner) => ({ authorize: async () => ({ allowed: true }),
      settled: async (goal, ctx) => jobs.get(owner)!.settled((await service.goals(owner)).store, goal, ctx), retryAfterMs: policy.pollAfterMs, report: (error) => { throw error; },
      review: async (input) => {
        expect(await readFile(join(root, owner, "runs"), "utf8")).toBe("run\n");
        const tool = (await input.entries(16)).items.find((entry) => entry.kind === ToolResultEntry.kind && entry.model?.some((message) => message.role === "toolResult" && message.toolName === "command" && !message.isError));
        if (tool === undefined) throw new Error("the original owner has no tool result");
        return { kind: "complete", summary: "Owner command completed", evidence: [{ kind: "tool", criterion: 0, entryId: Number(tool.id) }] };
      },
    }),
  });
  try {
    for (const owner of owners) {
      const f = configured.get(owner)!;
      await service.goals(owner);
      if (owner === "second") patched.add(owner);
      const outputObserved = Promise.withResolvers<TranscriptContext["messages"][number] | undefined>();
      const writeObserved = Promise.withResolvers<TranscriptContext["messages"][number] | undefined>();
      f.provider.setResponses([call(join(root, owner)), async () => {
        const [operation, row] = [...f.broker.rows.entries()][0]!;
        if (row.request.source.kind !== "tool") throw new Error("the original command has no tool source");
        const engine = await service.goals(owner);
        const conversation = (await engine.snapshot(row.request.source.goalId, context)).conversationId as ConversationId;
        await engine.store.harness.commit(async (tx) => { const mode = await tx.doc(ModeDoc, conversation); mode.mode = "read"; }, context);
        return fauxAssistantMessage(fauxToolCall("command_output", { operationId: operation, encoding: "base64url" }, { id: "read-original-output" }), { stopReason: "toolUse" });
      }, (request) => {
        const read = request.messages.findLast((message) => message.role === "toolResult" && message.toolName === "command_output");
        outputObserved.resolve(read);
        const attempt = call(join(root, owner)).content[0];
        if (attempt?.type !== "toolCall") throw new Error("the command attempt has no tool call");
        return fauxAssistantMessage({ ...attempt, id: "read-only-new-command" }, { stopReason: "toolUse" });
      }, (request) => {
        writeObserved.resolve(request.messages.findLast((message) => message.role === "toolResult" && message.toolName === "command"));
        return fauxAssistantMessage("Original output read without new execution");
      }]);
      const receipt = await service.executeGoal(owner, request(), context);
      const engine = await service.goals(owner);
      const read = await awaitWithContext(outputObserved.promise, withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), context));
      if (read?.role !== "toolResult" || read.content[0]?.type !== "text") throw new Error("the actual service did not return the original output page");
      expect(read.isError).toBe(false);
      expect(Buffer.from(JSON.parse(read.content[0].text), "base64url")).toEqual(Buffer.from("€").subarray(0, 1));
      const blocked = await awaitWithContext(writeObserved.promise, withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), context));
      if (blocked?.role !== "toolResult") throw new Error("the actual service did not reject the new command");
      expect(blocked.isError).toBe(true); expect(JSON.stringify(blocked.content)).toContain("read-only");
      const goal = await engine.snapshot(receipt.goalId, context);
      const original = [...f.broker.rows.values()][0]!.request;
      expect(original.source.kind === "tool" && original.source.goalId).toBe(goal.goalId);
      expect(original.cwd).toBe(join(root, owner)); expect(f.broker.spawns).toBe(1);
    }
    expect(created).toEqual(owners);
    expect(jobs.get("first")).not.toBe(jobs.get("second"));
    expect(workspaceCommands.get("first") ?? 0).toBe(0);
  } finally { await service.close(context); }
});

it("checks an adopted grant in the same local commit that records a new external intent", async () => {
  const broker = new ProcessBroker(); const f = await fixture(broker);
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); const ended = Promise.withResolvers<EntryRecord>();
  f.hooks.prepare = async () => { entered.resolve(); await release.promise; };
  const observation = f.harness.observeCommits({ advance: (commit) => {
    for (const change of commit.changes) if (change.type === "entry" && change.value.kind === ToolResultEntry.kind) ended.resolve(change.value);
  }, end: () => {} });
  f.provider.setResponses([call(f.root), fauxAssistantMessage("No command admitted")]);
  try {
    const receipt = await f.engine.execute(request(), undefined, context);
    await awaitWithContext(entered.promise, withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), context));
    const goal = await f.engine.snapshot(receipt.goalId, context);
    await f.engine.execute({ version: 1, requestId: randomUUID(), command: { kind: "goal.input", goalId: goal.goalId, expectedVersion: goal.version, text: "Adopt the replacement authority", grant: { id: randomUUID(), version: 2 } } }, undefined, context);
    release.resolve();
    const entry = await awaitWithContext(ended.promise, withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), context));
    expect(JSON.stringify(entry.model)).toContain("no longer admits this new command intent");
    expect(broker.spawns).toBe(0); expect(broker.rows.size).toBe(0);
    const current = await f.engine.store.snapshot(goal.goalId, context);
    expect(current.grant.version).toBe(2);
    await f.jobs.settled(f.engine.store, current, context);
  } finally { release.resolve(); observation.detach(); await f.close(); }
});

it("requests stop for every original operation even while another stop outcome is unavailable", async () => {
  const broker = new ProcessBroker(); const f = await fixture(broker);
  const prepared = Promise.withResolvers<void>(); const attempted = Promise.withResolvers<void>(); const seen = new Set<string>();
  const observation = f.harness.observeCommits({ advance: (commit) => {
    for (const change of commit.changes) if (change.type === "document" && change.kind === "change" && change.record.kind === "chopin.command-call" && typeof change.value.cursor === "string") seen.add(String(change.record.id));
    if (seen.size === 2) prepared.resolve();
  }, end: () => {} });
  const first = call(f.root, true).content[0]!;
  if (first.type !== "toolCall") throw new Error("the command fixture contains no tool call");
  f.provider.setResponses([fauxAssistantMessage([{ ...first, id: "first-operation" }, { ...first, id: "second-operation" }], { stopReason: "toolUse" })]);
  try {
    const receipt = await f.engine.execute(request(), undefined, context);
    await awaitWithContext(prepared.promise, withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), context));
    broker.hideStop = true; f.hooks.settled = () => attempted.resolve();
    const goal = await f.engine.snapshot(receipt.goalId, context);
    await f.engine.execute({ version: 1, requestId: randomUUID(), command: { kind: "goal.stop", goalId: goal.goalId, expectedVersion: goal.version } }, undefined, context);
    await awaitWithContext(attempted.promise, withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), context));
    expect(broker.rows.size).toBe(2);
    expect([...broker.rows.values()].every((row) => row.snapshot.state.stopRequested)).toBe(true);
    expect((await f.engine.snapshot(receipt.goalId, context)).status).toBe("stopping");
    broker.hideStop = false;
    await until(f, receipt.goalId, (goal) => goal.status === "stopped");
    expect(broker.spawns).toBe(2);
  } finally { observation.detach(); broker.hideStop = false; await f.close(); await broker.close(); }
});

it("does not confirm stop from primary exit while original output completion remains unconfirmed", async () => {
  const broker = new ProcessBroker(); broker.holdOutput = true;
  const f = await fixture(broker); f.provider.setResponses([call(f.root)]);
  const attempted = Promise.withResolvers<void>();
  try {
    const receipt = await f.engine.execute(request(), undefined, context);
    await awaitWithContext(broker.closed.promise, withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), context));
    const original = [...broker.rows.values()][0]!;
    expect(original.snapshot.state.primaryExit).toEqual({ kind: "code", value: 0 });
    expect(original.snapshot.state.outputComplete).toBe(false);
    f.hooks.settled = () => attempted.resolve();
    const goal = await f.engine.snapshot(receipt.goalId, context);
    await f.engine.execute({ version: 1, requestId: randomUUID(), command: { kind: "goal.stop", goalId: goal.goalId, expectedVersion: goal.version } }, undefined, context);
    await awaitWithContext(attempted.promise, withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), context));
    await expect(f.jobs.settled(f.engine.store, await f.engine.snapshot(receipt.goalId, context), context)).rejects.toThrow("not drained");
    expect((await f.engine.snapshot(receipt.goalId, context)).status).toBe("stopping");
    broker.releaseOutput(); await until(f, receipt.goalId, (goal) => goal.status === "stopped");
  } finally { broker.releaseOutput(); await f.close(); await broker.close(); }
});
