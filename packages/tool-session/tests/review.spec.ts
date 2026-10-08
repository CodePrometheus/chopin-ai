/**
 * The crux of feedback scoring: preventive landings are judged by recurrence, reference ones are not.
 * Get that wrong and a lesson that merely "took a note" gets a death sentence because the failure kept happening.
 */

import { describe, expect, it } from "vitest";

import { normalizeErrorString } from "@chopin/ledger";
import { scoreLesson } from "../src/review.js";
import type { SessionLog } from "../src/read.js";

const FAILURE = "Error: kubectl apply failed for deployment/api-42 in ns prod-3";
const KEY = normalizeErrorString(FAILURE).key;

function sessionWith(id: string, failures: string[]): SessionLog {
  const events = failures.flatMap((text, index) => {
    const callId = `${id}-${index}`;
    return [
      { type: "tool/call", data: { turn: 1, step: 1, callId, name: "kubectl_apply", arguments: "{}" } },
      {
        type: "tool/result",
        data: { turn: 1, step: 1, message: { content: [{ toolCallId: callId, isError: true, content: [{ type: "text", text }] }] } },
      },
    ];
  });
  return { id, workspace: "chopin", modifiedAt: Date.now(), events };
}

describe("scoreLesson", () => {
  it("signal gone after the gate landed = confirmed", () => {
    const logs = [sessionWith("s1", ["Error: something else entirely"]), sessionWith("s2", [])];
    expect(scoreLesson({ key: KEY, proposal: "gate" }, logs)).toEqual({
      outcome: "confirmed",
      recurrencesAfter: 0,
      sessionsAfter: 2,
    });
  });

  it("still failing with the gate in place = contradicted, with the count reported as is", () => {
    // Different pod and namespace numbers; after normalization it is still the same thing.
    const logs = [
      sessionWith("s1", [FAILURE, "Error: kubectl apply failed for deployment/api-9911 in ns prod-7"]),
      sessionWith("s2", ["Error: kubectl apply failed for deployment/api-5 in ns prod-88"]),
    ];
    const score = scoreLesson({ key: KEY, proposal: "gate" }, logs);
    expect(score.outcome).toBe("contradicted");
    expect(score.recurrencesAfter).toBe(3);
  });

  it("declarative tools are judged as preventive too", () => {
    expect(scoreLesson({ key: KEY, proposal: "toolset" }, [sessionWith("s1", [FAILURE])]).outcome).toBe("contradicted");
  });

  it("a ledger record stops nothing, so recurrence cannot contradict it", () => {
    const logs = [sessionWith("s1", [FAILURE, FAILURE])];
    expect(scoreLesson({ key: KEY, proposal: "ledger" }, logs)).toEqual({
      outcome: "inactive",
      recurrencesAfter: 0,
      sessionsAfter: 1,
    });
  });

  it("same for a note", () => {
    expect(scoreLesson({ key: KEY, proposal: "note" }, [sessionWith("s1", [FAILURE])]).outcome).toBe("inactive");
  });

  it("no sessions at all after promotion = nothing to judge by, not a confirmation", () => {
    expect(scoreLesson({ key: KEY, proposal: "gate" }, [])).toEqual({
      outcome: "inactive",
      recurrencesAfter: 0,
      sessionsAfter: 0,
    });
  });

  it("other failures are not recurrences of this one", () => {
    const logs = [sessionWith("s1", ["ETIMEDOUT connecting to db", "permission denied: /etc/hosts"])];
    expect(scoreLesson({ key: KEY, proposal: "gate" }, logs).outcome).toBe("confirmed");
  });
});
