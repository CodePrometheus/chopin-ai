import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLASSIFIER_VERSION, LayerVersions } from "@chopin-ai/core";
import { afterEach, describe, expect, it } from "vitest";
import { Evidence } from "../src/rsi/harvest.js";
import { loopSummary } from "../src/rsi/summary.js";

const previous = process.env.CHOPIN_HOME;
afterEach(() => {
  if (previous === undefined) delete process.env.CHOPIN_HOME;
  else process.env.CHOPIN_HOME = previous;
});

describe("loopSummary", () => {
  it("says what is new once, and nothing when nothing is", async () => {
    process.env.CHOPIN_HOME = await mkdtemp(join(tmpdir(), "chopin-summary-"));
    const root = join(process.env.CHOPIN_HOME, "rsi");
    expect(await loopSummary()).toBeUndefined();

    await new LayerVersions(join(root, "layer")).commit(() => [{
      id: "i1", kind: "instruction", text: "Run the tests first.", validated: { models: ["p/m"], harnesses: ["pi"] }, source: {},
      pinned: false, archived: false, added: new Date().toISOString(),
    }]);
    const evidence = new Evidence(join(root, "evidence"));
    const signature = { cause: "wrong_command", behavior: "run_command", mechanism: "uses-npm-in-pnpm-repo" } as const;
    for (const session of ["s1", "s2"]) {
      await evidence.addCorrection({ session, line: 3, step: 2, summary: "use pnpm", signature, classifier: CLASSIFIER_VERSION });
    }
    expect(await loopSummary()).toBe("RSI: kept 1 change since last time · 1 kind of correction to confirm (chopin evolve corrections) · $0.00 spent this week");
    // The corrections still wait, so they are said again; the kept change is not.
    expect(await loopSummary()).toBe("RSI: 1 kind of correction to confirm (chopin evolve corrections) · $0.00 spent this week");
  });
});
