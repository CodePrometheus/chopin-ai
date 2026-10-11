import { describe, expect, it } from "vitest";

import { roundSignals } from "../src/signals.js";
import type { LoggedEvent } from "../src/signals.js";

const REPORT = { status: "complete", summary: "done", evidence: ["tests pass"], nextSteps: [] };

function call(callId: string, name: string, args: unknown): LoggedEvent {
  return { type: "tool/call", data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } };
}

function result(callId: string, isError: boolean, meta?: unknown): LoggedEvent {
  return { type: "tool/result", data: { turn: 1, step: 1, message: { toolCallId: callId, isError, content: [] }, ...(meta === undefined ? {} : { meta }) } };
}

function answer(usage: Record<string, number>): LoggedEvent {
  return { type: "assistant/message", data: { turn: 1, step: 1, usage } };
}

describe("round signals", () => {
  it("takes the report only from a call the tool accepted, and the check only from a passing run", () => {
    const signals = roundSignals([
      answer({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 80 }),
      call("c1", "team_check", {}), result("c1", false, { passed: false, tree: "t1", commands: ["test"] }),
      call("c2", "team_check", {}), result("c2", false, { passed: true, tree: "t2", commands: ["test"] }),
      call("c3", "team_report", { ...REPORT, summary: "refused" }), result("c3", true),
      { type: "assistant/attempt", data: { turn: 1, step: 2 } },
      answer({ inputTokens: 50, outputTokens: 5, cacheWriteTokens: 20 }),
      call("c4", "team_report", REPORT), result("c4", false),
    ]);
    expect(signals.report).toEqual(REPORT);
    expect(signals.passingCheck).toEqual({ tree: "t2", commands: ["test"] });
    expect(signals.usage).toEqual({ requests: 3, inputTokens: 150, outputTokens: 15, cacheReadTokens: 80, cacheWriteTokens: 20 });
  });

  it("lists every approval refused because nobody was asked, and nothing a person allowed", () => {
    const signals = roundSignals([
      { type: "approval/asked", data: { id: "a1", toolName: "bash" } }, { type: "approval/decided", data: { id: "a1", outcome: "rejected" } },
      { type: "approval/asked", data: { id: "a2", toolName: "ledger_write" } }, { type: "approval/decided", data: { id: "a2", outcome: "allowed-once" } },
      { type: "approval/asked", data: { id: "a3", toolName: "write" } }, { type: "approval/decided", data: { id: "a3", outcome: "cancelled" } },
    ]);
    expect(signals.deniedApprovals).toEqual(["bash"]);
    expect(signals.report).toBeUndefined();
  });

  it("ignores a report call whose arguments break the report contract", () => {
    expect(roundSignals([call("c1", "team_report", { status: "complete", summary: "" }), result("c1", false)]).report).toBeUndefined();
  });
});
