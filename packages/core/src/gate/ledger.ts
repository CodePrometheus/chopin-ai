import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** The share of kept changes that may be false, over the loop's whole life. */
export const FALSE_DISCOVERY_RATE = 0.1;

/**
 * The discount sequence of the test levels; it sums to about one over all tests, so the level of later tests shrinks
 * only as fast as it must.
 */
export function discount(test: number): number {
  return (0.07720838 * Math.log(Math.max(test, 2))) / (test * Math.exp(Math.sqrt(Math.log(test))));
}

interface Entry {
  test: number;
  candidate: string;
  level: number;
  evidence: number;
  kept: boolean;
  previous: string;
  hash: string;
}

/**
 * Every admission test the loop has run, in order, as JSON Lines chained by hash so an edit shows. Levels follow
 * e-LOND: the t-th test keeps its candidate when the evidence reaches 1 / (rate · discount(t) · (kept so far + 1)),
 * which bounds the share of false changes kept under any dependence between the tests.
 */
export class AdmissionLedger {
  readonly path: string;
  readonly rate: number;

  constructor(path: string, rate = FALSE_DISCOVERY_RATE) {
    this.path = path;
    this.rate = rate;
  }

  /** The level the next test must meet: its evidence has to reach the inverse. */
  async nextLevel(): Promise<number> {
    const entries = await this.#entries();
    const kept = entries.filter((entry) => entry.kept).length;
    return this.rate * discount(entries.length + 1) * (kept + 1);
  }

  /** Records a finished test; it keeps its candidate when its evidence met the level it was given. */
  async record(candidate: string, evidence: number): Promise<{ kept: boolean; level: number }> {
    const entries = await this.#entries();
    const level = await this.nextLevel();
    const kept = evidence >= 1 / level;
    const previous = entries.at(-1)?.hash ?? "";
    const body = { test: entries.length + 1, candidate, level, evidence, kept, previous };
    const entry: Entry = { ...body, hash: digest(body) };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`);
    return { kept, level };
  }

  /** How many leading entries are as they were written; the rest were edited or appended out of turn. */
  async intactCount(): Promise<number> {
    const lines = await this.#lines();
    let previous = "";
    for (const [index, line] of lines.entries()) {
      let entry: Entry;
      try {
        entry = JSON.parse(line) as Entry;
      } catch {
        return index;
      }
      const { hash, ...body } = entry;
      if (entry.previous !== previous || entry.test !== index + 1 || digest(body) !== hash) return index;
      previous = hash;
    }
    return lines.length;
  }

  /** Cuts the ledger back to its intact entries, saying how many it dropped. */
  async recover(): Promise<number> {
    const lines = await this.#lines();
    const intact = await this.intactCount();
    if (intact === lines.length) return 0;
    const temporary = `${this.path}.${process.pid}`;
    await writeFile(temporary, lines.slice(0, intact).map((line) => `${line}\n`).join(""));
    await rename(temporary, this.path);
    return lines.length - intact;
  }

  async #entries(): Promise<Entry[]> {
    return (await this.#lines()).map((line) => JSON.parse(line) as Entry);
  }

  async #lines(): Promise<string[]> {
    const text = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return text.split("\n").filter((line) => line !== "");
  }
}

function digest(body: Omit<Entry, "hash">): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}
