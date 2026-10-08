import { describe, expect, it } from "vitest";

import { ToolCallId, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";

import { observeToolContrast, observeToolFailure } from "../src/index.js";

function session(id: string, error: boolean, text: string) {
  const events = [
    {
      type: "tool/call",
      seq: 0,
      time: 1_777_766_400_000,
      data: { turn: 1, step: 1, callId: "call-one", name: "read", arguments: "{}" },
    },
    {
      type: "tool/result",
      seq: 1,
      time: 1_777_766_401_000,
      data: {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId: ToolCallId("call-one"), isError: error, content: [{ type: "text", text }] }),
      },
    },
  ] as unknown as SessionEvent[];
  return { id, snapshotEvents: () => events } as unknown as Pick<Session, "id" | "snapshotEvents">;
}

describe("session observer", () => {
  it("writes only real failure results as observed and fakes no root cause", () => {
    const failed = session("session-one", true, "spawn EBADF at /tmp/build-123");
    const event = observeToolFailure(failed, failed.snapshotEvents()[1] as Extract<SessionEvent, { type: "tool/result" }>);
    expect(event?.type).toBe("candidate.observed");
    expect(event?.data.lesson).toContain("root cause is not classified");
    expect(event?.data.evidence).toMatchObject({
      class: "session-signal",
      independenceKey: "session-one",
      independentUnits: 1,
      sourceRef: "session:session-one:event:1",
    });

    const succeeded = session("session-two", false, "ok");
    expect(observeToolFailure(succeeded, succeeded.snapshotEvents()[1] as Extract<SessionEvent, { type: "tool/result" }>)).toBeUndefined();
  });

  it("the same committed event replays idempotently, and different sessions form independent evidence", () => {
    const first = session("session-one", true, "spawn EBADF at /tmp/build-123");
    const second = session("session-two", true, "spawn EBADF at /tmp/build-456");
    const one = observeToolFailure(first, first.snapshotEvents()[1] as Extract<SessionEvent, { type: "tool/result" }>);
    const replay = observeToolFailure(first, first.snapshotEvents()[1] as Extract<SessionEvent, { type: "tool/result" }>);
    const two = observeToolFailure(second, second.snapshotEvents()[1] as Extract<SessionEvent, { type: "tool/result" }>);
    expect(replay).toEqual(one);
    expect(two?.entityId).toBe(one?.entityId);
    expect((two?.data.evidence as { independenceKey: string }).independenceKey).toBe("session-two");
  });

  it("scrubs credential-shaped text before writing", () => {
    const value = session("session-secret", true, "request failed TOKEN=super-secret-value");
    const event = observeToolFailure(value, value.snapshotEvents()[1] as Extract<SessionEvent, { type: "tool/result" }>);
    expect(JSON.stringify(event)).not.toContain("super-secret-value");
    expect(JSON.stringify(event)).toContain("redacted");
  });
});

describe("tool contrast", () => {
  function sessionWithSuccess() {
    const events = [
      { type: "tool/call", seq: 0, time: 1_777_766_400_000, data: { turn: 1, step: 1, callId: "list", name: "list", arguments: "{}" } },
      { type: "tool/result", seq: 1, time: 1_777_766_400_100, data: { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId("list"), isError: false, content: [] }) } },
      { type: "tool/call", seq: 2, time: 1_777_766_400_200, data: { turn: 1, step: 2, callId: "ok", name: "read", arguments: JSON.stringify({ file_path: "a.ts", limit: 20 }) } },
      { type: "tool/result", seq: 3, time: 1_777_766_400_300, data: { turn: 1, step: 2, message: createToolResultMessage({ callId: ToolCallId("ok"), isError: false, content: [{ type: "text", text: "fine" }] }) } },
      { type: "tool/call", seq: 4, time: 1_777_766_401_000, data: { turn: 1, step: 3, callId: "call-one", name: "read", arguments: JSON.stringify({ file_path: "sk-ant-secret" }) } },
      { type: "tool/result", seq: 5, time: 1_777_766_401_000, data: { turn: 1, step: 3, message: createToolResultMessage({ callId: ToolCallId("call-one"), isError: true, content: [{ type: "text", text: "ENOENT" }] }) } },
    ] as unknown as SessionEvent[];
    return { id: "session-contrast", snapshotEvents: () => events } as unknown as Pick<Session, "id" | "snapshotEvents">;
  }

  it("pairs a failure with the latest earlier success of the same tool, scrubbed and never trusted", () => {
    const session = sessionWithSuccess();
    const failure = session.snapshotEvents()[5] as Extract<SessionEvent, { type: "tool/result" }>;
    const observed = observeToolFailure(session, failure);
    const contrast = observeToolContrast(session, failure, observed!);
    expect(contrast).toBeDefined();
    const data = contrast!.data as { evidence: { class: string; summary: string; sourceRef: string; sourceAttemptId: string } };
    expect(contrast!.entityId).toBe(observed!.entityId);
    expect(data.evidence.class).toBe("contrast");
    expect(data.evidence.sourceRef).toBe("session:session-contrast:event:3");
    expect(data.evidence.sourceAttemptId).toBe("ok");
    expect(data.evidence.summary).toContain("[file_path, limit]");
    expect(data.evidence.summary).toContain("[list]");
    expect(JSON.stringify(contrast)).not.toContain("sk-ant-secret");
  });

  it("yields nothing when the tool never succeeded earlier in the session", () => {
    const session = sessionWithSuccess();
    const events = session.snapshotEvents().filter((event) => event.seq < 2 || event.seq > 3);
    const only = { id: "session-contrast", snapshotEvents: () => events } as unknown as Pick<Session, "id" | "snapshotEvents">;
    const failure = events.at(-1) as Extract<SessionEvent, { type: "tool/result" }>;
    expect(observeToolContrast(only, failure, observeToolFailure(only, failure)!)).toBeUndefined();
  });
});
