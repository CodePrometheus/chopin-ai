import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PendingStore } from "../src/pending.js";
import { LedgerStore } from "../src/store.js";
import type { DefectRecord } from "../src/types.js";

const ESCAPES = ["../outside", "nested/name", "/etc/passwd", "Upper-Case", ""];

function record(id: string): DefectRecord {
  return {
    id, errorKey: "key", observedErrors: ["Error: boom"], rootCause: { description: "cause", anchoredTag: "v1" },
    status: "open", signals: [], fixes: [], createdAt: "", updatedAt: "",
  } as unknown as DefectRecord;
}

/** A store directory nested one level down, so a `../` escape would land in an observable parent. */
async function nestedStore(): Promise<{ parent: string; dir: string }> {
  const parent = await mkdtemp(join(tmpdir(), "chopin-record-id-"));
  return { parent, dir: join(parent, "store") };
}

describe("record ids name files inside the store only", () => {
  it.each(ESCAPES)("the ledger refuses %j and writes nothing", async (id) => {
    const { parent, dir } = await nestedStore();
    const store = new LedgerStore(dir);
    await expect(store.save(record(id))).rejects.toThrow("invalid record id");
    await expect(store.load(id)).rejects.toThrow("invalid record id");
    expect(await readdir(parent)).toEqual([]);
  });

  it.each(ESCAPES)("the pending area refuses %j and writes nothing outside", async (id) => {
    const { parent, dir } = await nestedStore();
    const pending = new PendingStore(dir);
    await expect(pending.record({ id, signal: "Error: boom", lesson: "l", evidence: "e", proposal: "note" })).rejects.toThrow("invalid record id");
    expect((await readdir(parent)).filter((name) => name !== "store")).toEqual([]);
  });

  it("keeps working for an ordinary slug", async () => {
    const { dir } = await nestedStore();
    const store = new LedgerStore(dir);
    await store.save(record("verify-the-test-can-actually-fail"));
    expect((await store.load("verify-the-test-can-actually-fail"))?.rootCause.description).toBe("cause");
  });
});
