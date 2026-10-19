import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

const SQLITE_BUSY = 5;
const LOCK_WAIT_MS = 1_000;

/**
 * An exclusive lock on `file` that the OS drops when this process ends; `undefined` when another holds it. `waitMs`
 * waits out the brief locks of daemons starting at the same moment, so one of them wins rather than none.
 */
export function exclusive(file: string, waitMs = LOCK_WAIT_MS): DatabaseSync | undefined {
  const database = new DatabaseSync(file);
  try {
    database.exec(`PRAGMA busy_timeout = ${waitMs}; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE`);
    return database;
  } catch (error) {
    database.close();
    if ((error as { errcode?: number }).errcode === SQLITE_BUSY) return undefined;
    throw error;
  }
}

/**
 * Runs `work` holding the lock on `file`, across processes, waiting for it without blocking this one: work under the
 * lock, such as refreshing a token, may take a while.
 */
export async function locked<T>(file: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (;;) {
    signal?.throwIfAborted();
    const lock = exclusive(file, 0);
    if (lock !== undefined) {
      try {
        return await work();
      } finally {
        lock.close();
      }
    }
    await sleep(25, undefined, signal && { signal });
  }
}
