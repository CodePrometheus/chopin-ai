import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import { copyJson } from "@earendil-works/chord/json";
import { defineDocFamily, defineExtension, defineTool, type ConversationId, type Cursor, type Harness, type Storage, type TaskId, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { CommandRefusal, isJobRequest, JobIdSchema, JobOutputSchema, JobRequestSchema, JobSnapshotSchema, type CommandBroker, type JobOutput, type JobRequest, type JobSnapshot } from "./jobs.js";
import { appendCommandOutput, commandOutput, commandOutputPrefix, emptyCommandOutput, type CommandOutputState } from "./commands-output.js";
import { terminal, type GoalSnapshot, type PublishedArtifact } from "./goals/contracts.js";
import { GoalDoc, requireSnapshot } from "./goals/store.js";
import { ArtifactContentDoc, ArtifactDoc, ArtifactToolSchema, CAPTURE_HEADER_BYTES, MAX_ARTIFACT_PAGE_BYTES, READ_ARTIFACT, artifactDigest, artifactPageKey, artifactPath, capturedArtifact } from "./goals/artifact.js";

const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const limit = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 4 });
export const CommandPolicySchema = Type.Object({
  pollAfterMs: positive, outputPageBytes: positive, scanPageSize: positive,
  output: Type.Object({ maxBytes: limit, maxLines: limit }, { additionalProperties: false }),
  artifactMaxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER - CAPTURE_HEADER_BYTES })),
}, { additionalProperties: false });
export type CommandPolicy = Static<typeof CommandPolicySchema>;
export const CommandInputSchema = Type.Object({
  argv: JobRequestSchema.properties.argv,
  cwd: Type.Optional(JobRequestSchema.properties.cwd),
  env: Type.Optional(JobRequestSchema.properties.env),
  inheritEnv: Type.Optional(Type.Boolean()),
  timeoutMs: Type.Optional(positive),
  artifact: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });
export type CommandInput = Static<typeof CommandInputSchema>;
export const CommandResultSchema = Type.Object({ operationId: JobIdSchema, output: Type.String(), truncated: Type.Boolean(), exit: JobSnapshotSchema.properties.state.properties.primaryExit, stopRequested: Type.Boolean(), artifact: Type.Optional(ArtifactToolSchema) }, { additionalProperties: false });
export type CommandResult = Static<typeof CommandResultSchema>;
export const CommandOutputInputSchema = Type.Object({ operationId: JobIdSchema, cursor: Type.Optional(Type.String({ minLength: 1 })), encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64url")])) }, { additionalProperties: false });
export type CommandOutputInput = Static<typeof CommandOutputInputSchema>;
export const CommandOutputResultSchema = Type.Object({ operationId: JobIdSchema, ...JobOutputSchema.properties }, { additionalProperties: false });
export type CommandOutputResult = Static<typeof CommandOutputResultSchema>;
type Intent = { operationId: string; goalConversationId: number; request: JobRequest; policy: CommandPolicy };
type CallState = { input: CommandInput | null; intent: Intent | null; cursor: string | null; output: CommandOutputState; result: CommandResult | null };
type PendingState = { intent: Intent | null; taskId: number | null };
const ARTIFACT_CAPTURE = "artifact-capture";

const CallDoc = defineDocFamily<CallState, null>({
  kind: "chopin.command-call", version: 1, scope: "task", family: true,
  initial: () => ({ input: null, intent: null, cursor: null, output: emptyCommandOutput(), result: null }), checkpointWhen: () => true,
});
const PendingDoc = defineDocFamily<PendingState, null>({
  kind: "chopin.command-pending", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true,
  initial: () => ({ intent: null, taskId: null }), checkpointWhen: () => true,
});
const OperationDoc = defineDocFamily<{ goalId: string | null; taskId: number | null }, null>({
  kind: "chopin.command-operation", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true,
  initial: () => ({ goalId: null, taskId: null }), checkpointWhen: () => true,
});
const ReadDoc = defineDocFamily<{ input: CommandOutputInput | null; goalId: string | null; limit: number; result: CommandOutputResult | null }, null>({
  kind: "chopin.command-output-read", version: 1, scope: "task", family: true,
  initial: () => ({ input: null, goalId: null, limit: 0, result: null }), checkpointWhen: () => true,
});

export interface CommandJobsOptions {
  broker: CommandBroker;
  policy: CommandPolicy;
  /** Trusted binding; requested arguments remain subject to the broker's actual resource policy. */
  prepare(api: ToolExecutionApi, context: Context): Promise<{ goal: GoalSnapshot; domain: string; policyRevision: string; cwd: string; inheritEnv: boolean }>;
  report(error: unknown): void;
}

/** Native tool replay reattaches to a durable original operation, not a new command execution. */
export class CommandJobs {
  readonly extension;
  readonly tool;
  readonly outputTool;
  readonly #options: CommandJobsOptions;
  readonly #policy: CommandPolicy;
  readonly #running = new Map<string, { input: CommandInput; promise: Promise<CommandResult> }>();

  constructor(options: CommandJobsOptions) {
    if (!Value.Check(CommandPolicySchema, options.policy)) throw new Error("an explicit command observation and output policy is required");
    this.#options = options;
    this.#policy = structuredClone(options.policy);
    this.tool = defineTool({
      name: "command", replay: "safe",
      description: "Execute an argument vector in the authorized workspace. To deliver one file, declare its workspace-relative path in artifact on the command that creates it. Interrupted calls recover the original operation and output. A timeout is in milliseconds; no timeout is added when absent.",
      parameters: CommandInputSchema,
      structuredOutputSchema: CommandResultSchema,
      outputLimits: { ...this.#policy.output, retain: "tail" },
      execute: async (input, api, context) => {
        if (input.artifact !== undefined && (!artifactPath(input.artifact) || this.#policy.artifactMaxBytes === undefined)) {
          throw new Error("artifact publication is unavailable for the declared path");
        }
        const result = await this.run(api, "command", input, context);
        if (input.artifact !== undefined && successful(result)) {
          result.artifact = await this.#publish(api, input.artifact, result, context);
        }
        return { output: [{ type: "text", text: result.output }], structuredOutput: result,
          isError: !successful(result),
          diagnostics: [
            { severity: "info", code: "command_result", message: JSON.stringify({ operationId: result.operationId, exit: result.exit, stopRequested: result.stopRequested }) },
            ...(result.truncated ? [{ severity: "info" as const, code: "command_output", message: `Read complete output with command_output for operation ${result.operationId}` }] : []),
          ],
        };
      },
    });
    this.outputTool = defineTool({
      name: "command_output", replay: "safe",
      description: "Read one retained output page from a command belonging to this goal. Start without a cursor and pass the returned cursor until complete. UTF-8 previews may split characters; base64url preserves every byte. Incomplete empty pages can be read again later.",
      parameters: CommandOutputInputSchema, structuredOutputSchema: CommandOutputResultSchema,
      outputLimits: { ...this.#policy.output, retain: "head" },
      execute: async (input, api, context) => {
        const result = await this.readOutput(api, input, context);
        const data = input.encoding === "base64url" ? result.data : Buffer.from(result.data, "base64url").toString("utf8");
        return { output: [{ type: "text", text: JSON.stringify(data) }], structuredOutput: result,
          diagnostics: [{ severity: "info", code: "command_output_page", message: JSON.stringify({ operationId: result.operationId, stream: result.stream, cursor: result.cursor, complete: result.complete, encoding: input.encoding ?? "utf8" }) }],
        };
      },
    });
    this.extension = defineExtension({ name: "chopin-command-jobs", tools: [this.tool, this.outputTool] });
  }

  /** A direct retained association authorizes reads without scanning historical tool tasks. */
  async readOutput(api: ToolExecutionApi, input: CommandOutputInput, context: Context): Promise<CommandOutputResult> {
    const original = copyJson(input, { omitUndefinedProperties: true });
    if (!Value.Check(CommandOutputInputSchema, original)) throw new Error("command output input does not satisfy its declared contract");
    const binding = await this.#options.prepare(api, context);
    const operation = await api.snapshot(OperationDoc, binding.goal.conversationId as ConversationId, input.operationId, context);
    if (operation?.goalId !== binding.goal.goalId || operation.taskId === null) throw new Error("the command does not belong to this goal");
    let state = await api.snapshot(ReadDoc, api.taskId, "page", context);
    if (state === undefined) {
      // JSON escaping costs at most six bytes per source byte, plus two quotes; metadata is a diagnostic.
      const limit = Math.min(this.#policy.outputPageBytes, Math.floor((this.#policy.output.maxBytes - 2) / 6));
      if (limit < 1 || this.#policy.output.maxLines < 1) throw new Error("the configured output window cannot hold a command output page");
      await api.commit(async (tx) => {
        const read = await tx.doc(ReadDoc, api.taskId, "page", null);
        if (read.input === null) { read.input = original; read.goalId = binding.goal.goalId; read.limit = limit; }
      }, context);
      state = await api.snapshot(ReadDoc, api.taskId, "page", context);
    }
    if (state?.input === null || state === undefined || !isDeepStrictEqual(state.input, original) || state.goalId !== binding.goal.goalId || state.limit < 1) throw new Error("the original command output read is missing or changed");
    if (state.result !== null) return structuredClone(state.result);
    const page = await this.#options.broker.output(input.operationId, state.limit, input.cursor, context.abortSignal);
    const bytes = Buffer.from(page.data, "base64url");
    if (!Value.Check(JobOutputSchema, page) || bytes.toString("base64url") !== page.data || bytes.length > state.limit || page.data !== "" && (page.cursor === input.cursor || page.stream === null)) throw new Error("the command output page does not satisfy its original read");
    const result = { operationId: input.operationId, ...page };
    await api.commit(async (tx) => { const read = await tx.doc(ReadDoc, api.taskId, "page", null); read.result ??= result; }, context);
    const committed = await api.snapshot(ReadDoc, api.taskId, "page", context);
    if (committed?.result === null || committed?.result === undefined) throw new Error("the original command output page was not committed");
    return structuredClone(committed.result);
  }

  /** A stable key names one effect of this tool invocation, including a resumed invocation. */
  run(api: ToolExecutionApi, key: string, input: CommandInput, context: Context): Promise<CommandResult> {
    const original = copyJson(input, { omitUndefinedProperties: true });
    if (!Value.Check(CommandInputSchema, original) || original.argv[0] === "") return Promise.reject(new Error("command input does not satisfy its declared contract"));
    const id = `${api.taskId}:${key}`;
    const active = this.#running.get(id);
    if (active !== undefined) {
      if (!isDeepStrictEqual(active.input, original)) return Promise.reject(new Error("the command key already names different arguments"));
      return active.promise;
    }
    const promise = this.#run(api, key, original, context);
    this.#running.set(id, { input: original, promise });
    void promise.finally(() => this.#running.delete(id)).catch(() => {});
    return promise;
  }

  /** An orphaned tool cannot make its external operation disappear from completion or stop checks. */
  async settled(execution: { harness: Harness; storage: Storage }, goal: GoalSnapshot, context: Context): Promise<void> {
    const { storage } = execution;
    const conversation = goal.conversationId as ConversationId;
    let cursor: Cursor | undefined;
    let failure: unknown;
    do {
      const page = await storage.scanDocuments({ scope: { kind: "conversation", conversationId: conversation }, at: "current", kind: PendingDoc.definition.kind }, this.#policy.scanPageSize, cursor, context);
      for (const record of page.items) {
        try {
          if (record.key === undefined) throw new Error("the pending command has no original identity");
          await this.#settle(execution, goal, record.key, context);
        } catch (error) { context.abortSignal?.throwIfAborted(); failure ??= error; }
      }
      cursor = page.next;
    } while (cursor !== undefined);
    if (failure !== undefined) throw failure;
  }

  async #settle({ harness, storage }: { harness: Harness; storage: Storage }, goal: GoalSnapshot, key: string, context: Context): Promise<void> {
    const conversation = goal.conversationId as ConversationId;
    const pending = await harness.snapshot(PendingDoc, conversation, key, context);
    const intent = pending?.intent;
    if (pending === undefined || intent === null || intent === undefined || pending.taskId === null || intent.operationId !== key || intent.goalConversationId !== goal.conversationId || intent.request.source.kind !== "tool" || intent.request.source.goalId !== goal.goalId || intent.request.source.taskId !== pending.taskId) throw new Error("the pending command binding is incomplete");
    const task = await storage.task(pending.taskId as TaskId, context);
    if (task === undefined) throw new Error("the original command tool is missing");
    if (task.state.status !== "terminal") throw new Error("the original command tool remains active");
    const observed = await this.#options.broker.cancel(intent.operationId, intent.request, context.abortSignal);
    if (observed.operationId !== intent.operationId || !drained(observed)) throw new Error("the original command or its output is not drained");
    await harness.commit((tx) => tx.retireDoc(PendingDoc, conversation, key), context);
  }

  async #publish(api: ToolExecutionApi, path: string, original: CommandResult, context: Context): Promise<PublishedArtifact> {
    const source = await api.snapshot(CallDoc, api.taskId, "command", context);
    const intent = source?.intent;
    if (intent?.request.source.kind !== "tool" || source?.input?.artifact !== path
      || intent.operationId !== original.operationId || source.result === null || !successful(source.result)) {
      throw new Error("artifact lacks its original successful command");
    }
    const goalId = intent.request.source.goalId;
    const saved = (await api.snapshot(ArtifactDoc, goalId, context))?.published.find((item) => item.metadata.operationId === original.operationId);
    if (saved !== undefined) {
      if (saved.path !== path) throw new Error("the original command already published a different artifact");
      return saved.metadata;
    }
    const binding = await this.#options.prepare(api, context);
    if (binding.goal.goalId !== goalId || binding.domain !== intent.request.domain
      || !isDeepStrictEqual(binding.goal.grant, intent.request.grant)) throw new Error("artifact capture authority changed");
    const maximum = intent.policy.artifactMaxBytes;
    if (maximum === undefined) throw new Error("the original command has no artifact byte limit");
    const capture = await this.run(api, ARTIFACT_CAPTURE, {
      argv: ["python3", "-I", "-S", "-c", READ_ARTIFACT, path, String(maximum)],
      cwd: binding.cwd, inheritEnv: false,
      ...(intent.request.timeoutMs == null ? {} : { timeoutMs: intent.request.timeoutMs }),
    }, context);
    if (!successful(capture)) throw new Error("the declared artifact could not be captured");
    const raw = await this.#artifactBytes(capture.operationId, maximum + CAPTURE_HEADER_BYTES, intent.policy.outputPageBytes, context);
    const {version, bytes} = capturedArtifact(raw, maximum);
    const artifactId = capture.operationId;
    const name = path.slice(path.lastIndexOf("/") + 1);
    const metadata = { artifactId, goalId, operationId: original.operationId, name, sha256: artifactDigest(bytes), sizeBytes: bytes.length };
    const pageBytes = Math.min(intent.policy.outputPageBytes, MAX_ARTIFACT_PAGE_BYTES);
    const publication = { metadata, path, captureOperationId: capture.operationId,
      sourceTaskId: intent.request.source.taskId, version, pageBytes };
    return api.commit(async (tx) => {
      const record = await tx.doc(GoalDoc, goalId, null);
      const current = requireSnapshot(record);
      if (record.stop || terminal(current.status) || !isDeepStrictEqual(current.grant, intent.request.grant)) {
        throw new Error("the goal no longer admits artifact publication");
      }
      const artifact = await tx.doc(ArtifactDoc, goalId, null);
      const existing = artifact.published.find((item) => item.metadata.operationId === original.operationId || item.metadata.artifactId === artifactId);
      if (existing !== undefined) {
        if (!isDeepStrictEqual(existing, publication)) {
          throw new Error("the existing goal artifact cannot be replaced");
        }
        return existing.metadata;
      }
      let offset = 0;
      do {
        const page = await tx.doc(ArtifactContentDoc, artifactPageKey(artifactId, offset), null);
        if (page.data !== null) throw new Error("the artifact page identity has already been used");
        const end = Math.min(offset + pageBytes, bytes.length);
        page.data = bytes.subarray(offset, end).toString("base64url");
        offset = end;
      } while (offset < bytes.length);
      artifact.published.push(publication);
      return metadata;
    }, context);
  }

  async #artifactBytes(operation: string, maximum: number, pageBytes: number, context: Context): Promise<Buffer> {
    let cursor: string | undefined;
    let size = 0;
    const chunks: Buffer[] = [];
    for (;;) {
      context.abortSignal?.throwIfAborted();
      const limit = Math.min(pageBytes, maximum - size + 1);
      const page = await this.#options.broker.output(operation, limit, cursor, context.abortSignal);
      const bytes = Buffer.from(page.data, "base64url");
      if (!Value.Check(JobOutputSchema, page) || bytes.toString("base64url") !== page.data || bytes.length > limit
        || (bytes.length > 0 ? page.stream !== "stdout" || page.cursor === cursor : !page.complete || page.stream !== null)) {
        throw new Error("artifact capture returned incomplete or invalid output");
      }
      size += bytes.length;
      if (size > maximum) throw new Error("artifact capture exceeds the byte limit");
      if (bytes.length > 0) chunks.push(bytes);
      if (page.complete) return Buffer.concat(chunks, size);
      cursor = page.cursor;
    }
  }

  async #run(api: ToolExecutionApi, key: string, input: CommandInput, context: Context): Promise<CommandResult> {
    let state = await api.snapshot(CallDoc, api.taskId, key, context);
    const capture = key === ARTIFACT_CAPTURE;
    if (state === undefined) {
      const binding = await this.#options.prepare(api, context);
      const intent: Intent = {
        operationId: randomUUID(), goalConversationId: binding.goal.conversationId, policy: structuredClone(this.#policy),
        request: { version: 1, domain: binding.domain, policyRevision: binding.policyRevision,
          source: { kind: "tool", goalId: binding.goal.goalId, conversationId: Number(api.conversationId), taskId: Number(api.taskId), callId: api.callId },
          grant: structuredClone(binding.goal.grant), argv: [...input.argv], cwd: input.cwd ?? binding.cwd, env: { ...input.env }, inheritEnv: input.inheritEnv ?? binding.inheritEnv, timeoutMs: input.timeoutMs ?? null,
        },
      };
      if (!isJobRequest(intent.request)) throw new Error("the trusted command binding does not satisfy its declared contract");
      await api.commit(async (tx) => {
        if (capture) {
          const original = await tx.doc(CallDoc, api.taskId, "command", null);
          if (original.intent === null || original.result === null || original.input?.artifact === undefined
            || !successful(original.result) || original.intent.request.domain !== intent.request.domain
            || !isDeepStrictEqual(original.intent.request.source, intent.request.source)
            || !isDeepStrictEqual(original.intent.request.grant, intent.request.grant)) {
            throw new Error("artifact capture does not share the original command authority");
          }
        }
        const call = await tx.doc(CallDoc, api.taskId, key, null);
        if (call.intent !== null) {
          if (!isDeepStrictEqual(call.input, input)) throw new Error("the command key already names different arguments");
          return;
        }
        const record = await tx.doc(GoalDoc, binding.goal.goalId, null);
        const current = requireSnapshot(record);
        if (record.stop || terminal(current.status) || current.conversationId !== intent.goalConversationId || !isDeepStrictEqual(current.grant, intent.request.grant)) throw new Error("the current goal no longer admits this new command intent");
        const pending = await tx.doc(PendingDoc, intent.goalConversationId as ConversationId, intent.operationId, null);
        const operation = await tx.doc(OperationDoc, intent.goalConversationId as ConversationId, intent.operationId, null);
        operation.goalId = binding.goal.goalId; operation.taskId = Number(api.taskId);
        call.input = input; call.intent = intent; pending.intent = intent; pending.taskId = Number(api.taskId);
      }, context);
      state = await api.snapshot(CallDoc, api.taskId, key, context);
    }
    if (state?.intent === null || state?.intent === undefined || !isDeepStrictEqual(state.input, input)) throw new Error("the original command intent is missing or changed");
    const source = state.intent.request.source;
    if (source.kind !== "tool" || source.taskId !== Number(api.taskId) || source.conversationId !== Number(api.conversationId) || source.callId !== api.callId) throw new Error("the original command belongs to another invocation");
    if (state.result !== null) return structuredClone(state.result);
    const intent = state.intent;
    if (!capture) api.output(state.output.window, commandOutputPrefix(state.output));
    let retained = false;
    while (true) {
      context.abortSignal?.throwIfAborted();
      let snapshot: JobSnapshot;
      let pages: JobOutput[];
      try {
        if (retained) snapshot = await this.#options.broker.reconcile(intent.operationId, context.abortSignal);
        else {
          const existing = await this.#options.broker.get(intent.operationId, context.abortSignal);
          snapshot = existing === undefined ? await this.#options.broker.submit(intent.operationId, intent.request, context.abortSignal)
            : drained(existing) ? existing : await this.#options.broker.reconcile(intent.operationId, context.abortSignal);
          retained = true;
        }
        if (snapshot.operationId !== intent.operationId) throw new Error("the command observation names another operation");
        pages = capture || state.output.complete || snapshot.state.lastSequence === 0 && !snapshot.state.outputComplete ? [] : await this.#pages(intent, state.cursor, context);
      } catch (error) {
        context.abortSignal?.throwIfAborted();
        if (error instanceof CommandRefusal && error.status >= 400 && error.status < 500) throw error;
        this.#report(error);
        await pause(intent.policy.pollAfterMs, context);
        continue;
      }
      const output: CommandOutputState = structuredClone(state.output);
      let cursor: string | null = state.cursor;
      let delta = "";
      for (const page of pages) { delta += appendCommandOutput(output, page, intent.policy.output); cursor = page.cursor; }
      const rendered = commandOutput(output, intent.policy.output);
      const result: CommandResult | null = drained(snapshot) && (capture || output.complete) ? {
        operationId: intent.operationId, output: rendered.text,
        truncated: rendered.truncated,
        exit: structuredClone(snapshot.state.primaryExit), stopRequested: snapshot.state.stopRequested,
      } : null;
      if (result === null && cursor === state.cursor && isDeepStrictEqual(output, state.output)) { await pause(intent.policy.pollAfterMs, context); continue; }
      // Cursor, decoded window and external completion retire together, before progress or results become visible.
      await api.commit(async (tx) => {
        const call = await tx.doc(CallDoc, api.taskId, key, null);
        call.cursor = cursor; call.output = output; call.result = result;
        if (result !== null) await tx.retireDoc(PendingDoc, intent.goalConversationId as ConversationId, intent.operationId);
      }, context);
      if (!capture) api.output(delta);
      if (result !== null) return result;
      state = { ...state, output, cursor, result };
      if (pages.length === 0 || pages.at(-1)?.data === "") await pause(intent.policy.pollAfterMs, context);
    }
  }

  async #pages(intent: Intent, cursor: string | null, context: Context): Promise<JobOutput[]> {
    const pages: JobOutput[] = [];
    let bytes = 0;
    while (bytes < intent.policy.outputPageBytes) {
      const page = await this.#options.broker.output(intent.operationId, intent.policy.outputPageBytes - bytes, cursor ?? undefined, context.abortSignal);
      if (page.data !== "" && page.cursor === cursor) throw new Error("command output did not advance its original cursor");
      pages.push(page); bytes += Buffer.from(page.data, "base64url").length; cursor = page.cursor;
      if (page.complete || page.data === "") break;
    }
    return pages;
  }

  #report(error: unknown): void { try { this.#options.report(error); } catch { /* Reporting cannot change an operation's outcome. */ } }
}

function drained(snapshot: JobSnapshot): boolean { return snapshot.state.phase === "drained" && snapshot.state.outputComplete; }
function successful(result: CommandResult): boolean { return !result.stopRequested && result.exit?.kind === "code" && result.exit.value === 0; }

async function pause(milliseconds: number, context: Context): Promise<void> {
  let remaining = milliseconds;
  while (remaining > 0) {
    const started = performance.now();
    await delay(Math.min(remaining, 0x7fff_ffff), undefined, { signal: context.abortSignal });
    remaining -= performance.now() - started;
  }
}
