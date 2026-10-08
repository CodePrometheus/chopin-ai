import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { access, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

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

export interface EvolutionEventStoreOptions {
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  staleLockMs?: number;
  maxLineBytes?: number;
}

export interface EvolutionTransaction<T> {
  events: readonly EvolutionEvent[];
  value: T;
}

/** Read-only history and projection of one file version; the returned content is deeply frozen. */
export interface EvolutionSnapshot {
  readonly revision: string;
  readonly events: readonly EvolutionEvent[];
  readonly projection: EvolutionProjection;
}

interface CachedHistory {
  revision: string;
  events: EvolutionEvent[];
  snapshot?: EvolutionSnapshot;
}

function fileRevision(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid: number): boolean {
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

/** JSONL event store; the queue keeps this instance's call order, the lock file covers other instances and processes on the same machine. */
export class EvolutionEventStore {
  private readonly lockPath: string;
  private readonly options: Required<EvolutionEventStoreOptions>;
  private queue: Promise<void> = Promise.resolve();
  private cached?: CachedHistory;

  constructor(readonly path: string, options: EvolutionEventStoreOptions = {}) {
    this.lockPath = `${path}.lock`;
    this.options = {
      lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      lockRetryMs: options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS,
      staleLockMs: options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
      maxLineBytes: options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
    };
  }

  append(event: EvolutionEvent): Promise<void> {
    return this.appendMany([event]);
  }

  appendMany(events: readonly EvolutionEvent[]): Promise<void> {
    if (events.length === 0) return Promise.resolve();
    for (const event of events) assertEvolutionEvent(event);

    return this.enqueue(() => this.appendLocked(events));
  }

  /**
   * Check the current projection and append events under one cross-process lock.
   *
   * Runtime activation cannot do "fold first, then append": if quarantine / retire
   * lands between the two steps, a fake loaded receipt gets written for a version that
   * is already void. The caller's assertion runs after the authoritative history is
   * replayed and before the write; a failed assertion lands no bytes.
   */
  appendChecked(events: readonly EvolutionEvent[], assertCurrent: (projection: EvolutionProjection) => void): Promise<void> {
    if (events.length === 0) return Promise.resolve();
    for (const event of events) assertEvolutionEvent(event);
    return this.enqueue(() => this.appendLocked(events, assertCurrent));
  }

  /** Read the authoritative projection, compute events and commit under one cross-process lock, returning the deterministic result the caller needs. */
  transact<T>(derive: (projection: EvolutionProjection, history: readonly EvolutionEvent[]) => EvolutionTransaction<T>): Promise<T> {
    return this.enqueue(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const release = await this.acquireLock();
      try {
        this.cached = undefined;
        const history = await this.readAllUnlocked();
        const transaction = derive(foldEvolutionEvents(history), history);
        for (const event of transaction.events) assertEvolutionEvent(event);
        await this.appendFreshUnlocked(history, transaction.events);
        return transaction.value;
      } finally {
        await release();
      }
    });
  }

  readAll(): Promise<EvolutionEvent[]> {
    return this.enqueue(async () => structuredClone((await this.readCurrent()).events));
  }

  snapshot(): Promise<EvolutionSnapshot> {
    return this.enqueue(async () => {
      const current = await this.readCurrent();
      current.snapshot ??= freeze({ revision: current.revision, events: current.events,
        projection: foldEvolutionEvents(current.events) });
      return current.snapshot;
    });
  }

  private async revision(): Promise<string> {
    try { return fileRevision(await stat(this.path, { bigint: true })); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }

  private async readCurrent(): Promise<CachedHistory> {
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

  private async readLocked(): Promise<CachedHistory> {
    await mkdir(dirname(this.path), { recursive: true });
    const release = await this.acquireLock();
    try {
      const revision = await this.revision();
      const events = await this.readAllUnlocked();
      if (revision !== await this.revision()) throw new Error("Evolution log changed while reading");
      return this.cached = { revision, events: freeze(events) };
    } finally {
      await release();
    }
  }

  private async readAllUnlocked(): Promise<EvolutionEvent[]> {
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
    const events: EvolutionEvent[] = [];
    let lineNumber = 0;

    try {
      for await (const line of lines) {
        lineNumber += 1;
        if (Buffer.byteLength(line, "utf8") > this.options.maxLineBytes) {
          throw new EvolutionLogCorruptError(lineNumber, `line exceeds ${this.options.maxLineBytes} bytes`);
        }
        if (line.trim() === "") throw new EvolutionLogCorruptError(lineNumber, "blank lines are not allowed");
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          throw new EvolutionLogCorruptError(lineNumber, `invalid JSON: ${(error as Error).message}`);
        }
        try {
          assertEvolutionEvent(parsed);
        } catch (error) {
          throw new EvolutionLogCorruptError(lineNumber, (error as Error).message);
        }
        events.push(parsed);
      }
      if (!terminated) throw new EvolutionLogCorruptError(lineNumber, "unterminated final line");
    } finally {
      lines.close();
      stream.destroy();
      await file.close();
    }
    return events;
  }

  async fold(): Promise<EvolutionProjection> {
    return structuredClone((await this.snapshot()).projection);
  }

  async rebuildProjections(jsonPath: string, markdownPath: string): Promise<EvolutionProjection> {
    const projection = await this.fold();
    await Promise.all([
      atomicWrite(jsonPath, `${JSON.stringify(projection, null, 2)}\n`),
      atomicWrite(markdownPath, renderEvolutionProjection(projection)),
    ]);
    return projection;
  }

  private async appendLocked(
    events: readonly EvolutionEvent[],
    assertCurrent?: (projection: EvolutionProjection) => void,
  ): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const release = await this.acquireLock();
    try {
      this.cached = undefined;
      const history = await this.readAllUnlocked();
      assertCurrent?.(foldEvolutionEvents(history));
      await this.appendFreshUnlocked(history, events);
    } finally {
      await release();
    }
  }

  private async appendFreshUnlocked(history: readonly EvolutionEvent[], events: readonly EvolutionEvent[]): Promise<void> {
    foldEvolutionEvents([...history, ...events]);
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
        throw new EvolutionLogCorruptError(history.length + index + 1, `line exceeds ${this.options.maxLineBytes} bytes`);
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
      if (Date.now() >= deadline) throw new EvolutionLogLockError(this.lockPath, this.options.lockTimeoutMs);
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
