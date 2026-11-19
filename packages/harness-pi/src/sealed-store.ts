import { mkdir, open, readFile, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CommitResult, ConversationId, EntryId, Id, Seq, Storage, StorageWrite } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { seal, unseal, Unsealable, writeSealed } from "./seal.js";

const SNAPSHOT = "snapshot";
const JOURNAL = "journal";
/** A journal record's header: the length of the sealed record that follows, then the record's number. */
const HEADER_BYTES = 12;
const SNAPSHOT_HEADER_BYTES = 8;

export interface SealedStoreOptions {
  /** The directory on the persistent volume that keeps the store, sealed. */
  dir: string;
  /** The store's own key, 32 bytes, kept in memory alone. */
  key: Uint8Array;
  /** A journal this long brings on a snapshot; 8 MiB by default. */
  snapshotAfterBytes?: number;
  /** A journal not emptied for this long is folded into a snapshot; ten minutes by default. */
  snapshotEveryMs?: number;
  /** What fails nothing yet is worth telling: a record a stop cut short, a snapshot that could not be written. */
  report?: (error: Error) => void;
}

/** A sealed store whose snapshot or journal was changed, reordered or spliced, so it is not opened. */
export class TamperedStore extends Error { }

/**
 * An owner's store, held in memory and sealed at rest. Each commit is sealed into a journal and flushed before it takes
 * effect; now and then, and on close, the whole store is sealed into a snapshot that empties the journal. Opening reads
 * the snapshot and replays the journal in order, refusing either when it was changed, reordered or spliced.
 *
 * Truncating an acknowledged tail or restoring an earlier pair requires an external freshness record to detect:
 * encryption alone cannot distinguish either from a crash before the missing commits were acknowledged.
 */
export async function openSealedStore(options: SealedStoreOptions): Promise<Storage> {
  const { dir, key, report = () => { } } = options;
  const pages = await stat(join(dir, "execution.sqlite")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (pages !== undefined) throw new Error("encrypted page storage requires its protected adapter; the legacy store cannot open this directory");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const journalFile = join(dir, JOURNAL);
  const snapshot = await readSnapshot(join(dir, SNAPSHOT), key);
  const journal = await readFile(journalFile).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  });
  // A store's first opening writes its snapshot before any commit, so a journal without one lost it.
  if (snapshot === undefined && journal.length > 0) throw new TamperedStore(`the store in ${dir} has a journal but no snapshot`);
  const database = new DatabaseSync(":memory:");
  let inner: SqliteStorage | undefined;
  let handle: FileHandle | undefined;
  let store: SealedStore | undefined;
  try {
    if (typeof database.serialize !== "function") throw new Error("a sealed store requires SQLite snapshot support in the runtime");
    if (snapshot !== undefined) database.deserialize(snapshot.image);
    inner = await SqliteStorage.open(new NodeSqliteDatabase(database));
    const replayed = await replay(journal, snapshot?.next ?? 0, key, inner, report);
    handle = await open(journalFile, "a", 0o600);
    // A record cut short is dropped, so the next one is appended where it belongs.
    if (replayed.end < journal.length) {
      await handle.truncate(replayed.end);
      await handle.sync();
    }
    store = new SealedStore(dir, key, database, inner, handle, replayed.next, replayed.end, options, report);
    if (snapshot === undefined || replayed.end > 0) await store.snapshot();
    return store.storage();
  } catch (error) {
    try {
      if (store !== undefined) await store.fail(error);
      else {
        try { await handle?.close(); }
        finally { if (inner !== undefined) await inner.close(BACKGROUND_CONTEXT); else if (database.isOpen) database.close(); }
      }
    } catch (closing) {
      throw new AggregateError([error, closing], "the store failed to open and close");
    }
    throw error;
  }
}

class SealedStore {
  readonly #dir: string;
  readonly #key: Uint8Array;
  readonly #database: DatabaseSync;
  readonly #inner: SqliteStorage;
  readonly #journal: FileHandle;
  readonly #snapshotAfterBytes: number;
  readonly #report: (error: Error) => void;
  readonly #folding: NodeJS.Timeout;
  /** The number of the next journal record. */
  #next: number;
  #journalBytes: number;
  /** Commits and snapshots, one at a time, so the journal holds commits in the order they took effect. */
  #line: Promise<unknown> = Promise.resolve();
  /** Why the journal can take no more: a record half written would have the next one appended after it. */
  #broken: unknown;
  #closing: Promise<void> | undefined;

  constructor(
    dir: string, key: Uint8Array, database: DatabaseSync, inner: SqliteStorage, journal: FileHandle, next: number, journalBytes: number,
    options: SealedStoreOptions, report: (error: Error) => void,
  ) {
    this.#dir = dir;
    this.#key = key;
    this.#database = database;
    this.#inner = inner;
    this.#journal = journal;
    this.#next = next;
    this.#journalBytes = journalBytes;
    this.#snapshotAfterBytes = options.snapshotAfterBytes ?? 8 * 1024 * 1024;
    this.#report = report;
    this.#folding = setInterval(() => {
      if (this.#journalBytes > 0) void this.#serially(() => this.#snapshotQuietly());
    }, options.snapshotEveryMs ?? 10 * 60_000);
    this.#folding.unref();
  }

  /** The store as the harness uses it: reads go to the store in memory; commits and closing go through the seal. */
  storage(): Storage {
    const inner = this.#inner;
    return {
      commit: (batches, receive, context) => this.#commit(batches, receive, context),
      mintId: <I extends Id<string>>() => this.#read(() => inner.mintId<I>()),
      conversation: (...args) => this.#read(() => inner.conversation(...args)),
      scanConversations: (...args) => this.#read(() => inner.scanConversations(...args)),
      entry: (...args: [EntryId, Context] | [ConversationId, EntryId, Context]) => this.#read(() =>
        args.length === 2 ? inner.entry(args[0], args[1]) : inner.entry(args[0], args[1], args[2])),
      findLatestHeadMarker: (...args) => this.#read(() => inner.findLatestHeadMarker(...args)),
      scanEntries: (...args) => this.#read(() => inner.scanEntries(...args)),
      task: (...args) => this.#read(() => inner.task(...args)),
      scanTasks: (...args) => this.#read(() => inner.scanTasks(...args)),
      submission: (...args) => this.#read(() => inner.submission(...args)),
      scanSubmissions: (...args) => this.#read(() => inner.scanSubmissions(...args)),
      submissionByRequest: (...args) => this.#read(() => inner.submissionByRequest(...args)),
      findDocument: (...args) => this.#read(() => inner.findDocument(...args)),
      document: (...args) => this.#read(() => inner.document(...args)),
      scanDocuments: (...args) => this.#read(() => inner.scanDocuments(...args)),
      close: (context) => this.#close(context),
    };
  }

  /** Ends an unsuccessful initialization without persisting its in-memory image. */
  fail(error: unknown): Promise<void> {
    this.#broken = error ?? new Error("the store failed to initialize");
    return this.#close(BACKGROUND_CONTEXT);
  }

  /** Seals the whole store into a snapshot, then empties the journal it now holds. */
  async snapshot(): Promise<void> {
    if (this.#broken !== undefined) throw this.#broken;
    await writeSealed(join(this.#dir, SNAPSHOT), this.#key, snapshotContext(this.#next), this.#database.serialize(), number64(this.#next));
    await this.#journal.truncate(0);
    await this.#journal.sync();
    this.#journalBytes = 0;
  }

  #commit(batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: Seq) => void, context: Context): Promise<CommitResult> {
    return this.#serially(async () => {
      if (this.#broken !== undefined) throw this.#broken;
      try {
        const detached = structuredClone(batches);
        const receipts: { index: number; seq: Seq }[] = [];
        const result = await this.#inner.commit(detached, (index, seq) => receipts.push({ index, seq }), context);
        if (result.stored === 0) return result;
        const payload = { version: 1, batches: detached.slice(0, result.stored) };
        const record = seal(this.#key, journalContext(this.#next), Buffer.from(JSON.stringify(payload)));
        const header = Buffer.alloc(HEADER_BYTES);
        header.writeUInt32BE(record.length, 0);
        header.writeBigUInt64BE(BigInt(this.#next), 4);
        await this.#journal.appendFile(Buffer.concat([header, record]));
        await this.#journal.datasync();
        this.#next += 1;
        this.#journalBytes += HEADER_BYTES + record.length;
        for (const receipt of receipts) receive(receipt.index, receipt.seq);
        if (this.#journalBytes >= this.#snapshotAfterBytes) await this.#snapshotQuietly();
        return result;
      } catch (error) {
        this.#broken = error ?? new Error("the store failed to commit");
        clearInterval(this.#folding);
        throw error;
      }
    });
  }

  #read<T>(read: () => Promise<T>): Promise<T> {
    return this.#serially(() => {
      if (this.#broken !== undefined) throw this.#broken;
      return read();
    });
  }

  #close(context: Context): Promise<void> {
    return this.#closing ??= this.#finish(context);
  }

  async #finish(context: Context): Promise<void> {
    clearInterval(this.#folding);
    try {
      await this.#serially(async () => {
        try {
          if (this.#broken === undefined && this.#journalBytes > 0) await this.snapshot();
        } finally {
          this.#broken ??= new Error("the store is closed");
        }
      });
    } finally {
      const closed = await Promise.allSettled([this.#journal.close(), this.#inner.close(context)]);
      const errors = closed.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (errors.length > 0) throw new AggregateError(errors, "the store failed to close");
    }
  }

  /** A snapshot that fails leaves the journal to hold what it would have; the commit that brought it on stands. */
  async #snapshotQuietly(): Promise<void> {
    await this.snapshot().catch((error: unknown) => this.#report(new Error("the store's snapshot could not be written; its journal still holds every commit", { cause: error })));
  }

  #serially<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#line.then(work);
    this.#line = next.catch(() => { });
    return next;
  }
}

async function readSnapshot(file: string, key: Uint8Array): Promise<{ next: number; image: Buffer } | undefined> {
  const bytes = await readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (bytes === undefined) return undefined;
  const next = bytes.length < SNAPSHOT_HEADER_BYTES ? -1 : Number(bytes.readBigUInt64BE(0));
  try {
    if (next < 0) throw new Unsealable();
    return { next, image: unseal(key, snapshotContext(next), bytes.subarray(SNAPSHOT_HEADER_BYTES)) };
  } catch (error) {
    if (!(error instanceof Unsealable)) throw error;
    throw new TamperedStore(`the store's snapshot in ${file} does not open with this key: it was changed, or is another's`);
  }
}

/**
 * Applies the journal's records from `next` on, in order, to `inner`; those before `next` the snapshot holds already,
 * left by a stop between writing it and emptying the journal. A commit that does not apply did not when it was made
 * either, since it met the same store in the same order; it is passed over as it was then.
 */
async function replay(journal: Buffer, next: number, key: Uint8Array, inner: SqliteStorage, report: (error: Error) => void): Promise<{ next: number; end: number }> {
  let at = 0;
  let expected = next;
  while (at < journal.length) {
    const length = journal.length - at < HEADER_BYTES ? Infinity : journal.readUInt32BE(at);
    if (journal.length - at - HEADER_BYTES < length) {
      report(new Error(`the store's journal ends within its record ${expected}, as a stop midway through writing leaves it; that commit was never acknowledged, so it is dropped`));
      break;
    }
    const seq = Number(journal.readBigUInt64BE(at + 4));
    const record = journal.subarray(at + HEADER_BYTES, at + HEADER_BYTES + length);
    at += HEADER_BYTES + length;
    if (seq < next && expected === next) continue;
    if (seq !== expected) throw new TamperedStore(`the store's journal holds record ${seq} where record ${expected} belongs: records were removed, reordered or added`);
    let payload: unknown;
    try {
      payload = JSON.parse(unseal(key, journalContext(seq), record).toString("utf8"));
    } catch (error) {
      if (!(error instanceof Unsealable)) throw error;
      throw new TamperedStore(`record ${seq} of the store's journal does not open with this key: it was changed`);
    }
    const legacy = Array.isArray(payload);
    const group = payload as { version?: unknown; batches?: unknown } | null;
    if (!legacy && (group?.version !== 1 || !Array.isArray(group.batches))) throw new TamperedStore(`record ${seq} has an unsupported journal format`);
    const batches = (legacy ? [payload] : group!.batches) as StorageWrite[][];
    const result = await inner.commit(batches, () => { }, BACKGROUND_CONTEXT);
    if (result.stored !== batches.length) {
      if (!legacy) throw new TamperedStore(`record ${seq} contains a batch that cannot be restored`, { cause: result.refused });
      report(new Error(`record ${seq} contains a legacy write that was refused`, { cause: result.refused }));
    }
    expected += 1;
  }
  return { next: expected, end: at };
}

function journalContext(seq: number): string {
  return `chopin store journal ${seq}`;
}

function snapshotContext(next: number): string {
  return `chopin store snapshot ${next}`;
}

function number64(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}
