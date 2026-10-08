import { describe, expect, it } from "vitest";

import { consolidationDue } from "../src/consolidation.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 29);

describe("consolidationDue", () => {
  it("never consolidated: only when there are enough sessions", () => {
    expect(consolidationDue({ state: {}, sessionCount: 3, nowMs: NOW }).due).toBe(false);
    expect(consolidationDue({ state: {}, sessionCount: 12, nowMs: NOW }).due).toBe(true);
  });

  it("double gate: not enough time means no pass, however many sessions", () => {
    const verdict = consolidationDue({
      state: { lastRunAt: new Date(NOW - 2 * DAY_MS).toISOString(), lastRunSessionCount: 0 },
      sessionCount: 500,
      nowMs: NOW,
    });
    expect(verdict.due).toBe(false);
    expect(verdict.reason).toContain("2.0 day(s) ago");
  });

  it("double gate: not enough sessions means no pass, however long ago", () => {
    const verdict = consolidationDue({
      state: { lastRunAt: new Date(NOW - 90 * DAY_MS).toISOString(), lastRunSessionCount: 40 },
      sessionCount: 42,
      nowMs: NOW,
    });
    expect(verdict.due).toBe(false);
    expect(verdict.reason).toContain("only 2 new session(s)");
  });

  it("runs only when both are satisfied", () => {
    expect(consolidationDue({
      state: { lastRunAt: new Date(NOW - 8 * DAY_MS).toISOString(), lastRunSessionCount: 40 },
      sessionCount: 55,
      nowMs: NOW,
    }).due).toBe(true);
  });
});
