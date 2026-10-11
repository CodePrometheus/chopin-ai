import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { JsonlJournal } from "../src/index.js";
import type { JournalSpec } from "../src/index.js";

/** A counter that may never go below zero: the smallest event log with a rule the fold enforces. */
interface Step { eventId: string; delta: number }

class CounterCorrupt extends Error {
  constructor(readonly lineNumber: number, message: string) { super(`counter line ${lineNumber}: ${message}`); }
}
class CounterLocked extends Error {}

const COUNTER: JournalSpec<Step, number> = {
  name: "Counter log",
  assertEvent(value: unknown): asserts value is Step {
    const step = value as Partial<Step> | null;
    if (typeof step?.eventId !== "string" || typeof step.delta !== "number") throw new Error("not a step");
  },
  fold(events) {
    let total = 0;
    for (const event of events) {
      total += event.delta;
      if (total < 0) throw new Error("counter below zero");
    }
    return total;
  },
  corruptError: (lineNumber, message) => new CounterCorrupt(lineNumber, message),
  lockError: () => new CounterLocked(),
};

const directories: string[] = [];
async function journal(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "journal-"));
  directories.push(directory);
  return new JsonlJournal(join(directory, "counter.jsonl"), COUNTER, options);
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JsonlJournal", () => {
  it("replays the caller's fold and skips an event id already in the history", async () => {
    const counter = await journal();
    await counter.appendMany([{ eventId: "a", delta: 2 }, { eventId: "b", delta: 3 }]);
    await counter.append({ eventId: "a", delta: 2 });
    expect(await counter.fold()).toBe(5);
    expect((await readFile(counter.path, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("lands no bytes when the fold rejects the new history", async () => {
    const counter = await journal();
    await counter.append({ eventId: "a", delta: 1 });
    const before = await readFile(counter.path, "utf8");
    await expect(counter.append({ eventId: "b", delta: -2 })).rejects.toThrow("counter below zero");
    expect(await readFile(counter.path, "utf8")).toBe(before);
  });

  it("returns a transaction's value and commits its events under the lock", async () => {
    const counter = await journal();
    const value = await counter.transact((total) => ({ events: [{ eventId: "t", delta: total + 4 }], value: "committed" }));
    expect(value).toBe("committed");
    expect((await counter.snapshot()).projection).toBe(4);
  });

  it("raises the caller's error for a corrupt line", async () => {
    const counter = await journal();
    await writeFile(counter.path, '{"eventId":"a","delta":1}\n{"broken":\n');
    const error = await counter.readAll().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CounterCorrupt);
    expect(error).toMatchObject({ lineNumber: 2 });
  });

  it("raises the caller's error when the lock cannot be taken in time", async () => {
    const counter = await journal({ lockTimeoutMs: 50, lockRetryMs: 5 });
    await writeFile(`${counter.path}.lock`, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), nonce: "held" }));
    await expect(counter.append({ eventId: "a", delta: 1 })).rejects.toBeInstanceOf(CounterLocked);
  });
});
