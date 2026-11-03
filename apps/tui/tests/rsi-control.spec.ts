import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { answerCorrections, changeLoopSettings, decideHeld, loopChanges, loopSettings, loopStanding, undoChange } from "../src/rsi/control.js";

const previous = process.env.CHOPIN_HOME;
afterEach(() => {
  if (previous === undefined) delete process.env.CHOPIN_HOME;
  else process.env.CHOPIN_HOME = previous;
});

describe("the loop's control", () => {
  it("changes only the loop settings given, a null clearing one, and keeps every other", async () => {
    const home = await mkdtemp(join(tmpdir(), "chopin-control-"));
    process.env.CHOPIN_HOME = home;
    await writeFile(join(home, "config.json"), JSON.stringify({ model: "a/b", rsi: { transcriptSources: ["~/logs"], weeklyBudgetUsd: 1 } }));

    expect(await changeLoopSettings({ weeklyBudgetUsd: 5, regularModel: "a/cheap", holdForReview: true }))
      .toEqual({ weeklyBudgetUsd: 5, regularModel: "a/cheap", strongModel: null, holdForReview: true });
    expect(await changeLoopSettings({ regularModel: null })).toMatchObject({ regularModel: null, weeklyBudgetUsd: 5 });
    const kept = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as { model: string; rsi: Record<string, unknown> };
    expect(kept.model).toBe("a/b");
    expect(kept.rsi).toEqual({ transcriptSources: ["~/logs"], weeklyBudgetUsd: 5, holdForReview: true });
    expect(await loopSettings()).toEqual({ weeklyBudgetUsd: 5, regularModel: null, strongModel: null, holdForReview: true });
  });

  it("stands at nothing in a new home, and says why it cannot act on what is not there", async () => {
    process.env.CHOPIN_HOME = await mkdtemp(join(tmpdir(), "chopin-control-"));
    expect(await loopStanding()).toMatchObject({ inUse: 0, archived: 0, kinds: 0, corrections: 0, held: 0, spentUsd: 0, weeklyBudgetUsd: null });
    expect(await loopChanges()).toEqual([]);
    expect(await undoChange("abc")).toBe("no change in use starts with abc");
    expect(await answerCorrections("terse", true)).toBe("no kind of correction terse waits for an answer");
    expect(await decideHeld("h1", true)).toBe("no change h1 waits for your review");
  });
});
