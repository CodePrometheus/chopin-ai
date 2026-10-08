import { describe, expect, it } from "vitest";
import type { Agent } from "@deepseek-ai/dsh-agent";

import { isEvolutionStep } from "../src/index.js";

function agentWith(events: unknown[]): Pick<Agent, "session"> {
  return { session: { snapshotEvents: () => events } } as unknown as Pick<Agent, "session">;
}
const user = { type: "user/message", seq: 0, data: { source: { kind: "user" } } };
const call = (seq: number, name: string) => ({ type: "tool/call", seq, data: { callId: `c${seq}`, name } });

describe("evolution step detection", () => {
  it("is true only when the latest tool call of the current request is self-improvement work", () => {
    expect(isEvolutionStep(agentWith([user, call(1, "read"), call(2, "evolution_candidate_classify")]))).toBe(true);
    expect(isEvolutionStep(agentWith([user, call(1, "evolution_approve"), call(2, "read")]))).toBe(false);
    expect(isEvolutionStep(agentWith([call(1, "evolution_approve"), user]))).toBe(false);
    expect(isEvolutionStep(agentWith([user, call(1, "submit_evolution")]))).toBe(true);
    expect(isEvolutionStep(agentWith([]))).toBe(false);
  });
});
