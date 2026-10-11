/**
 * Append-only JSONL journal: the file is the only authority, and every append replays and
 * validates the whole history plus the new events under one cross-process lock. Readers get
 * a deeply frozen snapshot cached per file revision.
 *
 * The journal knows nothing about its events: the caller supplies the per-line validator,
 * the fold that turns history into a projection (and rejects an invalid sequence), and the
 * errors to raise, so each store keeps its own vocabulary.
 *
 * @module @chopin/journal
 */

import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { access, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

/** Every journal event carries a stable id; appending an id already in the history is a no-op. */
export interface JournalEvent {
  readonly eventId: string;
}

export interface JournalSpec<E extends JournalEvent, P> {
  /** Name used in messages, such as "Evolution log". */
  readonly name: string;
  /** Throws when a parsed line is not a valid event. */
  readonly assertEvent: (value: unknown) => asserts value is E;
  /** Replays history into the projection; throws when the sequence is invalid. */
  readonly fold: (events: readonly E[]) => P;
  /** The error for a malformed line; `lineNumber` is 1-based. */
  readonly corruptError: (lineNumber: number, message: string) => Error;
  /** The error when the lock cannot be taken in time. */
  readonly lockError: (lockPath: string, timeoutMs: number) => Error;
}

export interface JournalOptions {
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  staleLockMs?: number;
  maxLineBytes?: number;
}

export interface JournalTransaction<E extends JournalEvent, T> {
  events: readonly E[];
  value: T;
}

/** Read-only history and projection of one file version; the returned content is deeply frozen. */
export interface JournalSnapshot<E extends JournalEvent, P> {
  readonly revision: string;
  readonly events: readonly E[];
  readonly projection: P;
}

interface CachedHistory<E extends JournalEvent, P> {
  revision: string;
  events: E[];
  snapshot?: JournalSnapshot<E, P>;
}

interface LockOwner {
  pid: number;
  createdAt: string;
  nonce: string;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 20;
const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

function fileRevision(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

export function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether a process with this id exists on this machine; one owned by another user still counts. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** The queue keeps this instance's call order; the lock file covers other instances and processes on the same machine. */
export class JsonlJournal<E extends JournalEvent, P> {
  private readonly lockPath: string;
  private readonly options: Required<JournalOptions>;
  private queue: Promise<void> = Promise.resolve();
  private cached?: CachedHistory<E, P>;

  constructor(readonly path: string, private readonly spec: JournalSpec<E, P>, options: JournalOptions = {}) {
    this.lockPath = `${path}.lock`;
    this.options = {
      lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      lockRetryMs: options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS,
      staleLockMs: options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
      maxLineBytes: options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
    };
  }

  append(event: E): Promise<void> {
    return this.appendMany([event]);
  }

  appendMany(events: readonly E[]): Promise<void> {
    if (events.length === 0) return Promise.resolve();
    for (const event of events) this.spec.assertEvent(event);
    return this.enqueue(() => this.appendLocked(events));
  }

  /**
   * Check the current projection and append events under one cross-process lock. The
   * assertion runs after the authoritative history is replayed and before the write; a
   * failed assertion lands no bytes.
   */
  appendChecked(events: readonly E[], assertCurrent: (projection: P) => void): Promise<void> {
    if (events.length === 0) return Promise.resolve();
    for (const event of events) this.spec.assertEvent(event);
    return this.enqueue(() => this.appendLocked(events, assertCurrent));
  }

  /** Read the authoritative projection, compute events and commit under one cross-process lock, returning the deterministic result the caller needs. */
  transact<T>(derive: (projection: P, history: readonly E[]) => JournalTransaction<E, T>): Promise<T> {
    return this.enqueue(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const release = await this.acquireLock();
      try {
        this.cached = undefined;
        const history = await this.readAllUnlocked();
        const transaction = derive(this.spec.fold(history), history);
        for (const event of transaction.events) this.spec.assertEvent(event);
        await this.appendFreshUnlocked(history, transaction.events);
        return transaction.value;
      } finally {
        await release();
      }
    });
  }

  readAll(): Promise<E[]> {
    return this.enqueue(async () => structuredClone((await this.readCurrent()).events));
  }

  snapshot(): Promise<JournalSnapshot<E, P>> {
    return this.enqueue(async () => {
      const current = await this.readCurrent();
      current.snapshot ??= freeze({ revision: current.revision, events: current.events,
        projection: this.spec.fold(current.events) });
      return current.snapshot;
    });
  }

  async fold(): Promise<P> {
    return structuredClone((await this.snapshot()).projection);
  }

  private async revision(): Promise<string> {
    try { return fileRevision(await stat(this.path, { bigint: true })); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }

  private async readCurrent(): Promise<CachedHistory<E, P>> {
    try {
      const revision = await this.revision();
      if (this.cached?.revision === revision && !(await fileExists(this.lockPath))) return this.cached;
      this.cached = undefined;
      return await this.readLocked();
    } catch (error) {
      this.cached = undefined;
      throw error;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.queue.then(operation);
    this.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async readLocked(): Promise<CachedHistory<E, P>> {
    await mkdir(dirname(this.path), { recursive: true });
    const release = await this.acquireLock();
    try {
      const revision = await this.revision();
      const events = await this.readAllUnlocked();
      if (revision !== await this.revision()) throw new Error(`${this.spec.name} changed while reading`);
      return this.cached = { revision, events: freeze(events) };
    } finally {
      await release();
    }
  }

  private async readAllUnlocked(): Promise<E[]> {
    if (!(await fileExists(this.path))) return [];
    const file = await open(this.path, "r");
    let terminated = true;
    try {
      const info = await file.stat();
      if (info.size > 0) {
        const tail = Buffer.allocUnsafe(1);
        await file.read(tail, 0, 1, info.size - 1);
        terminated = tail[0] === 0x0a;
      }
    } catch (error) {
      await file.close();
      throw error;
    }

    const stream = file.createReadStream({ encoding: "utf8", start: 0, autoClose: false });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const events: E[] = [];
    let lineNumber = 0;

    try {
      for await (const line of lines) {
        lineNumber += 1;
        if (Buffer.byteLength(line, "utf8") > this.options.maxLineBytes) {
          throw this.spec.corruptError(lineNumber, `line exceeds ${this.options.maxLineBytes} bytes`);
        }
        if (line.trim() === "") throw this.spec.corruptError(lineNumber, "blank lines are not allowed");
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          throw this.spec.corruptError(lineNumber, `invalid JSON: ${(error as Error).message}`);
        }
        try {
          this.spec.assertEvent(parsed);
        } catch (error) {
          throw this.spec.corruptError(lineNumber, (error as Error).message);
        }
        events.push(parsed);
      }
      if (!terminated) throw this.spec.corruptError(lineNumber, "unterminated final line");
    } finally {
      lines.close();
      stream.destroy();
      await file.close();
    }
    return events;
  }

  private async appendLocked(events: readonly E[], assertCurrent?: (projection: P) => void): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const release = await this.acquireLock();
    try {
      this.cached = undefined;
      const history = await this.readAllUnlocked();
      assertCurrent?.(this.spec.fold(history));
      await this.appendFreshUnlocked(history, events);
    } finally {
      await release();
    }
  }

  private async appendFreshUnlocked(history: readonly E[], events: readonly E[]): Promise<void> {
    this.spec.fold([...history, ...events]);
    const seen = new Set(history.map((event) => event.eventId));
    const fresh = events.filter((event) => {
      if (seen.has(event.eventId)) return false;
      seen.add(event.eventId);
      return true;
    });
    if (fresh.length === 0) return;

    const lines = fresh.map((event, index) => {
      const line = JSON.stringify(event);
      if (Buffer.byteLength(line, "utf8") > this.options.maxLineBytes) {
        throw this.spec.corruptError(history.length + index + 1, `line exceeds ${this.options.maxLineBytes} bytes`);
      }
      return line;
    });
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.writeFile(`${lines.join("\n")}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const deadline = Date.now() + this.options.lockTimeoutMs;
    await mkdir(dirname(this.lockPath), { recursive: true });
    while (true) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        const owner: LockOwner = { pid: process.pid, createdAt: new Date().toISOString(), nonce: randomUUID() };
        try {
          await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(this.lockPath).catch(() => undefined);
          throw error;
        }
        return async () => {
          await handle.close();
          try {
            await unlink(this.lockPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      await this.removeStaleLock();
      if (Date.now() >= deadline) throw this.spec.lockError(this.lockPath, this.options.lockTimeoutMs);
      await wait(this.options.lockRetryMs);
    }
  }

  private async removeStaleLock(): Promise<void> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(this.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (Date.now() - info.mtimeMs <= this.options.staleLockMs) return;

    let owner: Partial<LockOwner> = {};
    try {
      owner = JSON.parse(await readFile(this.lockPath, "utf8")) as Partial<LockOwner>;
    } catch {
      // A lock that timed out and whose owner cannot be read is treated as crash residue.
    }
    if (typeof owner.pid === "number" && processIsAlive(owner.pid)) return;
    try {
      await unlink(this.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
