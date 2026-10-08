import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";

import { PendingStore } from "../src/pending.js";
import type { PendingEntry } from "../src/pending.js";

let store: PendingStore;
let dir: string;

/** A fresh directory per test: with a shared one, candidates would merge into each other and the test would no longer cover this logic. */
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chopin-pending-"));
  store = new PendingStore(dir);
});

function candidate(overrides: Partial<Parameters<PendingStore["record"]>[0]> = {}) {
  return {
    id: "missing-context-flag",
    signal: "Error: kubectl apply failed for deployment/api-42 in ns prod-3",
    lesson: "Run kubectl diff before every apply.",
    evidence: "3 sessions, 5 times",
    proposal: "gate" as const,
    ...overrides,
  };
}

describe("record", () => {
  it("starting confidence set by session count", async () => {
    const entry = await store.record(candidate({ sessions: 8 }));
    expect(entry.confidence).toBe(0.7);
    expect(entry.sessions).toBe(8);
    expect(entry.confirmedCount).toBe(0);
  });

  it("the same thing with different numbers and paths merges into one entry after normalization, counts added", async () => {
    await store.record(candidate({ sessions: 1, occurrences: 2 }));
    const merged = await store.record(candidate({
      id: "a-different-id",
      signal: "Error: kubectl apply failed for deployment/api-9911 in ns prod-7",
      sessions: 4,
      occurrences: 3,
    }));

    expect((await store.list())).toHaveLength(1);
    expect(merged.id).toBe("missing-context-flag");
    expect(merged.occurrences).toBe(5);
    // More observations, sharper prior: sessions went from 1 to 4, the start from 0.3 to 0.5.
    expect(merged.confidence).toBe(0.5);
  });

  it("after feedback the prior yields to evidence and is no longer recomputed from session count", async () => {
    await store.record(candidate({ sessions: 1 }));
    await store.settle("missing-context-flag", "promoted");
    await store.feedback("missing-context-flag", "contradicted");

    // Move it back to the pending area to simulate "contradicted, then observed again".
    const promoted = parse(await readFile(join(dir, "promoted", "missing-context-flag.yaml"), "utf8")) as PendingEntry;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "missing-context-flag.yaml"), (await import("yaml")).stringify(promoted), "utf8");

    const again = await store.record(candidate({ sessions: 20 }));
    expect(again.confidence).toBeCloseTo(0.15, 6);
    expect(again.confidence).not.toBe(0.85);
  });
});

describe("settle", () => {
  it("promotion stamps a timestamp and leaves the pending area; feedback is measured from it", async () => {
    await store.record(candidate());
    await store.settle("missing-context-flag", "promoted");

    expect(await store.list()).toHaveLength(0);
    const [promoted] = await store.listPromoted();
    expect(promoted?.promotedAt).toBeTypeOf("string");
    // Edited in place, then moved atomically; nothing left behind.
    expect((await readdir(dir)).filter((n) => n.endsWith(".yaml"))).toHaveLength(0);
  });

  it("rejection stamps nothing: what never landed cannot be confirmed", async () => {
    await store.record(candidate());
    await store.settle("missing-context-flag", "rejected");
    expect(await store.listPromoted()).toHaveLength(0);
  });
});

describe("feedback", () => {
  it("confirmation raises, contradiction lowers, and contradiction moves more", async () => {
    await store.record(candidate({ sessions: 4 }));
    await store.settle("missing-context-flag", "promoted");

    const confirmed = await store.feedback("missing-context-flag", "confirmed");
    expect(confirmed.confidence.confidence).toBeCloseTo(0.55, 6);
    expect(confirmed.entry.confirmedCount).toBe(1);

    const contradicted = await store.feedback("missing-context-flag", "contradicted");
    expect(contradicted.confidence.confidence).toBeCloseTo(0.4, 6);
    expect(contradicted.entry.contradictedCount).toBe(1);
  });

  it("repeated contradiction falls to the floor and flags removal", async () => {
    await store.record(candidate({ sessions: 4 }));
    await store.settle("missing-context-flag", "promoted");
    let last = await store.feedback("missing-context-flag", "contradicted");
    for (let i = 0; i < 5; i += 1) last = await store.feedback("missing-context-flag", "contradicted");
    expect(last.confidence.confidence).toBe(0.1);
    expect(last.confidence.flaggedForRemoval).toBe(true);
  });

  it("inactive only decays and leaves the confirmed/contradicted counts alone", async () => {
    await store.record(candidate({ sessions: 4 }));
    await store.settle("missing-context-flag", "promoted");
    const result = await store.feedback("missing-context-flag", "inactive");
    expect(result.entry.confirmedCount).toBe(0);
    expect(result.entry.contradictedCount).toBe(0);
    expect(result.confidence.confidence).toBeCloseTo(0.5, 6);
  });

  it("decaying to the floor by time alone also flags removal: untouched lessons retire on their own", async () => {
    await store.record(candidate({ sessions: 4 }));
    await store.settle("missing-context-flag", "promoted");

    const { writeFile } = await import("node:fs/promises");
    const { stringify } = await import("yaml");
    const stale = (await store.listPromoted())[0] as PendingEntry;
    // Nine weeks = -0.45, from 0.5 through the floor.
    stale.updatedAt = new Date(Date.now() - 9 * 7 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(join(dir, "promoted", "missing-context-flag.yaml"), stringify(stale), "utf8");

    const result = await store.feedback("missing-context-flag", "inactive");
    expect(result.confidence.confidence).toBe(0.1);
    expect(result.confidence.flaggedForRemoval).toBe(true);
  });

  it("every settlement advances the timestamp, or the same decay would be deducted repeatedly", async () => {
    await store.record(candidate({ sessions: 4 }));
    await store.settle("missing-context-flag", "promoted");

    // Set the settlement point back four weeks. Deliberately not long enough to hit the floor:
    // clamping would hide "deducted twice" behind "both at the floor" and the test would prove nothing.
    const { writeFile } = await import("node:fs/promises");
    const { stringify } = await import("yaml");
    const stale = (await store.listPromoted())[0] as PendingEntry;
    stale.updatedAt = new Date(Date.now() - 4 * 7 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(join(dir, "promoted", "missing-context-flag.yaml"), stringify(stale), "utf8");

    // Four weeks = -0.2, from 0.5 to 0.3.
    const first = await store.feedback("missing-context-flag", "inactive");
    expect(first.confidence.confidence).toBeCloseTo(0.3, 6);

    // Review again right away: the settlement point advanced, so only these few milliseconds come off, not another four weeks.
    const second = await store.feedback("missing-context-flag", "inactive");
    expect(second.confidence.confidence).toBeCloseTo(0.3, 6);
  });
});

describe("feedback dry run", () => {
  it("computes the real projection without persisting", async () => {
    await store.record(candidate({ sessions: 4 }));
    await store.settle("missing-context-flag", "promoted");

    const preview = await store.feedback("missing-context-flag", "contradicted", { dryRun: true });
    expect(preview.confidence.confidence).toBeCloseTo(0.35, 6);

    const onDisk = (await store.listPromoted())[0] as PendingEntry;
    expect(onDisk.confidence).toBe(0.5);
    expect(onDisk.contradictedCount).toBe(0);
  });
});

describe("merge", () => {
  it("counts add up, time spans unite, and the absorbed entry is kept as a record, not deleted", async () => {
    await store.record(candidate({ sessions: 2, occurrences: 2 }));
    await store.record(candidate({ id: "other-wording", signal: "apply rejected: no diff was run", sessions: 5, occurrences: 1 }));

    const merged = await store.merge("missing-context-flag", "other-wording");
    expect(merged.occurrences).toBe(3);
    expect(merged.sessions).toBe(5);
    expect(merged.evidence).toContain("merged from other-wording");

    expect(await store.list()).toHaveLength(1);
    const absorbed = parse(await readFile(join(dir, "merged", "other-wording.yaml"), "utf8")) as PendingEntry;
    expect(absorbed.mergedInto).toBe("missing-context-flag");
  });

  it("cannot merge an entry into itself", async () => {
    await store.record(candidate());
    await expect(store.merge("missing-context-flag", "missing-context-flag")).rejects.toThrow(/itself/);
  });
});

describe("consolidationState", () => {
  it("empty before any pass, readable after one, and never read as a candidate", async () => {
    expect(await store.consolidationState()).toEqual({});
    await store.record(candidate());
    await store.markConsolidated(42);

    const state = await store.consolidationState();
    expect(state.lastRunSessionCount).toBe(42);
    expect(await store.list()).toHaveLength(1);
  });
});
