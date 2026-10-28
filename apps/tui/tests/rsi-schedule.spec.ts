import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { EVOLVE_EVERY_MS, evolveIfDue } from "../src/rsi/schedule.js";

const previous = process.env.CHOPIN_HOME;
afterEach(() => {
  if (previous === undefined) delete process.env.CHOPIN_HOME;
  else process.env.CHOPIN_HOME = previous;
});

async function until(path: string): Promise<boolean> {
  for (let i = 0; i < 100; i += 1) {
    if (await access(path).then(() => true, () => false)) return true;
    await sleep(20);
  }
  return false;
}

describe("evolveIfDue", () => {
  it("starts the loop only when it is set up, due, and the agent is idle", async () => {
    const home = await mkdtemp(join(tmpdir(), "chopin-schedule-"));
    process.env.CHOPIN_HOME = home;
    // Stands in for chopin: it records that it was started with "evolve".
    const bin = join(home, "fake-chopin.mjs");
    await writeFile(bin, 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.CHOPIN_HOME + "/ran-" + process.argv[2], "");\n');
    const idle = async () => true;

    expect(await evolveIfDue(bin, home, idle)).toBe(false);
    await writeFile(join(home, "config.json"), JSON.stringify({ rsi: { weeklyBudgetUsd: 5 } }));
    expect(await evolveIfDue(bin, home, async () => false)).toBe(false);
    expect(await evolveIfDue(bin, home, idle)).toBe(true);
    expect(await until(join(home, "ran-evolve"))).toBe(true);
    expect(await evolveIfDue(bin, home, idle)).toBe(false);
    expect(await evolveIfDue(bin, home, idle, Date.now() + EVOLVE_EVERY_MS)).toBe(true);
  });
});
