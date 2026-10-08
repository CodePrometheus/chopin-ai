import { describe, expect, it } from "vitest";

import {
  adjustConfidence,
  applyPassiveDecay,
  confirmationDelta,
  initialConfidence,
  outcomeFromRecurrence,
  preventsRecurrence,
} from "../src/confidence.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

describe("initialConfidence", () => {
  it("tiers by session count; more sessions, higher start", () => {
    expect(initialConfidence(1)).toBe(0.3);
    expect(initialConfidence(2)).toBe(0.3);
    expect(initialConfidence(3)).toBe(0.5);
    expect(initialConfidence(9)).toBe(0.7);
    expect(initialConfidence(50)).toBe(0.85);
  });

  it("the start never reaches the ceiling: more observations are not certainty", () => {
    expect(initialConfidence(10_000)).toBeLessThan(0.9);
  });
});

describe("confirmationDelta", () => {
  it("confirmation tapers: easily re-confirmed entries do not climb all the way to the top", () => {
    expect(confirmationDelta(0)).toBe(0.05);
    expect(confirmationDelta(2)).toBe(0.05);
    expect(confirmationDelta(3)).toBe(0.03);
    expect(confirmationDelta(5)).toBe(0.03);
    expect(confirmationDelta(6)).toBe(0.01);
    expect(confirmationDelta(99)).toBe(0.01);
  });
});

describe("adjustConfidence", () => {
  it("one contradiction cancels three first-tier confirmations; the asymmetry is deliberate", () => {
    const contradicted = adjustConfidence(0.5, "contradicted");
    const confirmedThrice = [0, 1, 2].reduce((value, count) => adjustConfidence(value, "confirmed", count).confidence, 0.5);
    expect(Number((0.5 - contradicted.confidence).toFixed(2))).toBe(0.15);
    expect(Number((confirmedThrice - 0.5).toFixed(2))).toBe(0.15);
  });

  it("inactive leaves confidence unchanged", () => {
    expect(adjustConfidence(0.42, "inactive").confidence).toBeCloseTo(0.42, 10);
  });

  it("clamped to [0.1, 0.9]; falling below the floor flags removal but the value never goes negative", () => {
    const floored = adjustConfidence(0.1, "contradicted");
    expect(floored.confidence).toBe(0.1);
    expect(floored.flaggedForRemoval).toBe(true);

    const capped = adjustConfidence(0.9, "confirmed");
    expect(capped.confidence).toBe(0.9);
    expect(capped.flaggedForRemoval).toBe(false);
  });
});

describe("applyPassiveDecay", () => {
  it("decays 0.05 per week: untouched lessons retire on their own", () => {
    const now = Date.UTC(2026, 0, 29);
    const fourWeeksAgo = new Date(now - 4 * WEEK_MS).toISOString();
    expect(applyPassiveDecay(0.5, fourWeeksAgo, now).confidence).toBeCloseTo(0.3, 10);
  });

  it("a clock set back does not hand out confidence", () => {
    const now = Date.UTC(2026, 0, 29);
    const future = new Date(now + 10 * WEEK_MS).toISOString();
    expect(applyPassiveDecay(0.5, future, now).confidence).toBeCloseTo(0.5, 10);
  });

  it("a broken timestamp means no decay, not NaN", () => {
    expect(applyPassiveDecay(0.5, "not-a-date").confidence).toBe(0.5);
  });
});

describe("outcomeFromRecurrence", () => {
  it("no recurrence after promotion = confirmed", () => {
    expect(outcomeFromRecurrence({ recurrencesAfter: 0, sessionsAfter: 12 })).toBe("confirmed");
  });

  it("still recurring after promotion = contradicted: fixed at the wrong layer", () => {
    expect(outcomeFromRecurrence({ recurrencesAfter: 3, sessionsAfter: 12 })).toBe("contradicted");
  });

  it("no sessions at all after promotion = nothing to judge by, not a confirmation", () => {
    expect(outcomeFromRecurrence({ recurrencesAfter: 0, sessionsAfter: 0 })).toBe("inactive");
  });
});

describe("preventsRecurrence", () => {
  it("gates and tools are preventive; recurrence can contradict them", () => {
    expect(preventsRecurrence("gate")).toBe(true);
    expect(preventsRecurrence("toolset")).toBe(true);
  });

  it("ledger records and notes are reference only, stop nothing, and recurrence cannot contradict them", () => {
    expect(preventsRecurrence("ledger")).toBe(false);
    expect(preventsRecurrence("note")).toBe(false);
  });
});
