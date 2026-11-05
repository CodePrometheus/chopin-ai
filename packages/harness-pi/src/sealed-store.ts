import { mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Seq, Storage, StorageWrite } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { seal, unseal, Unsealable, writeSealed } from "./seal.js";

// Node 24.16 added these; the type definitions this package builds with predate them.
declare module "node:sqlite" {
  interface DatabaseSync {
    serialize(dbName?: string): Uint8Array;
    deserialize(buffer: Uint8Array, options?: { dbName?: string }): void;
  }
}

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
export class TamperedStore extends Error {}

/**
 * An owner's store, held in memory and sealed at rest. Each commit is sealed into a journal and flushed before it takes
 * effect; now and then, and on close, the whole store is sealed into a snapshot that empties the journal. Opening reads
 * the snapshot and replays the journal in order, refusing either when it was changed, reordered or spliced.
 *
 * What the snapshot and journal cannot tell is a journal cut at a record's end, or a whole earlier pair put back: either
 * looks like a stop before the commits it lacks, which only a record kept elsewhere could tell apart.
 */
export async function openSealedStore(options: SealedStoreOptions): Promise<Storage> {
  const { dir, key, report = () => {} } = options;
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
  if (typeof database.serialize !== "function") throw new Error(`a sealed store needs Node 24.16 or later, not ${process.version}`);
  if (snapshot !== undefined) database.deserialize(snapshot.image);
  const inner = await SqliteStorage.open(new NodeSqliteDatabase(database));
  try {
    const replayed = await replay(journal, snapshot?.next ?? 0, key, inner, report);
    const handle = await open(journalFile, "a", 0o600);
    // A record cut short is dropped, so the next one is appended where it belongs.
    if (replayed.end < journal.length) {
      await handle.truncate(replayed.end);
      await handle.sync();
    }
    const store = new SealedStore(dir, key, database, inner, handle, replayed.next, replayed.end, options, report);
    if (snapshot === undefined || replayed.end > 0) await store.snapshot();
    return store.storage();
  } catch (error) {
    await inner.close(BACKGROUND_CONTEXT).catch(() => {});
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
      commit: (writes, context) => this.#commit(writes, context),
      mintId: inner.mintId.bind(inner),
      conversation: inner.conversation.bind(inner),
      scanConversations: inner.scanConversations.bind(inner),
      entry: inner.entry.bind(inner),
      findLatestHeadMarker: inner.findLatestHeadMarker.bind(inner),
      scanEntries: inner.scanEntries.bind(inner),
      task: inner.task.bind(inner),
      scanTasks: inner.scanTasks.bind(inner),
      submission: inner.submission.bind(inner),
      scanSubmissions: inner.scanSubmissions.bind(inner),
      submissionByRequest: inner.submissionByRequest.bind(inner),
      findDocument: inner.findDocument.bind(inner),
      document: inner.document.bind(inner),
      scanDocuments: inner.scanDocuments.bind(inner),
      close: (context) => this.#close(context),
    };
  }

  /** Seals the whole store into a snapshot, then empties the journal it now holds. */
  async snapshot(): Promise<void> {
    await writeSealed(join(this.#dir, SNAPSHOT), this.#key, snapshotContext(this.#next), this.#database.serialize(), number64(this.#next));
    await this.#journal.truncate(0);
    await this.#journal.sync();
    this.#journalBytes = 0;
  }

  #commit(writes: readonly StorageWrite[], context: Context): Promise<Seq> {
    return this.#serially(async () => {
      if (this.#broken !== undefined) throw new Error("the store's journal cannot be written", { cause: this.#broken });
      const record = seal(this.#key, journalContext(this.#next), Buffer.from(JSON.stringify(writes)));
      const header = Buffer.alloc(HEADER_BYTES);
      header.writeUInt32BE(record.length, 0);
      header.writeBigUInt64BE(BigInt(this.#next), 4);
      try {
        await this.#journal.appendFile(Buffer.concat([header, record]));
        await this.#journal.datasync();
      } catch (error) {
        this.#broken = error;
        throw error;
      }
      this.#next += 1;
      this.#journalBytes += HEADER_BYTES + record.length;
      // Durable now: what it changes may be seen.
      const seq = await this.#inner.commit(writes, context);
      if (this.#journalBytes >= this.#snapshotAfterBytes) await this.#snapshotQuietly();
      return seq;
    });
  }

  async #close(context: Context): Promise<void> {
    clearInterval(this.#folding);
    try {
      await this.#serially(async () => {
        if (this.#journalBytes > 0) await this.snapshot();
        this.#broken ??= new Error("the store is closed");
      });
    } finally {
      await this.#journal.close();
      await this.#inner.close(context);
    }
  }

  /** A snapshot that fails leaves the journal to hold what it would have; the commit that brought it on stands. */
  async #snapshotQuietly(): Promise<void> {
    await this.snapshot().catch((error: unknown) => this.#report(new Error("the store's snapshot could not be written; its journal still holds every commit", { cause: error })));
  }

  #serially<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#line.then(work);
    this.#line = next.catch(() => {});
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
    let writes: StorageWrite[];
    try {
      writes = JSON.parse(unseal(key, journalContext(seq), record).toString("utf8")) as StorageWrite[];
    } catch (error) {
      if (!(error instanceof Unsealable)) throw error;
      throw new TamperedStore(`record ${seq} of the store's journal does not open with this key: it was changed`);
    }
    await inner.commit(writes, BACKGROUND_CONTEXT).catch((error: unknown) => {
      report(new Error(`record ${seq} of the store's journal did not apply, as it did not when it was made, and is passed over`, { cause: error }));
    });
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
