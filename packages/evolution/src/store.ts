import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { JsonlJournal } from "@chopin/journal";
import type { JournalOptions, JournalSnapshot, JournalSpec, JournalTransaction } from "@chopin/journal";

import { assertEvolutionEvent } from "./events.js";
import { foldEvolutionEvents } from "./fold.js";
import { renderEvolutionProjection } from "./projection.js";
import type { EvolutionEvent, EvolutionProjection } from "./types.js";

export class EvolutionLogCorruptError extends Error {
  constructor(readonly lineNumber: number, message: string) {
    super(`evolution log line ${lineNumber}: ${message}`);
    this.name = "EvolutionLogCorruptError";
  }
}

export class EvolutionLogLockError extends Error {
  constructor(path: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for evolution log lock ${path}`);
    this.name = "EvolutionLogLockError";
  }
}

export type EvolutionEventStoreOptions = JournalOptions;
export type EvolutionTransaction<T> = JournalTransaction<EvolutionEvent, T>;
/** Read-only history and projection of one file version; the returned content is deeply frozen. */
export type EvolutionSnapshot = JournalSnapshot<EvolutionEvent, EvolutionProjection>;

const EVOLUTION_JOURNAL: JournalSpec<EvolutionEvent, EvolutionProjection> = {
  name: "Evolution log",
  assertEvent: assertEvolutionEvent,
  fold: foldEvolutionEvents,
  corruptError: (lineNumber, message) => new EvolutionLogCorruptError(lineNumber, message),
  lockError: (lockPath, timeoutMs) => new EvolutionLogLockError(lockPath, timeoutMs),
};

/** The evolution JSONL event store: the only authority, replayed and validated on every append. */
export class EvolutionEventStore extends JsonlJournal<EvolutionEvent, EvolutionProjection> {
  constructor(path: string, options: EvolutionEventStoreOptions = {}) {
    super(path, EVOLUTION_JOURNAL, options);
  }

  async rebuildProjections(jsonPath: string, markdownPath: string): Promise<EvolutionProjection> {
    const projection = await this.fold();
    await Promise.all([
      atomicWrite(jsonPath, `${JSON.stringify(projection, null, 2)}\n`),
      atomicWrite(markdownPath, renderEvolutionProjection(projection)),
    ]);
    return projection;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const handle = await open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // The original error is the reason the caller needs to see.
    }
    throw error;
  }
}
