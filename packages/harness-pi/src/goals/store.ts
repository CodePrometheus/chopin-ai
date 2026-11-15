import { isDeepStrictEqual } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import { AgentDoc, configure, defineDoc, defineDocFamily, ROOT_CONVERSATION_ID, type AgentChange, type ConversationId, type Cursor, type Harness, type Storage, type Task, type TaskId, type Tx } from "@earendil-works/pi-durable";
import type { Draft } from "@earendil-works/chord/delta";
import { refusal } from "../service-error.js";
import { terminal, validateCommand, type EngineCommand, type EngineReceipt, type GoalCommand, type GoalPage, type GoalSnapshot } from "./contracts.js";

/** Checkpoints are execution-owned; clients never write them directly. */
export type GoalCheckpoint = { phase: "dispatch" } | { phase: "run"; submission: number } | { phase: "wait"; resume?: { phase: "run"; submission: number } | { phase: "dispatch" } };
export type GoalOutcome = { goalId: string };
export type GoalTask = Task<{ goalId: string }, GoalCheckpoint, GoalOutcome, object>;
export type GoalInput = { requestId: string; text: string; origin: "owner" | "driver" };
export type GoalBlock = { status: "waiting_authorization" | "waiting_dependency"; reason: string; until?: number };
export type GoalRecord = {
  snapshot: GoalSnapshot | null;
  driver: number | null;
  pending: GoalInput[];
  stop: boolean;
  blocks: Record<string, GoalBlock>;
};
type RequestRecord = { envelope: EngineCommand | null; receipt: EngineReceipt | null };

export const GoalDoc = defineDocFamily<GoalRecord, null>({
  kind: "chopin.goal", version: 1, scope: "session", family: true,
  initial: () => ({ snapshot: null, driver: null, pending: [], stop: false, blocks: {} }),
  checkpointWhen: () => true,
});
export const RequestDoc = defineDocFamily<RequestRecord, null>({
  kind: "chopin.goal-request", version: 1, scope: "session", family: true,
  initial: () => ({ envelope: null, receipt: null }),
  checkpointWhen: () => true,
});
/** Transactional projection preventing an unfinished goal with a failed driver from appearing idle. */
export const ActiveGoals = defineDoc<{ count: number }>({ kind: "chopin.goal-active", version: 1, scope: "session", initial: () => ({ count: 0 }), checkpointWhen: () => true });
/** A goal's visible conversation; forks start without inheriting another goal's authority. */
export const GoalBinding = defineDoc<{ goalId: string | null }>({
  kind: "chopin.goal-binding", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ goalId: null }), checkpointWhen: () => false,
});

/** Atomic command admission over the execution store, without a platform-owned goal state machine. */
export class GoalStore {
  readonly harness: Harness;
  readonly storage: Storage;
  readonly driver: GoalTask;
  readonly #required: readonly string[];
  constructor(harness: Harness, storage: Storage, driver: GoalTask, required: readonly string[] = []) { this.harness = harness; this.storage = storage; this.driver = driver; this.#required = required; }

  /** Only a successful read returning no request establishes absence. */
  async request(id: string, context: Context): Promise<EngineReceipt | undefined> {
    return (await this.harness.snapshot(RequestDoc, id, context))?.receipt ?? undefined;
  }

  /** Repeated requests reconcile their exact original command before checking the goal's newer version. */
  async replay(envelope: EngineCommand, context: Context): Promise<EngineReceipt | undefined> {
    validateCommand(envelope);
    const record = await this.harness.snapshot(RequestDoc, envelope.requestId, context);
    if (record?.receipt == null) return undefined;
    if (!isDeepStrictEqual(record.envelope, envelope)) throw refusal("request_conflict", "request identity already names different content");
    return structuredClone(record.receipt);
  }

  /** Authority is checked by the caller; admission commits all local facts together before returning. */
  async execute(envelope: EngineCommand, agent: AgentChange | undefined, context: Context): Promise<EngineReceipt> {
    validateCommand(envelope);
    await this.harness.root(context);
    return this.harness.commit(async (tx) => {
      const request = await tx.doc(RequestDoc, envelope.requestId, null);
      if (request.receipt !== null) {
        if (!isDeepStrictEqual(request.envelope, envelope)) throw refusal("request_conflict", "request identity already names different content");
        return { ...request.receipt };
      }
      const command = envelope.command;
      const record = command.kind === "goal.submit"
        ? await this.#submit(tx, envelope.requestId, command, agent)
        : await this.#control(tx, envelope.requestId, command);
      const snapshot = requireSnapshot(record);
      const receipt: EngineReceipt = { version: 1, requestId: envelope.requestId, goalId: snapshot.goalId, acceptedVersion: snapshot.version };
      request.envelope = structuredClone(envelope);
      request.receipt = receipt;
      return structuredClone(receipt);
    }, context);
  }

  async #submit(tx: Tx, goalId: string, command: Extract<GoalCommand, { kind: "goal.submit" }>, agent: AgentChange | undefined): Promise<Draft<GoalRecord>> {
    const record = await tx.doc(GoalDoc, goalId, null);
    if (record.snapshot !== null) throw refusal("request_conflict", "goal identity is already in use");
    let source: { conversation: ConversationId; entry: import("@earendil-works/pi-durable").EntryId } | undefined;
    if (command.continuation !== undefined) {
      const previous = requireSnapshot(await tx.doc(GoalDoc, command.continuation.goalId, null));
      if (previous.version !== command.continuation.expectedVersion) throw refusal("goal_conflict", "source goal version changed");
      if (!terminal(previous.status)) throw refusal("goal_conflict", "continuation requires a terminal source goal");
      const conversation = previous.conversationId as ConversationId;
      const entry = await tx.latestEntryId(conversation);
      if (entry === undefined) throw refusal("goal_conflict", "source goal has no committed context to continue");
      source = { conversation, entry };
    }
    const driver = await tx.createTask(this.driver, { goalId }, { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID });
    const ownership = { kind: "task" as const, taskId: driver };
    const conversation = source === undefined
      ? await tx.createConversation({ ownership })
      : await tx.forkConversation(source.conversation, source.entry, { ownership });
    if (agent !== undefined) await configure(tx, conversation.id, agent);
    if (this.#required.length > 0) {
      const state = await tx.doc(AgentDoc, conversation.id);
      if (Array.isArray(state.extensions)) {
        for (const name of this.#required) if (!state.extensions.includes(name)) state.extensions.push(name);
      } else {
        state.extensions = {
          add: [...new Set([...(state.extensions?.add ?? []), ...this.#required])],
          remove: (state.extensions?.remove ?? []).filter((name) => !this.#required.includes(name)),
        };
      }
    }
    (await tx.doc(GoalBinding, conversation.id)).goalId = goalId;
    const now = Date.now();
    record.snapshot = {
      goalId, conversationId: Number(conversation.id), version: 1, objective: command.objective,
      completionCriteria: [...command.completionCriteria], status: "accepted", grant: structuredClone(command.grant),
      createdAt: now, updatedAt: now,
    };
    record.driver = Number(driver);
    const active = await tx.doc(ActiveGoals);
    if (!Number.isSafeInteger(active.count) || active.count < 0 || active.count >= Number.MAX_SAFE_INTEGER) throw refusal("goal_binding", "goal activity projection is invalid");
    active.count++;
    record.pending.push({ requestId: goalId, text: command.objective, origin: "owner" });
    return record;
  }

  async #control(tx: Tx, requestId: string, command: Exclude<GoalCommand, { kind: "goal.submit" }>): Promise<Draft<GoalRecord>> {
    const record = await tx.doc(GoalDoc, command.goalId, null);
    const snapshot = requireSnapshot(record);
    if (snapshot.version !== command.expectedVersion) throw refusal("goal_conflict", "goal version changed");
    if (terminal(snapshot.status)) throw refusal("goal_terminal", "the original goal is terminal; submit an explicit continuation");
    if (command.kind === "goal.stop") {
      record.stop = true;
      snapshot.status = "stopping";
      delete snapshot.waiting;
    } else {
      if (record.stop) throw refusal("goal_stopping", "stop intent already bars further input");
      if (command.questionId !== snapshot.waiting?.questionId) throw refusal("question_conflict", "input does not match the original pending question");
      if (command.grant !== undefined) snapshot.grant = structuredClone(command.grant);
      record.pending.push({ requestId, text: command.text, origin: "owner" });
      if (snapshot.status !== "waiting_authorization" || command.grant !== undefined) {
        if (snapshot.status !== "accepted") snapshot.status = "running";
        delete snapshot.waiting;
      }
      if (Object.keys(record.blocks).length > 0) reflectBlocks(record);
    }
    bump(snapshot);
    return record;
  }

  /** Returns the execution-owned snapshot without manufacturing state from task liveness. */
  async snapshot(goalId: string, context: Context): Promise<GoalSnapshot> {
    return structuredClone(requireSnapshot(await this.harness.snapshot(GoalDoc, goalId, context)));
  }

  async forConversation(conversation: ConversationId, context: Context): Promise<GoalSnapshot | undefined> {
    const binding = await this.harness.snapshot(GoalBinding, conversation, context);
    if (binding?.goalId == null) return undefined;
    const snapshot = await this.snapshot(binding.goalId, context);
    if (snapshot.conversationId !== Number(conversation)) throw refusal("goal_binding", "conversation does not match its goal");
    return snapshot;
  }

  /** Preserve source ordering and cursors; this method does not collect the whole owner's history. */
  async page(limit: number, cursor: Cursor | undefined, context: Context): Promise<GoalPage> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw refusal("invalid_command", "page size must be a positive safe integer");
    const page = await this.storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind: GoalDoc.definition.kind }, limit, cursor, context);
    const goals = await Promise.all(page.items.map(async (record) => {
      if (record.key === undefined) throw refusal("goal_binding", "goal record has no identity");
      return this.snapshot(record.key, context);
    }));
    return { goals, ...(page.next === undefined ? {} : { cursor: page.next }) };
  }

  async driverId(goalId: string, context: Context): Promise<TaskId<GoalOutcome>> {
    const record = await this.harness.snapshot(GoalDoc, goalId, context);
    requireSnapshot(record);
    if (record?.driver == null) throw refusal("goal_binding", "goal has no original driver");
    return record.driver as TaskId<GoalOutcome>;
  }
  async active(context: Context): Promise<boolean> {
    const active = await this.harness.snapshot(ActiveGoals, context);
    if (active === undefined) {
      const present = await this.storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind: GoalDoc.definition.kind }, 1, undefined, context);
      if (present.items.length !== 0) throw refusal("goal_binding", "goal activity projection is missing");
      return false;
    }
    if (!Number.isSafeInteger(active.count) || active.count < 0) throw refusal("goal_binding", "goal activity projection is invalid");
    return active.count > 0;
  }
}

export function requireSnapshot(record: Readonly<GoalRecord> | undefined): GoalSnapshot {
  if (record?.snapshot == null) throw refusal("unknown_goal", "goal does not exist");
  return record.snapshot;
}
export function bump(snapshot: GoalSnapshot): void {
  if (snapshot.version >= Number.MAX_SAFE_INTEGER) throw refusal("goal_conflict", "goal revision cannot be represented");
  snapshot.version++;
  snapshot.updatedAt = Date.now();
}

/** Merge independent task waits without letting a dependency wake erase an authority block. */
export function setBlock(record: Draft<GoalRecord>, key: string, block: GoalBlock | undefined): void {
  if (isDeepStrictEqual(record.blocks[key], block)) return;
  if (block === undefined) delete record.blocks[key]; else record.blocks[key] = block;
  if (record.stop || terminal(requireSnapshot(record).status)) return;
  reflectBlocks(record);
  bump(requireSnapshot(record));
}

function reflectBlocks(record: Draft<GoalRecord>): void {
  const snapshot = requireSnapshot(record);
  const remaining = Object.values(record.blocks).find((value) => value.status === "waiting_authorization") ?? Object.values(record.blocks)[0];
  snapshot.status = remaining?.status ?? "running";
  if (remaining === undefined) delete snapshot.waiting; else snapshot.waiting = { reason: remaining.reason, ...(remaining.until === undefined ? {} : { until: remaining.until }) };
}
