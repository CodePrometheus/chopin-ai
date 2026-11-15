import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineTask, Harness, ROOT_CONVERSATION_ID, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, it } from "vitest";
import { GoalDoc, GoalStore, RequestDoc, bump, type GoalCheckpoint, type GoalOutcome } from "../src/goals/store.js";
import type { EngineCommand } from "../src/goals/contracts.js";

// These checks keep scheduling paused and exercise admission, not task completion.
const paused = async () => { throw new Error("admission fixture must remain paused"); };
const driver = defineTask<{ goalId: string }, GoalCheckpoint, GoalOutcome>({
  name: "fixture.goal", version: 1, initial: () => ({ phase: "dispatch" }),
  phases: { dispatch: paused, run: paused, wait: paused }, abort: paused,
});
async function open(path: string) {
  const storage = await openNodeSqliteStorage(path);
  const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
  return { harness, storage, goals: new GoalStore(harness, storage, driver), close: () => harness.close(context) };
}
async function fixture() { return join(await mkdtemp(join(tmpdir(), "goal-admission-")), "store.sqlite"); }
function submit(requestId = randomUUID()): EngineCommand {
  return { version: 1, requestId, command: { kind: "goal.submit", objective: "Produce a checked result", completionCriteria: ["The result is supported by evidence"], grant: { id: "delegation", version: 1 } } };
}

it("commits one immutable goal and receipt across concurrent duplicates and reopen", async () => {
  const path = await fixture(); const f = await open(path); const command = submit();
  try {
    const receipts = await Promise.all([f.goals.execute(command, undefined, context), f.goals.execute(structuredClone(command), undefined, context)]);
    expect(receipts[0]).toEqual(receipts[1]);
    const receipt = receipts[0]!;
    const goal = await f.goals.snapshot(receipt.goalId, context);
    expect(goal.status).toBe("accepted");
    expect(goal.version).toBe(1);
    const conversation = await f.storage.conversation(goal.conversationId as ConversationId, context);
    expect(conversation?.owner?.taskId).toBe(await f.goals.driverId(goal.goalId, context));
    expect(await f.goals.forConversation(goal.conversationId as ConversationId, context)).toEqual(goal);
    expect((await f.goals.page(1, undefined, context)).goals).toEqual([goal]);
    const changed = structuredClone(command); if (changed.command.kind === "goal.submit") changed.command.objective = "Different content";
    await expect(f.goals.execute(changed, undefined, context)).rejects.toThrow("request_conflict");
  } finally { await f.close(); }
  const reopened = await open(path);
  try {
    expect(await reopened.goals.replay(command, context)).toEqual({ version: 1, requestId: command.requestId, goalId: command.requestId, acceptedVersion: 1 });
    expect((await reopened.goals.page(1, undefined, context)).goals).toHaveLength(1);
  } finally { await reopened.close(); }
});

it("keeps original receipt identity when newer input and stop change the goal", async () => {
  const f = await open(await fixture());
  try {
    const initial = await f.goals.execute(submit(), undefined, context);
    const input: EngineCommand = { version: 1, requestId: randomUUID(), command: { kind: "goal.input", goalId: initial.goalId, expectedVersion: 1, text: "Also include verification" } };
    const receipt = await f.goals.execute(input, undefined, context);
    expect(receipt.acceptedVersion).toBe(2);
    const goal = await f.goals.snapshot(initial.goalId, context);
    expect(goal.objective).toBe("Produce a checked result");
    expect(goal.status).toBe("accepted");
    expect(goal.grant).toEqual({ id: "delegation", version: 1 });
    await f.goals.execute({ version: 1, requestId: randomUUID(), command: { kind: "goal.stop", goalId: goal.goalId, expectedVersion: 2 } }, undefined, context);
    expect((await f.goals.snapshot(goal.goalId, context)).status).toBe("stopping");
    expect(await f.goals.execute(input, undefined, context)).toEqual(receipt);
    const later = structuredClone(input); later.requestId = randomUUID();
    await expect(f.goals.execute(later, undefined, context)).rejects.toThrow("goal_conflict");
    expect(await f.goals.request(later.requestId, context)).toBeUndefined();
  } finally { await f.close(); }
});

it("rejects a foreign question without accepting its request", async () => {
  const f = await open(await fixture());
  try {
    const initial = await f.goals.execute(submit(), undefined, context);
    await f.harness.commit(async (tx) => {
      const goal = (await tx.doc(GoalDoc, initial.goalId, null)).snapshot!;
      goal.status = "waiting_user"; goal.waiting = { reason: "Choose the intended result", questionId: "original-question" }; bump(goal);
    }, context);
    const input: EngineCommand = { version: 1, requestId: randomUUID(), command: { kind: "goal.input", goalId: initial.goalId, expectedVersion: 2, text: "My answer", questionId: "different-question" } };
    await expect(f.goals.execute(input, undefined, context)).rejects.toThrow("question_conflict");
    expect(await f.goals.request(input.requestId, context)).toBeUndefined();
    if (input.command.kind === "goal.input") input.command.questionId = "original-question";
    await f.goals.execute(input, undefined, context);
    expect((await f.goals.snapshot(initial.goalId, context)).waiting).toBeUndefined();
  } finally { await f.close(); }
});

it("rolls back the entire admission when its continuation source is invalid", async () => {
  const f = await open(await fixture());
  try {
    const command = submit();
    if (command.command.kind === "goal.submit") command.command.continuation = { goalId: "missing", expectedVersion: 1 };
    await expect(f.goals.execute(command, undefined, context)).rejects.toThrow("unknown_goal");
    expect(await f.harness.snapshot(RequestDoc, command.requestId, context)).toBeUndefined();
    expect(await f.harness.snapshot(GoalDoc, command.requestId, context)).toBeUndefined();
    expect(await f.harness.snapshot(GoalDoc, "missing", context)).toBeUndefined();
    const conversations = await f.storage.scanConversations({}, 2, undefined, context);
    expect(conversations.items.map((record) => record.id)).toEqual([ROOT_CONVERSATION_ID]);
    expect((await f.goals.page(1, undefined, context)).goals).toEqual([]);
  } finally { await f.close(); }
});

it("preserves source pagination without loading the remaining goals", async () => {
  const f = await open(await fixture());
  try {
    const first = await f.goals.execute(submit(), undefined, context);
    const second = await f.goals.execute(submit(), undefined, context);
    const page = await f.goals.page(1, undefined, context);
    expect(page.goals.map((goal) => goal.goalId)).toEqual([first.goalId]);
    expect(page.cursor).toBeDefined();
    const next = await f.goals.page(1, page.cursor, context);
    expect(next.goals.map((goal) => goal.goalId)).toEqual([second.goalId]);
    if (next.cursor !== undefined) expect((await f.goals.page(1, next.cursor, context)).goals).toEqual([]);
  } finally { await f.close(); }
});
