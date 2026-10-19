import type { ConversationView } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { merge, outcomeOf, progressOf, RECENT_SUBMISSIONS, type Outcome } from "../src/submissions.js";

const view = (ids: number[], inputs: number[] = []) =>
  ({ entries: ids.map((id) => ({ id })), docs: inputs.length === 0 ? {} : { "pi.live": { run: { inputs } } } }) as unknown as ConversationView;

describe("submissions as clients see them", () => {
  it("keeps every running submission and only the latest settled ones", () => {
    const draft: Record<string, Outcome> = { 1: { status: "pending" } };
    for (let id = 2; id <= RECENT_SUBMISSIONS + 5; id++) draft[String(id)] = { status: "done" };
    merge(draft, { [String(RECENT_SUBMISSIONS + 6)]: { status: "done" } });
    expect(draft["1"]).toEqual({ status: "pending" });
    expect(Object.keys(draft)).toHaveLength(RECENT_SUBMISSIONS + 1);
    expect(draft["2"]).toBeUndefined();
    expect(draft[String(RECENT_SUBMISSIONS + 6)]).toEqual({ status: "done" });
  });

  it("keeps an old submission this read reports, so whoever waits on it sees how it ended", () => {
    const draft: Record<string, Outcome> = { 1: { status: "pending" } };
    for (let id = 2; id <= RECENT_SUBMISSIONS + 5; id++) draft[String(id)] = { status: "done" };
    merge(draft, { 1: { status: "done" } });
    expect(draft["1"]).toEqual({ status: "done" });
  });

  it("notices progress in which entries are there, not only how many", () => {
    expect(progressOf(view([1, 2, 3]))).not.toBe(progressOf(view([2, 3, 4])));
    expect(progressOf(view([1, 2]))).not.toBe(progressOf(view([1, 2], [5])));
    expect(progressOf(view([1, 2], [5]))).toBe(progressOf(view([1, 2], [5])));
  });

  it("reads the store's records as running, answered or not and why", () => {
    expect(outcomeOf({ status: "placed" })).toEqual({ status: "pending" });
    expect(outcomeOf({ status: "done" })).toEqual({ status: "done" });
    expect(outcomeOf({ status: "unanswered", reason: "model_error", detail: { code: 429 } }))
      .toEqual({ status: "unanswered", reason: "model_error", detail: '{"code":429}' });
  });
});
