import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";
import { eventUpdates } from "../src/acp.js";

describe("plugin harness events as ACP", () => {
  it("gives a tool named like an object's own property the kind of any unknown tool", () => {
    const event = {
      type: "assistant/message", seq: 0, time: 0,
      data: { message: { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "constructor", arguments: "{}" }] } },
    } as unknown as SessionEvent;
    expect(eventUpdates(event)).toMatchObject([{ sessionUpdate: "tool_call", kind: "other" }]);
  });
});
