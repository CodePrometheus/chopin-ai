import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdmissionLedger, admitDaily, discount, PairedComparison, RECURRENCE, recurringPoints, recursOften, SCREEN_PAIRS, type Arm, type FixPoint, type ProtectPoint } from "../src/index.js";

/** A seeded generator, so the simulations below give the same numbers on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paired differences: +1 with `up`, -1 with `down`, 0 otherwise. */
const pairs = (random: () => number, up: number, down: number) => () => {
  const u = random();
  return u < up ? 1 : u < up + down ? -1 : 0;
};

function simulate(runs: number, margin: number, up: number, down: number, seed: number) {
  const random = seeded(seed);
  const draw = pairs(random, up, down);
  let accepted = 0;
  const lengths: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const test = new PairedComparison({ margin, alpha: 0.05, limit: 300 });
    while (test.standing === "continue") test.add(draw());
    if (test.standing === "accept") accepted += 1;
    lengths.push(test.for.count);
  }
  lengths.sort((a, b) => a - b);
  return { rate: accepted / runs, median: lengths[Math.floor(runs / 2)]! };
}

describe("sequential comparison", () => {
  it("keeps a candidate that is no better at most as often as its level allows", () => {
    expect(simulate(2000, 0, 0.2, 0.2, 1).rate).toBeLessThanOrEqual(0.05);
  });

  it("keeps a clearly better candidate almost always, long before the limit", () => {
    const { rate, median } = simulate(500, 0, 0.4, 0.1, 2);
    expect(rate).toBeGreaterThan(0.9);
    expect(median).toBeLessThan(120);
  });

  it("refuses a clearly worse candidate early", () => {
    const { rate, median } = simulate(500, 0, 0.1, 0.4, 3);
    expect(rate).toBe(0);
    expect(median).toBeLessThan(60);
  });

  it("for no worse, keeps a change that leaves most outcomes alone, and refuses one at the tolerance", () => {
    // Most decision points are untouched by one change, so its pairs are mostly ties.
    expect(simulate(500, -0.1, 0.05, 0.06, 4).rate).toBeGreaterThan(0.9);
    expect(simulate(2000, -0.1, 0.05, 0.15, 5).rate).toBeLessThanOrEqual(0.05);
  });

  it("for no worse, cannot settle within its limit when outcomes flip often both ways", () => {
    // About 2·σ²·ln(1/α)/d² pairs are needed; with σ² ≈ 0.42 and d = 0.08 that is over the limit of 300.
    expect(simulate(500, -0.1, 0.2, 0.22, 6).rate).toBeLessThan(0.5);
  });
});

describe("admission ledger", () => {
  it("tightens the level test by test and loosens it with each kept change", async () => {
    const ledger = new AdmissionLedger(join(await mkdtemp(join(tmpdir(), "chopin-ledger-")), "ledger.jsonl"));
    const first = await ledger.nextLevel();
    expect(first).toBeCloseTo(0.1 * discount(1));
    expect(await ledger.record("c1", 1)).toEqual({ kept: false, level: first });
    const second = await ledger.nextLevel();
    expect(second).toBeCloseTo(0.1 * discount(2));
    expect((await ledger.record("c2", 1e9)).kept).toBe(true);
    expect(await ledger.nextLevel()).toBeCloseTo(0.1 * discount(3) * 2);
  });

  it("finds an edited entry and cuts the ledger back to the entries before it", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "chopin-ledger-")), "ledger.jsonl");
    const ledger = new AdmissionLedger(path);
    await ledger.record("c1", 1);
    await ledger.record("c2", 1);
    await ledger.record("c3", 1);
    const lines = (await readFile(path, "utf8")).split("\n");
    lines[1] = lines[1]!.replace('"kept":false', '"kept":true');
    await writeFile(path, lines.join("\n"));
    expect(await ledger.intactCount()).toBe(1);
    expect(await ledger.recover()).toBe(2);
    expect(await ledger.intactCount()).toBe(1);
    await appendFile(path, '{"test":2}\n');
    expect(await ledger.intactCount()).toBe(1);
  });
});

describe("recurring points", () => {
  const failure = { cause: "wrong_command", behavior: "run_command", mechanism: "uses-npm-in-pnpm-repo" } as const;
  const points: FixPoint[] = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, context: "c", failure }));

  it("tries failures in turn until enough recur", async () => {
    const asked: string[] = [];
    const found = await recurringPoints(points, async (point) => (asked.push(point.id), Number(point.id.slice(1)) % 2 === 1));
    expect(found).toEqual({ recurring: points.filter((point) => ["f1", "f3", "f5"].includes(point.id)), repeats: 3, tried: 6 });
    expect(asked).toEqual(["f0", "f1", "f2", "f3", "f4", "f5"]);
  });

  it("continues a kind with few failures again, each continuation counted on its own", async () => {
    const asked: string[] = [];
    const found = await recurringPoints(points.slice(0, 2), async (point, draw) => (asked.push(`${point.id}@${draw}`), false));
    expect(found).toEqual({ recurring: [], repeats: 0, tried: RECURRENCE.tries });
    expect(asked).toEqual(["f0@0", "f1@0", "f0@1", "f1@1", "f0@2", "f1@2", "f0@3", "f1@3"]);
  });

  it("does not count a continuation it could not tell either way as tried", async () => {
    const found = await recurringPoints(points, async (point) => (point.id === "f0" ? undefined : false));
    expect(found).toEqual({ recurring: [], repeats: 0, tried: RECURRENCE.tries });
    let asked = 0;
    await recurringPoints(points, async (point) => ((asked += 1), point.id === "f0" ? undefined : false));
    expect(asked).toBe(RECURRENCE.tries + 1);
    // Points that never tell are not drawn without end.
    expect(await recurringPoints(points.slice(0, 2), async () => undefined)).toEqual({ recurring: [], repeats: 0, tried: 0 });
  });

  it("tests a kind only where its failures recur often enough for a screen to see them", () => {
    expect(recursOften({ repeats: 3, tried: 8 })).toBe(true);
    expect(recursOften({ repeats: 2, tried: 8 })).toBe(false);
    expect(recursOften({ repeats: 1, tried: 8 })).toBe(false);
    expect(recursOften({ repeats: 3, tried: 3 })).toBe(true);
    expect(recursOften({ repeats: 0, tried: 0 })).toBe(false);
  });

  it("gives up after its tries when the failure no longer happens", async () => {
    const found = await recurringPoints(points, async () => false);
    expect(found).toEqual({ recurring: [], repeats: 0, tried: RECURRENCE.tries });
  });
});

describe("daily admission", () => {
  const failure = { cause: "wrong_command", behavior: "run_command", mechanism: "uses-npm-in-pnpm-repo" } as const;
  const fixPoints: FixPoint[] = [{ id: "f1", context: "c", failure }, { id: "f2", context: "c", failure }];
  const protectPoints: ProtectPoint[] = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, context: "c", original: "good" }));

  /** A world where each version repeats the failure, and does right where the session went right, at fixed rates. */
  function world(rates: Record<Arm, { repeats: number; good: number; used?: boolean }>, seed: number) {
    const random = seeded(seed);
    return {
      continueAt: async (arm: Arm, point: FixPoint | ProtectPoint) => {
        const rate = rates[arm];
        const fails = "failure" in point ? random() < rate.repeats : random() >= rate.good;
        return { step: fails ? "bad" : "good", used: rate.used ?? true };
      },
      judgeRepeat: async (_point: FixPoint, step: string) => (step === "bad" ? "repeats" as const : "avoids" as const),
      judgeEquivalent: async (_point: ProtectPoint, step: string) => (step === "good" ? "as_good" as const : "worse" as const),
      random,
    };
  }

  async function admit(rates: Parameters<typeof world>[0], mustBeUsed = false) {
    const ledger = new AdmissionLedger(join(await mkdtemp(join(tmpdir(), "chopin-daily-")), "ledger.jsonl"));
    const certificate = await admitDaily({
      candidate: "c1", kind: "instruction", scope: { kind: "global" }, incumbent: 3, fixPoints, protectPoints, ledger,
      limit: 300, mustBeUsed, prediction: "stops using npm here", model: "p/haiku", ...world(rates, 11),
    });
    return { certificate, tests: await ledger.intactCount() };
  }

  const incumbent = { repeats: 0.8, good: 0.95 };

  it("keeps a change that fixes the failure and leaves the rest alone, and records the test", async () => {
    const { certificate, tests } = await admit({ candidate: { repeats: 0.1, good: 0.95 }, incumbent });
    expect(certificate.kept).toBe(true);
    expect(certificate.fixed.length).toBeGreaterThan(0);
    const { pairs, incumbentRepeated, candidateRepeated } = certificate.atFailures;
    expect(pairs).toBeGreaterThan(SCREEN_PAIRS);
    expect(incumbentRepeated / pairs).toBeGreaterThan(0.5);
    expect(candidateRepeated / pairs).toBeLessThan(0.3);
    expect(certificate.evidence).toBeGreaterThanOrEqual(1 / certificate.level);
    expect(tests).toBe(1);
  });

  it("refuses a change that changes nothing, long before the limit", async () => {
    const { certificate } = await admit({ candidate: incumbent, incumbent });
    expect(certificate.kept).toBe(false);
    expect(certificate.pairs).toBeLessThan(100);
  });

  it("refuses a fix that breaks as much as it mends", async () => {
    const { certificate } = await admit({ candidate: { repeats: 0.1, good: 0.25 }, incumbent });
    expect(certificate.kept).toBe(false);
    expect(certificate.broken.length).toBeGreaterThan(0);
  });

  it("refuses a change that mends none of the first failures it is tried on, without testing further", async () => {
    const ledger = new AdmissionLedger(join(await mkdtemp(join(tmpdir(), "chopin-daily-")), "ledger.jsonl"));
    let continued = 0;
    const { continueAt, ...judges } = world({ candidate: { repeats: 1, good: 1 }, incumbent: { repeats: 1, good: 1 } }, 5);
    const certificate = await admitDaily({
      candidate: "c1", kind: "instruction", scope: { kind: "global" }, incumbent: 3, fixPoints, protectPoints, ledger,
      limit: 300, mustBeUsed: false, prediction: "stops using npm here", model: "p/haiku", ...judges,
      continueAt: (arm, point) => (continued += 1, continueAt(arm, point)),
    });
    expect(certificate).toMatchObject({ kept: false, screenedOut: true, pairs: SCREEN_PAIRS });
    expect(continued).toBe(2 * SCREEN_PAIRS);
    expect(await ledger.intactCount()).toBe(1);
  });

  it("drops a point that cannot be continued, and asks about it no more", async () => {
    const ledger = new AdmissionLedger(join(await mkdtemp(join(tmpdir(), "chopin-daily-")), "ledger.jsonl"));
    const asked = new Map<string, number>();
    // Only a little better, so the test runs long and would draw the point again and again.
    const { continueAt, ...judges } = world({ candidate: { repeats: 0.7, good: 0.95 }, incumbent }, 3);
    await admitDaily({
      candidate: "c1", kind: "instruction", scope: { kind: "global" }, incumbent: 3, fixPoints, protectPoints, ledger,
      limit: 300, mustBeUsed: false, prediction: "stops using npm here", model: "p/haiku", ...judges,
      continueAt: async (arm, point) => {
        asked.set(point.id, (asked.get(point.id) ?? 0) + 1);
        return point.id === "p0" ? undefined : continueAt(arm, point);
      },
    });
    expect(asked.get("p0")).toBe(2);
  });

  it("refuses a change that mends one point where the agent failed, however often it is drawn there", async () => {
    const ledger = new AdmissionLedger(join(await mkdtemp(join(tmpdir(), "chopin-daily-")), "ledger.jsonl"));
    // The change mends f1 every time; at f2 it does better in one pair and worse in the next, which mends nothing.
    const atF2 = { candidate: 0, incumbent: 0 };
    const step = (arm: Arm, point: FixPoint | ProtectPoint) => {
      if (!("failure" in point)) return "good";
      if (point.id === "f1") return arm === "candidate" ? "good" : "bad";
      const pair = atF2[arm]++;
      return (pair % 2 === 0) === (arm === "candidate") ? "bad" : "good";
    };
    const certificate = await admitDaily({
      candidate: "c1", kind: "instruction", scope: { kind: "global" }, incumbent: 3, fixPoints, protectPoints, ledger,
      limit: 300, mustBeUsed: false, prediction: "stops using npm here", model: "p/haiku", random: seeded(7),
      continueAt: async (arm, point) => ({ step: step(arm, point), used: true }),
      judgeRepeat: async (_point, step) => (step === "bad" ? "repeats" : "avoids"),
      judgeEquivalent: async () => "as_good",
    });
    expect(certificate.evidence).toBeGreaterThanOrEqual(1 / certificate.level);
    expect(certificate).toMatchObject({ kept: false, fixed: ["f1"] });
  });

  it("refuses a change that must be used and never was", async () => {
    expect((await admit({ candidate: { repeats: 0.1, good: 0.95, used: false }, incumbent }, true)).certificate.kept).toBe(false);
  });
});
