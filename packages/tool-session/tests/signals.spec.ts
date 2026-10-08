/**
 * The three cruxes of signal extraction: no secret may leak into the context, different
 * wordings of one thing merge into one entry, and a single occurrence is not a lesson.
 */

import { describe, expect, it } from "vitest";
import { GATE_DENIAL_TRAILER } from "@chopin/gate";

import { extractSignals, scrub } from "../src/signals.js";
import type { SessionLog } from "../src/read.js";

/** Build a session: each [tool, error] pair becomes one failed call. */
function sessionOf(id: string, workspace: string, failures: [string, string][]): SessionLog {
  const events = failures.flatMap(([tool, text], index) => {
    const callId = `${id}-${index}`;
    return [
      { type: "tool/call", data: { turn: 1, step: 1, callId, name: tool, arguments: "{}" } },
      {
        type: "tool/result",
        data: { turn: 1, step: 1, message: { content: [{ toolCallId: callId, isError: true, content: [{ type: "text", text }] }] } },
      },
    ];
  });
  return { id, workspace, modifiedAt: Date.now(), events };
}

describe("scrub", () => {
  it("wipes common secret shapes", () => {
    const text = scrub("using sk-ant-abcdefghijklmnop and ghp_ABCDEFGHIJKLMNOPQRSTUV plus API_KEY=hunter2secret");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).not.toContain("ABCDEFGHIJKLMNOPQRSTUV");
    expect(text).not.toContain("hunter2secret");
    expect(text).toContain("<anthropic-key>");
  });

  it("leaves ordinary error text alone", () => {
    expect(scrub("ETIMEDOUT connecting to db")).toBe("ETIMEDOUT connecting to db");
  });
});

describe("extractSignals", () => {
  it("different wordings of one thing merge into one entry", () => {
    // Different paths, pids and timestamps; after normalization it is the same key.
    const logs = [
      sessionOf("s1", "repo", [["run_tests", "failed at /tmp/a/x.ts:12 pid=901"]]),
      sessionOf("s2", "repo", [["run_tests", "failed at /var/b/y.ts:77 pid=4523"]]),
    ];
    const signals = extractSignals(logs);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.occurrences).toBe(2);
    expect(signals[0]?.sessions).toBe(2);
  });

  it("a single occurrence is not a lesson", () => {
    expect(extractSignals([sessionOf("s1", "repo", [["run_build", "boom"]])])).toEqual([]);
  });

  it("gate rejections cluster by unmet rule id, apart from plain tool failures", () => {
    const denial = (gate: string) => `Rejected by 1 unmet investigation gate(s):\n- ${gate}: run it\n${GATE_DENIAL_TRAILER} ${gate}`;
    const logs = [
      sessionOf("s1", "repo", [["submit_delivery", denial("verified")]]),
      sessionOf("s2", "repo", [["submit_delivery", denial("verified")]]),
      sessionOf("s3", "repo", [["submit_delivery", denial("diff-reviewed")]]),
      sessionOf("s4", "repo", [["submit_delivery", denial("diff-reviewed")]]),
      sessionOf("s5", "repo", [["git_diff", "fatal: not a git repository"]]),
      sessionOf("s6", "repo", [["git_diff", "fatal: not a git repository"]]),
    ];
    const signals = extractSignals(logs);
    expect(signals.map((s) => s.kind).sort()).toEqual(["gate-rejection", "gate-rejection", "tool-failure"]);
    expect(signals.filter((s) => s.kind === "gate-rejection").map((s) => s.gates).sort()).toEqual([["diff-reviewed"], ["verified"]]);
    expect(signals.every((s) => s.key.startsWith("sk1:"))).toBe(true);
  });

  it("successful calls produce no signal", () => {
    const log: SessionLog = {
      id: "s", workspace: "repo", modifiedAt: Date.now(),
      events: [
        { type: "tool/call", data: { callId: "c", name: "run_tests", arguments: "{}" } },
        { type: "tool/result", data: { message: { content: [{ toolCallId: "c", isError: false, content: [{ type: "text", text: "ok" }] }] } } },
      ],
    };
    expect(extractSignals([log, log], { minOccurrences: 1 })).toEqual([]);
  });

  it("secrets are already wiped from the signal sample", () => {
    const leak = "auth failed with sk-ant-SECRETSECRETSECRET";
    const signals = extractSignals([sessionOf("s1", "r", [["bash", leak]]), sessionOf("s2", "r", [["bash", leak]])]);
    expect(signals[0]?.sample).not.toContain("SECRETSECRETSECRET");
  });
});
