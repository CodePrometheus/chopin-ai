import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
import type { Storage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

export interface RecoveryHead { sequence: number; digest: string }
export interface RecoveryPending { operationId: string; generation: number; next: RecoveryHead }
export interface RecoveryAnchor { head: RecoveryHead; pending: RecoveryPending | null }

/** Independent trusted metadata; unavailable observation must reject rather than report absence. */
export interface RecoveryAnchorStore {
  generation: number;
  read(): Promise<RecoveryAnchor | undefined>;
  init(head: RecoveryHead): Promise<RecoveryAnchor>;
  prepare(expected: RecoveryHead, pending: RecoveryPending): Promise<RecoveryAnchor>;
  confirm(pending: RecoveryPending, local: RecoveryHead): Promise<RecoveryAnchor>;
  abort(pending: RecoveryPending, verifiedLocal: RecoveryHead): Promise<RecoveryAnchor>;
}

export interface EncryptedStoreOptions {
  dir: string;
  key: Uint8Array;
  anchor: RecoveryAnchorStore;
  /** Explicit first-store creation; ordinary opening never creates missing data. */
  create?: boolean;
  /** Trusted host backpressure policy; the connection processes one operation at a time. */
  queueCapacity: number;
  cacheKiB?: number;
  busyTimeoutMs?: number;
  nativeModule?: string;
}

export interface EncryptedSqliteDatabase extends SqliteDatabase {
  confirmedHead(): Promise<RecoveryHead>;
}

interface NativeHead { sequence: bigint; digest: Uint8Array }
interface NativeResult { head?: NativeHead; previous?: NativeHead; columns: string[]; rows: SqliteValue[][]; changes?: bigint }
interface NativeConnection {
  request(operation: string, sql: string | undefined, values: SqliteValue[]): Promise<NativeResult>;
}
interface NativeModule {
  openNativeStore(path: string, key: Buffer, create: boolean, options: { queueCapacity: number; cacheKib?: number; busyTimeoutMs?: number }): Promise<NativeConnection>;
  initializeNativeStore(path: string, key: Buffer, options: { queueCapacity: number; cacheKib?: number; busyTimeoutMs?: number }): Promise<NativeConnection>;
}

export interface EncryptedInitializationOptions extends Omit<EncryptedStoreOptions, "create"> {
  /** Checks current host admission for the original initialization before any creation. */
  verifyCreation(): Promise<void>;
}

/** Initializes only execution storage, closes it, and returns its independently confirmed head. */
export async function initializeEncryptedStore(options: EncryptedInitializationOptions): Promise<RecoveryHead> {
  const observed = await options.anchor.read();
  const initialize = observed === undefined;
  if (initialize) await options.verifyCreation();
  const database = await openDatabase(options, initialize);
  let storage: Storage | undefined;
  try {
    storage = await SqliteStorage.open(database);
    const head = await database.confirmedHead();
    await storage.close(BACKGROUND_CONTEXT);
    return head;
  } catch (error) {
    try { await (storage === undefined ? database.close() : storage.close(BACKGROUND_CONTEXT)); }
    catch (closing) { throw new AggregateError([error, closing], "storage initialization failed and its close is uncertain"); }
    throw error;
  }
}

/** Reuse the execution schema, commit behavior and cursors over encrypted disk pages. */
export async function openEncryptedStore(options: EncryptedStoreOptions): Promise<Storage> {
  const database = await openEncryptedDatabase(options);
  try { return await SqliteStorage.open(database); }
  catch (error) {
    try { await database.close(); }
    catch (closing) { throw new AggregateError([error, closing], "the encrypted store failed to initialize and close"); }
    throw error;
  }
}

/** Verify actual local content and reconcile the original external pending commit before any execution. */
export async function openEncryptedDatabase(options: EncryptedStoreOptions): Promise<EncryptedSqliteDatabase> {
  return openDatabase(options, false);
}

async function openDatabase(options: EncryptedStoreOptions, initialize: boolean): Promise<EncryptedSqliteDatabase> {
  if (!isAbsolute(options.dir) || options.key.length !== 32) throw new Error("encrypted storage requires an absolute directory and a 32-byte key");
  integer(options.anchor.generation, "writer generation", 1);
  integer(options.queueCapacity, "storage queue capacity", 1, 0xffff_ffff);
  if (options.cacheKiB !== undefined) integer(options.cacheKiB, "pager budget", 1, 0xffff_ffff);
  if (options.busyTimeoutMs !== undefined) integer(options.busyTimeoutMs, "database lock timeout", 0, 0xffff_ffff);
  for (const name of ["snapshot", "journal"]) {
    const legacy = await stat(join(options.dir, name)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (legacy !== undefined) throw new Error("legacy sealed storage requires an explicit verified migration");
  }
  if (options.create || initialize) await mkdir(options.dir, { recursive: true, mode: 0o700 });
  const path = options.nativeModule ?? fileURLToPath(new URL("../native/chopin-storage.node", import.meta.url));
  const native = createRequire(import.meta.url)(path) as NativeModule;
  const key = Buffer.from(options.key);
  let connection: NativeConnection;
  try {
    const settings = {
      queueCapacity: options.queueCapacity,
      ...(options.cacheKiB !== undefined && { cacheKib: options.cacheKiB }),
      ...(options.busyTimeoutMs !== undefined && { busyTimeoutMs: options.busyTimeoutMs }),
    };
    connection = initialize
      ? await native.initializeNativeStore(join(options.dir, "execution.sqlite"), key, settings)
      : await native.openNativeStore(join(options.dir, "execution.sqlite"), key, options.create === true, settings);
  } finally { key.fill(0); }
  try {
    const local = fromNative((await connection.request("head", undefined, [])).head);
    if (initialize && local.sequence !== 0) throw new Error("existing execution history cannot acquire a replacement freshness record");
    await recover(options.anchor, local, options.create === true || initialize);
    return new EncryptedDatabase(connection, options.anchor);
  } catch (error) {
    try { await connection.request("close", undefined, []); }
    catch (closing) { throw new AggregateError([error, closing], "the encrypted store failed to recover and close"); }
    throw error;
  }
}

class EncryptedDatabase implements EncryptedSqliteDatabase {
  readonly #native: NativeConnection;
  readonly #anchor: RecoveryAnchorStore;
  #line: Promise<unknown> = Promise.resolve();
  #closing: Promise<void> | undefined;
  #broken: Error | undefined;

  constructor(native: NativeConnection, anchor: RecoveryAnchorStore) { this.#native = native; this.#anchor = anchor; }
  exec(sql: string): Promise<void> { return this.transaction((tx) => tx.exec(sql)); }
  run(sql: string, ...values: SqliteValue[]): Promise<void> { return this.#write(sql, values).then(() => {}); }
  runCounted(sql: string, ...values: SqliteValue[]): Promise<number> { return this.#write(sql, values).then(changed); }
  get<T extends object>(sql: string, ...values: SqliteValue[]): Promise<T | undefined> { return this.all<T>(sql, ...values).then((rows) => rows[0]); }
  all<T extends object>(sql: string, ...values: SqliteValue[]): Promise<T[]> {
    const input = capture(values);
    return this.#queue(() => this.#query<T>(sql, input));
  }
  transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> { return this.#queue(() => this.#transaction(callback)); }

  confirmedHead(): Promise<RecoveryHead> {
    return this.#queue(async () => {
      const local = fromNative((await this.#request("head")).head);
      const anchor = await this.#anchor.read();
      if (anchor === undefined || validate(anchor).pending !== null || !same(local, anchor.head)) throw new Error("the execution store has no exact confirmed freshness head");
      return local;
    });
  }

  close(): Promise<void> {
    this.#closing ??= this.#line.then(async () => { await this.#request("close"); });
    return this.#closing;
  }

  #queue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closing !== undefined) return Promise.reject(new Error("the execution store is closing or closed"));
    const result = this.#line.then(() => {
      if (this.#broken !== undefined) throw new Error("the execution store needs freshness reconciliation before further work", { cause: this.#broken });
      return operation();
    });
    this.#line = result.catch(() => {});
    return result;
  }

  #request(operation: string, sql?: string, values: SqliteValue[] = []): Promise<NativeResult> {
    return this.#native.request(operation, sql, values.map((value) => value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value));
  }

  async #query<T extends object>(sql: string, values: SqliteValue[]): Promise<T[]> {
    const result = await this.#request("query", sql, values);
    return result.rows.map((row) => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])) as T);
  }

  #write(sql: string, values: SqliteValue[]): Promise<NativeResult> {
    const input = capture(values);
    return this.#queue(() => this.#transaction(() => this.#request("run", sql, input)));
  }

  async #transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
    await this.#request("begin");
    let active = true;
    let pending: Promise<unknown> = Promise.resolve();
    let failure: { error: unknown } | undefined;
    let external = false;
    let commitAttempted = false;
    const schedule = <R>(body: () => Promise<R>): Promise<R> => {
      if (!active) return Promise.reject(new Error("the execution transaction handle is no longer active"));
      const operation = pending.then(body);
      pending = operation.catch((error: unknown) => { failure ??= { error }; });
      return operation;
    };
    const write = (sql: string, values: SqliteValue[]) => {
      const input = capture(values);
      return schedule(() => this.#request("run", sql, input));
    };
    const read = <R extends object>(sql: string, values: SqliteValue[]): Promise<R[]> => {
      const input = capture(values);
      return schedule(() => this.#query<R>(sql, input));
    };
    const tx: SqliteExecutor = {
      exec: (sql) => schedule(async () => { await this.#request("exec", sql); }),
      run: (sql, ...values) => write(sql, values).then(() => {}),
      runCounted: (sql, ...values) => write(sql, values).then(changed),
      get: async <R extends object>(sql: string, ...values: SqliteValue[]): Promise<R | undefined> => { const rows = await read<R>(sql, values); return rows[0]; },
      all: <R extends object>(sql: string, ...values: SqliteValue[]) => read<R>(sql, values),
    };
    try {
      const result = await callback(tx);
      active = false;
      await pending;
      if (failure !== undefined) throw failure.error;
      const prepared = await this.#request("prepare");
      const previous = fromNative(prepared.previous);
      const next = fromNative(prepared.head);
      const change = same(previous, next) ? undefined : { operationId: randomUUID(), generation: this.#anchor.generation, next };
      if (change !== undefined) {
        external = true;
        const accepted = validate(await this.#anchor.prepare(previous, change));
        if (!same(accepted.head, previous) || !samePending(accepted.pending, change)) throw new Error("the host did not prepare the exact execution commit");
      }
      commitAttempted = true;
      const local = fromNative((await this.#request("commit")).head);
      if (!same(local, next)) throw new Error("the local execution commit did not preserve its prepared content head");
      if (change !== undefined) requireConfirmed(validate(await this.#anchor.confirm(change, local)), local);
      return result;
    } catch (error) {
      active = false;
      await pending;
      if (external || commitAttempted) this.#broken = new Error("the execution commit outcome requires reconciliation", { cause: error });
      if (!commitAttempted) {
        try { await this.#request("rollback"); }
        catch (rollback) {
          this.#broken = new Error("the execution rollback outcome requires reconciliation", { cause: rollback });
          throw new AggregateError([error, rollback], "the execution transaction failed and its rollback is uncertain");
        }
      }
      throw error;
    }
  }
}

async function recover(host: RecoveryAnchorStore, local: RecoveryHead, create: boolean): Promise<void> {
  let anchor = await host.read();
  if (anchor === undefined) {
    if (!create) throw new Error("the existing execution store has no authoritative freshness record");
    anchor = await host.init(local);
  }
  validate(anchor);
  const pending = anchor.pending;
  if (pending !== null) {
    if (same(local, pending.next)) anchor = await host.confirm(pending, local);
    else if (same(local, anchor.head)) anchor = await host.abort(pending, local);
    else throw new Error("the execution store matches neither the confirmed nor the original prepared head");
  }
  requireConfirmed(validate(anchor), local);
}

function validate(anchor: RecoveryAnchor): RecoveryAnchor {
  validHead(anchor.head);
  if (anchor.pending !== null) {
    integer(anchor.pending.generation, "pending writer generation", 1);
    validHead(anchor.pending.next);
    if (anchor.pending.operationId === "" || anchor.pending.next.sequence !== anchor.head.sequence + 1) throw new Error("the host returned an invalid pending execution commit");
  }
  return anchor;
}

function validHead(head: RecoveryHead): void {
  integer(head.sequence, "storage sequence", 0);
  const bytes = Buffer.from(head.digest, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== head.digest) throw new Error("the execution content digest is not canonical");
}
function fromNative(head: NativeHead | undefined): RecoveryHead {
  if (head === undefined || head.sequence < 0n || head.sequence > BigInt(Number.MAX_SAFE_INTEGER) || head.digest.length !== 32) throw new Error("the native store returned an invalid content head");
  return { sequence: Number(head.sequence), digest: Buffer.from(head.digest).toString("base64url") };
}
function requireConfirmed(anchor: RecoveryAnchor, local: RecoveryHead): void {
  if (anchor.pending !== null || !same(anchor.head, local)) throw new Error("the execution store does not match its trusted confirmed history");
}
function same(left: RecoveryHead, right: RecoveryHead): boolean { return left.sequence === right.sequence && left.digest === right.digest; }
function samePending(left: RecoveryPending | null, right: RecoveryPending): boolean { return left !== null && left.operationId === right.operationId && left.generation === right.generation && same(left.next, right.next); }
function integer(value: number, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`the ${name} is outside its exact supported range`);
}
function capture(values: SqliteValue[]): SqliteValue[] { return values.map((value) => value instanceof Uint8Array ? Buffer.from(value) : value); }
function changed(result: NativeResult): number {
  const count = result.changes;
  if (count === undefined || count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("the affected row count exceeds its exact range");
  return Number(count);
}
