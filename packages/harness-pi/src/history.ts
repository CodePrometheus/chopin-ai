import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { int, lit, map, nul, obj, str, union, unknown } from "@earendil-works/chord";
import { compile } from "@earendil-works/pi-schema";
import type { Conversation, Cursor, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { refusal } from "./service-error.js";
import type { GoalEngine } from "./goals/engine.js";
import type { GoalPage } from "./goals/contracts.js";

const CursorSchema = obj({
  version: lit(1), kind: lit("conversation-history"), scope: str(),
  conversation: int({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  before: union([int({ min: 0, max: Number.MAX_SAFE_INTEGER }), nul()]), position: map(unknown()),
});
const CursorValue = compile(CursorSchema);
const GoalCursor = compile(obj({ version: lit(1), kind: lit("goal-list"), scope: str(), position: map(unknown()) }));

/** Goal listings keep their source cursor scoped to the authenticated owner. */
export async function goalPage(owner: string, engine: GoalEngine, limit: number, cursor: unknown, context: Context): Promise<GoalPage> {
  const scope = createHash("sha256").update("goal-list\0").update(owner).digest("hex");
  let position: Cursor | undefined;
  if (cursor !== undefined) {
    if (!GoalCursor.check(cursor) || cursor.scope !== scope) throw refusal("invalid_cursor", "goal cursor belongs to another query");
    position = cursor.position as Cursor;
  }
  const page = await engine.page(limit, position, context);
  return { goals: page.goals, ...(page.cursor === undefined ? {} : { cursor: { version: 1, kind: "goal-list", scope, position: page.cursor } }) };
}

/** Bind a source position to its original owner, conversation and inclusive history boundary. */
export async function historyPage(owner: string, conversation: Conversation, limit: number, cursor: unknown, atOrBefore: number | undefined, context: Context): Promise<{ entries: EntryRecord[]; cursor?: Cursor }> {
  const scope = createHash("sha256").update("conversation-history\0").update(owner).digest("hex");
  let position: Cursor | undefined;
  let before = atOrBefore;
  if (cursor !== undefined) {
    if (!CursorValue.check(cursor) || cursor.scope !== scope || cursor.conversation !== Number(conversation.id)
      || before !== undefined && before !== cursor.before) throw refusal("invalid_cursor", "history cursor belongs to another query");
    position = cursor.position as Cursor;
    before = cursor.before ?? undefined;
  }
  const page = await conversation.entries({ order: "descending", ...(before === undefined ? {} : { maxEntryId: before as EntryId }) }, limit, position, context);
  return {
    entries: [...page.items],
    ...(page.next === undefined ? {} : { cursor: { version: 1, kind: "conversation-history", scope, conversation: Number(conversation.id), before: before ?? null, position: page.next } }),
  };
}
