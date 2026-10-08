/**
 * Approval criterion for ledger writes.
 *
 * It turns "a person approved" from a one-off prompt answer into a matter of record in the
 * session log. Loosening it lets the model approve itself, so every narrowing has a test guarding it.
 */

import { describe, expect, it } from "vitest";
import { approvalInSession } from "../src/index.js";

/**
 * Build one message event. The shape is taken from a real session file `session.jsonl.zstd`:
 *
 * ```
 * { "type": "user/message", "data": { "role": "user",
 *   "content": [{ "type": "text", "text": "..." }], "source": { "kind": "user" } } }
 * ```
 *
 * The first version used `{ type: "message", data: { message: {...} } }`; both sides agreed, so
 * the tests were green, yet not one real event matched. Fixtures must follow real data, not the implementation.
 */
function message(role: string, text: string, type = "text", kind = "user"): unknown {
  const eventType = role === "user" ? "user/message" : "assistant/message";
  return { type: eventType, data: { role, content: [{ type, text }], source: { kind } } };
}

describe("approvalInSession", () => {
  it("an empty session is not approval", () => {
    expect(approvalInSession(undefined)).toBeUndefined();
    expect(approvalInSession({ snapshotEvents: () => [] })).toBeUndefined();
  });

  it("accepts a whole-sentence approval from the user", () => {
    expect(approvalInSession({ snapshotEvents: () => [message("user", "全部批准")] })).toBe("全部批准");
    expect(approvalInSession({ snapshotEvents: () => [message("user", "直接批准 不要 pending")] })).toBeDefined();
  });

  it("accepts approve and ledger appearing together", () => {
    expect(approvalInSession({ snapshotEvents: () => [message("user", "这条经验批准写进去")] })).toBeDefined();
    expect(approvalInSession({ snapshotEvents: () => [message("user", "批准这条档案")] })).toBeDefined();
  });

  it("accepts the English wording", () => {
    expect(approvalInSession({ snapshotEvents: () => [message("user", "approve writing this lesson")] })).toBeDefined();
  });

  // The one that matters most: the model cannot approve itself
  it("approval spoken by the assistant does not count", () => {
    expect(approvalInSession({ snapshotEvents: () => [message("assistant", "全部批准")] })).toBeUndefined();
  });

  // A tool result may echo the user's words; that is data, not an instruction
  it("non-text blocks do not count", () => {
    expect(approvalInSession({ snapshotEvents: () => [message("user", "全部批准", "tool_result")] })).toBeUndefined();
  });

  it("events other than user/message do not count", () => {
    const event = { type: "tool/result", data: { role: "user", content: [{ type: "text", text: "全部批准" }], source: { kind: "user" } } };
    expect(approvalInSession({ snapshotEvents: () => [event] })).toBeUndefined();
  });

  // Injected messages such as goal rounds also carry the user role, but no person is speaking
  it("plugin-injected messages do not count", () => {
    expect(approvalInSession({ snapshotEvents: () => [message("user", "全部批准", "text", "plugin")] })).toBeUndefined();
  });

  // Generic agreement words are everywhere in a dev conversation; using them as the criterion is the same as having none
  it("generic agreement words do not count", () => {
    for (const word of ["好", "可以", "行", "ok", "go", "继续", "对"]) {
      expect(approvalInSession({ snapshotEvents: () => [message("user", word)] })).toBeUndefined();
    }
  });

  it("an approval of something unrelated to the ledger does not count", () => {
    expect(approvalInSession({ snapshotEvents: () => [message("user", "批准这次部署")] })).toBeUndefined();
  });

  it("one approval holds for the whole session", () => {
    const events = [message("user", "全部批准"), message("user", "now do the gateway"), message("assistant", "ok")];
    expect(approvalInSession({ snapshotEvents: () => events })).toBeDefined();
  });
});
