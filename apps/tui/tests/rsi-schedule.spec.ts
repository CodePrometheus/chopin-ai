import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { credentialsFrom } from "../src/credentials.js";
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

    expect(await evolveIfDue([bin], home, idle)).toBe(false);
    await writeFile(join(home, "config.json"), JSON.stringify({ rsi: { weeklyBudgetUsd: 5 } }));
    expect(await evolveIfDue([bin], home, async () => false)).toBe(false);
    expect(await evolveIfDue([bin], home, idle)).toBe(true);
    expect(await until(join(home, "ran-evolve"))).toBe(true);
    expect(await evolveIfDue([bin], home, idle)).toBe(false);
    expect(await evolveIfDue([bin], home, idle, { now: Date.now() + EVOLVE_EVERY_MS })).toBe(true);
  });

  it("hands the loop credentials that live in the service alone through a pipe, never its command line or environment", async () => {
    const home = await mkdtemp(join(tmpdir(), "chopin-schedule-"));
    process.env.CHOPIN_HOME = home;
    await writeFile(join(home, "config.json"), JSON.stringify({ rsi: { weeklyBudgetUsd: 5 } }));
    // Stands in for chopin: it records how it was started and what reached it.
    const bin = join(home, "fake-chopin.mjs");
    await writeFile(bin, [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'const handed = process.argv.includes("--credentials-on-stdin") ? readFileSync(0, "utf8") : "";',
      'writeFileSync(process.env.CHOPIN_HOME + "/seen.json", JSON.stringify({ args: process.argv.slice(2), env: JSON.stringify(process.env), handed }));',
    ].join("\n"));
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("anthropic", async () => ({ type: "api_key", key: "sk-handed-over" }));

    expect(await evolveIfDue([bin], home, async () => true, { credentials })).toBe(true);
    expect(await until(join(home, "seen.json"))).toBe(true);
    const seen = JSON.parse(await readFile(join(home, "seen.json"), "utf8")) as { args: string[]; env: string; handed: string };
    expect(seen.args).toEqual(["evolve", "--credentials-on-stdin"]);
    expect(seen.env).not.toContain("sk-handed-over");
    const taken = await credentialsFrom(seen.handed);
    expect(await taken.read("anthropic")).toEqual({ type: "api_key", key: "sk-handed-over" });
  });
});
