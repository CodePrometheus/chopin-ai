import { randomBytes } from "node:crypto";
import { cp, mkdtemp, open, readFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { openSealedStore } from "../src/sealed-store.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const root = { type: "conversation" as const, value: { id: ROOT_CONVERSATION_ID } };

function opened() {
  return vi.mocked(open).mock.results.flatMap((result) => result.type === "return" ? [result.value] : []);
}

describe("sealed storage failures", () => {
  it("replays only the accepted prefix of a refused commit group", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chopin-storage-prefix-"));
    const copy = await mkdtemp(join(tmpdir(), "chopin-storage-prefix-reopen-"));
    const key = randomBytes(32);
    const store = await openSealedStore({ dir, key });
    try {
      const id = await store.mintId<ConversationId>();
      const received = vi.fn();
      const result = await store.commit([[root], [root], [{ type: "conversation", value: { id } }]], received, context);
      expect(result.stored).toBe(1);
      expect(result.refused).toBeDefined();
      expect(received).toHaveBeenCalledOnce();
      expect(received.mock.calls[0]![0]).toBe(0);
      expect((await readFile(join(dir, "journal"))).length).toBeGreaterThan(0);
      await cp(dir, copy, { recursive: true });
      const reopened = await openSealedStore({ dir: copy, key });
      try {
        expect(await reopened.conversation(ROOT_CONVERSATION_ID, context)).toEqual(root.value);
        expect(await reopened.conversation(id, context)).toBeUndefined();
      } finally { await reopened.close(context); }
    } finally { await store.close(context); }
  });
  it("closes native resources when the first snapshot cannot be synchronized", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chopin-storage-open-"));
    const probe = await open(join(dir, "probe"), "wx", 0o600);
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    vi.mocked(open).mockClear();
    const database = vi.spyOn(DatabaseSync.prototype, "close");
    const failure = new Error("injected synchronization failure");
    const sync = vi.spyOn(prototype, "sync").mockRejectedValueOnce(failure);
    try {
      await expect(openSealedStore({ dir, key: randomBytes(32) })).rejects.toBe(failure);
      const handles = await Promise.all(opened());
      expect(handles).toHaveLength(2);
      expect(handles.map((handle) => handle.fd)).toEqual([-1, -1]);
      expect(database).toHaveBeenCalledOnce();
    } finally { sync.mockRestore(); database.mockRestore(); }
  });

  it("withholds receipts and reads until the journal is durable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chopin-storage-barrier-"));
    vi.mocked(open).mockClear();
    const store = await openSealedStore({ dir, key: randomBytes(32) });
    const journal = (await Promise.all(opened()))[0]!;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = journal.datasync.bind(journal);
    const sync = vi.spyOn(journal, "datasync").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      await original();
    });
    const receipts = vi.fn();
    const commit = store.commit([[root]], receipts, context);
    let observed = false;
    let read: ReturnType<typeof store.conversation> | undefined;
    try {
      await entered.promise;
      read = store.conversation(ROOT_CONVERSATION_ID, context).then((value) => { observed = true; return value; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(receipts).not.toHaveBeenCalled();
      expect(observed).toBe(false);
      release.resolve();
      expect((await commit).stored).toBe(1);
      expect(receipts).toHaveBeenCalledOnce();
      expect(await read).toEqual(root.value);
    } finally {
      release.resolve();
      await Promise.allSettled([commit, read]);
      sync.mockRestore();
      await store.close(context);
    }
  });

  it("refuses reads and commits after a failed journal flush without snapshotting the uncertain write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chopin-storage-flush-"));
    vi.mocked(open).mockClear();
    const store = await openSealedStore({ dir, key: randomBytes(32) });
    const journal = (await Promise.all(opened()))[0]!;
    const snapshot = await readFile(join(dir, "snapshot"));
    const failure = new Error("injected journal flush failure");
    const sync = vi.spyOn(journal, "datasync").mockRejectedValueOnce(failure);
    const receipts = vi.fn();
    try {
      await expect(store.commit([[root]], receipts, context)).rejects.toBe(failure);
      expect(receipts).not.toHaveBeenCalled();
      await expect(store.conversation(ROOT_CONVERSATION_ID, context)).rejects.toBe(failure);
      await expect(store.commit([[root]], receipts, context)).rejects.toBe(failure);
    } finally { sync.mockRestore(); await store.close(context); }
    expect(await readFile(join(dir, "snapshot"))).toEqual(snapshot);
    expect(journal.fd).toBe(-1);
  });
});
