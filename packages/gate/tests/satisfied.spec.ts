/**
 * Core contract of gate judgment: which session logs count as "already checked".
 * No dsh tree is assembled here, only an event stream -- when the judgment logic
 * itself is wrong, an integration test only says "blocked", never why.
 */

import { describe, expect, it } from "vitest";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";
import { GATE_DENIAL_TRAILER, createGateGuard, evaluate, parseGateDenial, satisfiedTools } from "../src/index.js";

/** Build an event stream: one call paired with one result. */
function sessionOf(calls: { name: string; failed?: boolean }[]): Session {
  const events: unknown[] = [];
  calls.forEach((call, index) => {
    const callId = `call-${index}`;
    events.push({ type: "tool/call", data: { turn: 1, step: 1, callId, name: call.name, arguments: "{}" } });
    events.push({
      type: "tool/result",
      data: {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId: ToolCallId(callId), content: [], isError: call.failed === true }),
      },
    });
  });
  return { snapshotEvents: () => events } as unknown as Session;
}

const RULES = [
  { id: "evidence", description: "read first-hand evidence", satisfiedByTools: ["bundle_fetch", "log_grep"] },
  { id: "ledger", description: "search the defect ledger", satisfiedByTools: ["ledger_search"] },
];

describe("satisfiedTools", () => {
  it("a latest failed or incomplete call cannot borrow an older success, and a late result cannot override a newer failure", () => {
    const session = sessionOf([{ name: "run_tests" }, { name: "run_tests", failed: true }]);
    expect(satisfiedTools(session).has("run_tests")).toBe(false);
    const events = session.snapshotEvents();
    expect(satisfiedTools({ snapshotEvents: () => events.slice(0, -1) } as unknown as Session).has("run_tests")).toBe(false);
    const reordered = [events[0], events[2], events[3], events[1]];
    expect(satisfiedTools({ snapshotEvents: () => reordered } as unknown as Session).has("run_tests")).toBe(false);
  });

  it("a new user request and a successful delivery both end the previous submission evidence", () => {
    const session = sessionOf([{ name: "run_tests" }, { name: "submit_report" }]);
    expect(satisfiedTools(session, "submit_report").size).toBe(0);
    const events = [...session.snapshotEvents(), { type: "user/message", data: { source: { kind: "user" } } }];
    expect(satisfiedTools({ snapshotEvents: () => events } as unknown as Session).size).toBe(0);
    const rejected = sessionOf([{ name: "run_tests" }, { name: "submit_report", failed: true }]);
    expect(satisfiedTools(rejected, "submit_report").has("run_tests")).toBe(true);
  });

  it("collects only successfully completed calls", () => {
    const called = satisfiedTools(sessionOf([{ name: "ledger_search" }, { name: "bundle_fetch", failed: true }]));
    expect([...called].sort()).toEqual(["ledger_search"]);
  });

  it("a call without a result does not count", () => {
    const session = {
      snapshotEvents: () => [{ type: "tool/call", data: { turn: 1, step: 1, callId: "c0", name: "ledger_search", arguments: "{}" } }],
    } as unknown as Session;
    expect(satisfiedTools(session).size).toBe(0);
  });
});

describe("evaluate", () => {
  it("any listed tool succeeding satisfies the rule", () => {
    const status = evaluate(RULES, satisfiedTools(sessionOf([{ name: "log_grep" }])));
    expect(status.find((gate) => gate.id === "evidence")?.satisfied).toBe(true);
    expect(status.find((gate) => gate.id === "ledger")?.satisfied).toBe(false);
  });

  it("a failed call satisfies no rule", () => {
    const status = evaluate(RULES, satisfiedTools(sessionOf([{ name: "bundle_fetch", failed: true }])));
    expect(status.every((gate) => !gate.satisfied)).toBe(true);
  });

  it("nothing is unmet when every rule is satisfied", () => {
    const called = satisfiedTools(sessionOf([{ name: "bundle_fetch" }, { name: "ledger_search" }]));
    expect(evaluate(RULES, called).filter((gate) => !gate.satisfied)).toEqual([]);
  });
});

/**
 * Contract of the denial reason: unmet may only be phrased as unmet.
 *
 * Tools register in layers by the scope of their declaring line, and the context the
 * guard receives may not resolve tools registered by other lines, so the denial path
 * must not infer tool existence from it -- that inference would call "not yet called"
 * a configuration failure and make the caller stop trying. Composition correctness
 * is the job of the static check at startup.
 */
describe("createGateGuard denial reasons", () => {
  /** The tool registry never resolves anything: the denial wording must not change because of it. */
  function agentOf(session: Session): Agent {
    return { session, ctx: { tools: { get: () => undefined } } } as unknown as Agent;
  }

  const guard = createGateGuard({ guardedTool: "submit_report", rules: RULES });

  it("states only the gaps when unmet, never blames configuration", () => {
    const session = sessionOf([]);
    const denial = guard({ name: "submit_report", agent: agentOf(session) } as never);

    expect(denial).toContain("Rejected by 2 unmet");
    expect(denial).toContain("evidence");
    expect(denial).toContain("ledger");
    // The denial must not attribute unmet rules to a configuration problem
    expect(denial).not.toContain("misconfiguration");
    expect(denial).not.toContain("Report it and stop");
  });

  it("satisfied rules no longer appear in the denial", () => {
    const session = sessionOf([{ name: "ledger_search" }]);
    const denial = guard({ name: "submit_report", agent: agentOf(session) } as never);

    expect(denial).toContain("Rejected by 1 unmet");
    expect(denial).toContain("evidence");
    expect(denial).not.toContain("search the defect ledger");
  });

  it("lets the call through when every rule is satisfied", () => {
    const session = sessionOf([{ name: "log_grep" }, { name: "ledger_search" }]);
    expect(guard({ name: "submit_report", agent: agentOf(session) } as never)).toBeUndefined();
  });

  it("does not block other tools", () => {
    const session = sessionOf([]);
    expect(guard({ name: "some_other_tool", agent: agentOf(session) } as never)).toBeUndefined();
  });

  it("the last line is a machine-readable unmet list that parseGateDenial reads back verbatim", () => {
    const denial = guard({ name: "submit_report", agent: agentOf(sessionOf([{ name: "ledger_search" }])) } as never) as string;
    expect(denial.split("\n").at(-1)).toBe(`${GATE_DENIAL_TRAILER} evidence`);
    expect(parseGateDenial(denial)).toEqual({ unmet: ["evidence"] });
    expect(parseGateDenial("fatal: not a git repository")).toBeUndefined();
    expect(parseGateDenial(`${GATE_DENIAL_TRAILER} `)).toBeUndefined();
  });
});
