import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { initializeEncryptedStore, openEncryptedDatabase, openEncryptedStore, type RecoveryAnchor, type RecoveryAnchorStore, type RecoveryHead, type RecoveryPending } from "../src/encrypted-store.js";
import { openSealedStore } from "../src/sealed-store.js";

const nativeModule = process.env.CHOPIN_TEST_NATIVE_MODULE;

/** Protocol fault fixture only; real host authorization and metadata durability require host integration tests. */
function host() {
  let state: RecoveryAnchor | undefined;
  const confirmed: RecoveryPending[] = [];
  const aborted: RecoveryPending[] = [];
  const anchor: RecoveryAnchorStore = {
    generation: 1,
    read: async () => structuredClone(state),
    init: async (head) => structuredClone(state ??= { head: structuredClone(head), pending: null }),
    prepare: async (expected, pending) => {
      expect(state?.head).toEqual(expected);
      state = { head: structuredClone(expected), pending: structuredClone(pending) };
      return structuredClone(state);
    },
    confirm: async (pending, local) => {
      expect(state?.pending).toEqual(pending);
      expect(pending.next).toEqual(local);
      confirmed.push(structuredClone(pending));
      state = { head: structuredClone(local), pending: null };
      return structuredClone(state);
    },
    abort: async (pending, local) => {
      expect(state?.pending).toEqual(pending);
      expect(state?.head).toEqual(local);
      aborted.push(structuredClone(pending));
      state = { head: structuredClone(local), pending: null };
      return structuredClone(state);
    },
  };
  return { anchor, confirmed, aborted, state: () => structuredClone(state) };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "chopin-encrypted-storage-"));
  const options = { dir, key: randomBytes(32), queueCapacity: 1, nativeModule: nativeModule! };
  const control = host();
  const database = await openEncryptedDatabase({ ...options, anchor: control.anchor, create: true });
  await database.exec("CREATE TABLE records(id INTEGER PRIMARY KEY,body TEXT NOT NULL) STRICT");
  return { ...control, options, database };
}

describe.skipIf(nativeModule === undefined)("native encrypted storage contract", () => {
  const cases = createStorageConformance({
    assertions: {
      ok: assert.ok,
      strictEqual: assert.strictEqual,
      deepEqual: assert.deepStrictEqual,
      partialDeepEqual: assert.partialDeepStrictEqual,
      greaterThan: (actual, expected) => assert(actual > expected),
      rejects: async (operation, includes) => {
        await assert.rejects(operation, (error) => error instanceof Error && error.message.includes(includes));
      },
    },
    withStorage: async (use) => {
      const dir = await mkdtemp(join(tmpdir(), "chopin-native-contract-"));
      const { anchor } = host();
      const storage = await openEncryptedStore({ dir, key: randomBytes(32), anchor, create: true, queueCapacity: 1, nativeModule: nativeModule! });
      try { await use(storage); }
      finally { await storage.close(BACKGROUND_CONTEXT); }
    },
  });
  for (const test of cases) it(test.name, () => test.run());
});

describe.skipIf(nativeModule === undefined)("encrypted storage freshness protocol", () => {
  it("captures binary parameters before a queued call or transaction operation can observe mutation", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await f.database.exec("CREATE TABLE binaries(id INTEGER PRIMARY KEY,payload BLOB NOT NULL) STRICT");
    const holding = f.database.transaction(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const bytes = new Uint8Array([1, 2, 3]);
    const saving = f.database.run("INSERT INTO binaries VALUES(1,?1)", bytes);
    bytes.fill(9);
    release.resolve();
    try {
      await holding; await saving;
      await f.database.transaction(async (tx) => {
        const bytes = new Uint8Array([4, 5]);
        const saving = tx.run("INSERT INTO binaries VALUES(2,?1)", bytes);
        bytes.fill(9);
        await saving;
      });
      const rows = await f.database.all<{ payload: Uint8Array }>("SELECT payload FROM binaries ORDER BY id");
      expect(rows.map((row) => [...row.payload])).toEqual([[1, 2, 3], [4, 5]]);
    } finally { release.resolve(); await f.database.close(); }
  });

  it("withholds the caller receipt until the exact host confirmation returns", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const confirm = f.anchor.confirm;
    f.anchor.confirm = async (pending, local) => { entered.resolve(); await release.promise; return confirm(pending, local); };
    let acknowledged = false;
    const saving = f.database.run("INSERT INTO records VALUES(1,'awaiting confirmation')").then(() => { acknowledged = true; });
    try {
      await entered.promise;
      await setImmediate();
      expect(acknowledged).toBe(false);
    } finally { release.resolve(); await saving; await f.database.close(); }
  });

  it("freezes uncertain commits even when a host rejects without an error value", async () => {
    const f = await fixture();
    const prepare = f.anchor.prepare;
    f.anchor.prepare = async (expected, pending) => { await prepare(expected, pending); throw undefined; };
    try {
      await expect(f.database.run("INSERT INTO records VALUES(1,'unconfirmed')")).rejects.toBeUndefined();
      await expect(f.database.get("SELECT * FROM records")).rejects.toThrow("reconciliation");
    } finally { await f.database.close(); }
  });

  it("confirms actual disk commits before returning success and serializes transactions", async () => {
    const f = await fixture();
    try {
      await Promise.all([f.database.run("INSERT INTO records VALUES(1,'first')"), f.database.run("INSERT INTO records VALUES(2,'second')")]);
      const head = await f.database.confirmedHead();
      expect(f.confirmed.at(-1)?.next).toEqual(head);
      expect(await f.database.all("SELECT id FROM records ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }]);
    } finally { await f.database.close(); }
  });

  it("retains and aborts the original prepared operation after a lost prepare response", async () => {
    const f = await fixture();
    const prepare = f.anchor.prepare;
    f.anchor.prepare = async (expected, pending) => { await prepare(expected, pending); throw new Error("prepare response lost"); };
    await expect(f.database.run("INSERT INTO records VALUES(1,'not committed')")).rejects.toThrow("prepare response lost");
    const pending = f.state()!.pending!;
    await expect(f.database.get("SELECT * FROM records")).rejects.toThrow("reconciliation");
    await f.database.close();
    f.anchor.generation++;
    const reopened = await openEncryptedDatabase({ ...f.options, anchor: f.anchor });
    try {
      expect(f.aborted).toEqual([pending]);
      expect(pending.generation).toBe(1);
      expect(await reopened.all("SELECT * FROM records")).toEqual([]);
    } finally { await reopened.close(); }
  });

  it("confirms the original locally committed operation after an unavailable host confirmation", async () => {
    const f = await fixture();
    const confirm = f.anchor.confirm;
    f.anchor.confirm = async () => { throw new Error("confirmation unavailable"); };
    await expect(f.database.run("INSERT INTO records VALUES(1,'committed once')")).rejects.toThrow("confirmation unavailable");
    const pending = f.state()!.pending!;
    await f.database.close();
    f.anchor.confirm = confirm;
    f.anchor.generation++;
    const reopened = await openEncryptedDatabase({ ...f.options, anchor: f.anchor });
    try {
      expect(f.confirmed.at(-1)).toEqual(pending);
      expect(await reopened.all("SELECT * FROM records")).toEqual([{ id: 1, body: "committed once" }]);
    } finally { await reopened.close(); }
  });

  it("reopens without replay after the confirmation committed but its response was lost", async () => {
    const f = await fixture();
    const confirm = f.anchor.confirm;
    f.anchor.confirm = async (pending, local) => { await confirm(pending, local); throw new Error("confirmation response lost"); };
    await expect(f.database.run("INSERT INTO records VALUES(1,'acknowledged externally')")).rejects.toThrow("confirmation response lost");
    const confirmations = f.confirmed.length;
    await f.database.close();
    const reopened = await openEncryptedDatabase({ ...f.options, anchor: f.anchor });
    try {
      expect(f.confirmed.length).toBe(confirmations);
      expect(await reopened.all("SELECT id FROM records")).toEqual([{ id: 1 }]);
    } finally { await reopened.close(); }
  });

  it("rejects a valid older encrypted database against the newer host head", async () => {
    const f = await fixture();
    await f.database.close();
    const backup = join(await mkdtemp(join(tmpdir(), "chopin-old-storage-")), "execution.sqlite");
    await copyFile(join(f.options.dir, "execution.sqlite"), backup);
    const current = await openEncryptedDatabase({ ...f.options, anchor: f.anchor });
    await current.run("INSERT INTO records VALUES(1,'newer history')");
    await current.close();
    const old = join(f.options.dir, "old");
    await mkdir(old);
    await copyFile(backup, join(old, "execution.sqlite"));
    await expect(openEncryptedDatabase({ ...f.options, dir: old, anchor: f.anchor })).rejects.toThrow("trusted confirmed history");
  });

  it("rejects a different host successor before local commit and freezes the connection", async () => {
    const f = await fixture();
    const prepare = f.anchor.prepare;
    f.anchor.prepare = async (expected, pending) => {
      const result = await prepare(expected, pending);
      result.pending!.operationId = "another operation";
      return result;
    };
    await expect(f.database.run("INSERT INTO records VALUES(1,'must roll back')")).rejects.toThrow("exact execution commit");
    await f.database.close();
    const reopened = await openEncryptedDatabase({ ...f.options, anchor: f.anchor });
    try { expect(await reopened.all("SELECT * FROM records")).toEqual([]); }
    finally { await reopened.close(); }
  });

  it("rolls back callback failures and refuses a transaction handle after completion", async () => {
    const f = await fixture();
    let late: (() => Promise<void>) | undefined;
    try {
      await expect(f.database.transaction(async (tx) => {
        await tx.run("INSERT INTO records VALUES(1,'rolled back')");
        throw new Error("callback failed");
      })).rejects.toThrow("callback failed");
      await f.database.transaction(async (tx) => { late = () => tx.run("INSERT INTO records VALUES(2,'late')"); });
      await expect(late!()).rejects.toThrow("no longer active");
      expect(await f.database.all("SELECT * FROM records")).toEqual([]);
    } finally { await f.database.close(); }
  });
});

describe.skipIf(nativeModule === undefined)("protected storage initialization", () => {
  it("never lets the legacy service create a shadow store beside encrypted page history", async () => {
    const f = await fixture();
    await f.database.run("INSERT INTO records VALUES(1,'preserved page history')");
    await f.database.close();
    const file = join(f.options.dir, "execution.sqlite");
    const before = await readFile(file);
    await expect(openSealedStore({ dir: f.options.dir, key: f.options.key })).rejects.toThrow("protected adapter");
    expect(await readFile(file)).toEqual(before);
    await expect(stat(join(f.options.dir, "snapshot"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("preserves the original genesis after an uncertain initialization receipt, accepted=%s", async (accepted) => {
    const dir = join(await mkdtemp(join(tmpdir(), "chopin-genesis-")), "store");
    const control = host();
    const heads: RecoveryHead[] = [];
    const initialize = control.anchor.init;
    let failing = true;
    control.anchor.init = async (head) => {
      heads.push(structuredClone(head));
      if (failing) {
        if (accepted) await initialize(head);
        throw new Error("initialization response unavailable");
      }
      return initialize(head);
    };
    const options = { dir, key: randomBytes(32), anchor: control.anchor, queueCapacity: 1, nativeModule: nativeModule!, verifyCreation: async () => {} };
    await expect(initializeEncryptedStore(options)).rejects.toThrow("initialization response unavailable");
    failing = false;
    const head = await initializeEncryptedStore(options);
    expect(head.sequence).toBeGreaterThan(0);
    expect(heads.every((head) => isDeepStrictEqual(head, heads[0]))).toBe(true);
    expect(heads).toHaveLength(accepted ? 1 : 2);
    expect(control.state()!.head).toEqual(head);
  });

  it("checks creation authority before creating a missing directory", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "chopin-denied-init-")), "missing");
    const control = host();
    await expect(initializeEncryptedStore({ dir, key: randomBytes(32), anchor: control.anchor, queueCapacity: 1, nativeModule: nativeModule!, verifyCreation: async () => { throw new Error("creation refused"); } })).rejects.toThrow("creation refused");
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(control.state()).toBeUndefined();
  });

  it("refuses to invent a new freshness record for existing execution history", async () => {
    const f = await fixture();
    await f.database.run("INSERT INTO records VALUES(1,'original history')");
    await f.database.close();
    const other = host();
    await expect(initializeEncryptedStore({ ...f.options, anchor: other.anchor, verifyCreation: async () => {} })).rejects.toThrow("replacement freshness record");
    expect(other.state()).toBeUndefined();
    const restored = await openEncryptedDatabase({ ...f.options, anchor: f.anchor });
    try { expect(await restored.all("SELECT * FROM records")).toEqual([{ id: 1, body: "original history" }]); }
    finally { await restored.close(); }
  });

  it("never recreates missing storage required by an existing host head", async () => {
    const f = await fixture();
    await f.database.close();
    const file = join(f.options.dir, "execution.sqlite");
    await rename(file, `${file}.preserved`);
    await expect(initializeEncryptedStore({ ...f.options, anchor: f.anchor, verifyCreation: async () => { throw new Error("must not create"); } })).rejects.toThrow();
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves actual legacy storage until an explicit migration is admitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chopin-legacy-init-"));
    const key = randomBytes(32);
    const old = await openSealedStore({ dir, key });
    await old.close(BACKGROUND_CONTEXT);
    const snapshot = await readFile(join(dir, "snapshot"));
    const control = host();
    await expect(initializeEncryptedStore({ dir, key, anchor: control.anchor, queueCapacity: 1, nativeModule: nativeModule!, verifyCreation: async () => {} })).rejects.toThrow("explicit verified migration");
    expect(await readFile(join(dir, "snapshot"))).toEqual(snapshot);
    await expect(stat(join(dir, "execution.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
