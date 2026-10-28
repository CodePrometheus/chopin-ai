import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { entryUpdates } from "../src/index.js";

const entry = (model: unknown[]) => ({ id: 1, conversationId: 1, kind: "test", model }) as unknown as EntryRecord;

describe("entryUpdates", () => {
  it("turns user, assistant and tool messages into ACP session updates", () => {
    expect(entryUpdates(entry([{ role: "user", content: "Fix it.", timestamp: 0 }]))).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Fix it." } },
    ]);
    expect(entryUpdates(entry([{
      role: "assistant", stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: "Look first." },
        { type: "text", text: "Reading." },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
      ],
    }]))).toEqual([
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Look first." } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading." } },
      { sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", kind: "execute", status: "pending", rawInput: { command: "ls" } },
    ]);
    expect(entryUpdates(entry([{ role: "toolResult", toolCallId: "c1", toolName: "bash", isError: true, content: [{ type: "text", text: "boom" }] }])))
      .toEqual([{
        sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed",
        content: [{ type: "content", content: { type: "text", text: "boom" } }],
      }]);
  });

  it("carries a tool result's diagnostic codes, so a refused call reads as refused", () => {
    const blocked = {
      ...entry([{ role: "toolResult", toolCallId: "c1", toolName: "bash", isError: true, content: [] }]),
      data: { diagnostics: [{ severity: "error", code: "blocked", message: "Tool call blocked: run the tests first" }] },
    } as unknown as EntryRecord;
    expect(entryUpdates(blocked)).toEqual([{
      sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed", content: [],
      _meta: { "chopin-ai": { diagnostics: ["blocked"] } },
    }]);
  });

  it("says nothing for entries the model never sees", () => {
    expect(entryUpdates(entry([{ role: "system", content: "" }]))).toEqual([]);
    expect(entryUpdates({ id: 1, conversationId: 1, kind: "app.note" } as unknown as EntryRecord)).toEqual([]);
  });
});
