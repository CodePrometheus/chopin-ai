import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecoveryAnchorStore } from "@chopin-ai/harness-pi";
import { expect, it } from "vitest";
import { initializeProject, type InitializationAuthority } from "../src/initialize.js";
import { Vault } from "../src/vault.js";

/** These cases inject pre-storage refusals; real custody completion runs in host integration tests. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chopin-initializer-"));
  const operationId = randomUUID();
  const key = randomBytes(32);
  const transfers: Buffer[] = [];
  const unavailable = async (): Promise<never> => { throw new Error("host observation unavailable"); };
  const anchor: RecoveryAnchorStore = { generation: 1, read: unavailable, init: unavailable, prepare: unavailable, confirm: unavailable, abort: unavailable };
  const authority: InitializationAuthority = {
    key: async () => { const transferred = Buffer.from(key); transfers.push(transferred); return { operationId, key: transferred }; },
    verifyCreation: async () => { throw new Error("creation refused"); },
    complete: unavailable,
  };
  return { volume: join(root, "volume"), home: join(root, "home"), operationId, key, transfers, authority, storage: { anchor, queueCapacity: 1 } };
}

it("refuses creation before writing the volume or home and wipes the key transfer", async () => {
  const f = await fixture();
  await expect(initializeProject(f)).rejects.toThrow("creation refused");
  await expect(stat(f.volume)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(f.home)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.transfers.every((key) => key.every((byte) => byte === 0))).toBe(true);
});

it("rejects another operation's key before filesystem effects", async () => {
  const f = await fixture();
  const transferred = Buffer.from(f.key);
  f.authority.key = async () => ({ operationId: randomUUID(), key: transferred });
  await expect(initializeProject(f)).rejects.toThrow("does not belong");
  expect(transferred.every((byte) => byte === 0)).toBe(true);
  await expect(stat(f.volume)).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves an existing vault when the host supplies a different key", async () => {
  const f = await fixture();
  await mkdir(f.home);
  await Vault.open(f.volume, f.home, f.key);
  const before = await readFile(join(f.volume, "key-check"));
  f.authority.key = async () => ({ operationId: f.operationId, key: randomBytes(32) });
  await expect(initializeProject(f)).rejects.toThrow();
  expect(await readFile(join(f.volume, "key-check"))).toEqual(before);
  await expect(stat(join(f.volume, "store", "execution.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not publish home contents when authoritative storage observation fails", async () => {
  const f = await fixture();
  await mkdir(f.home);
  await Vault.open(f.volume, f.home, f.key);
  await writeFile(join(f.home, "credentials.json"), "synthetic uncommitted home data");
  await expect(initializeProject(f)).rejects.toThrow("host observation unavailable");
  await expect(stat(join(f.volume, "home", "manifest"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.home, "credentials.json"), "utf8")).toBe("synthetic uncommitted home data");
});

it("rejects a restored home located inside its sealed volume", async () => {
  const f = await fixture();
  await expect(initializeProject({ ...f, home: join(f.volume, "plaintext-home") })).rejects.toThrow("separate locations");
  expect(f.transfers).toHaveLength(0);
});

it("detects a restored-home symlink that resolves to the sealed volume", async () => {
  const f = await fixture();
  await mkdir(f.volume);
  await symlink(f.volume, f.home, "dir");
  await expect(initializeProject(f)).rejects.toThrow("separate locations");
  await expect(stat(join(f.volume, "key-check"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("never recreates a missing marker while verifying an existing vault", async () => {
  const f = await fixture();
  await mkdir(f.home);
  const vault = await Vault.open(f.volume, f.home, f.key);
  await rename(join(f.volume, "key-check"), join(f.volume, "preserved-key-check"));
  await expect(vault.verify(f.key)).rejects.toThrow("no key marker");
  await expect(stat(join(f.volume, "key-check"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(Vault.openExisting(f.volume, f.home, f.key)).rejects.toThrow("no key marker");
});

it("requires fresh creation authority before recording a first vault key", async () => {
  const f = await fixture();
  await mkdir(f.volume); await mkdir(f.home);
  await expect(Vault.initialize(f.volume, f.home, f.key, async () => { throw new Error("creation refused"); })).rejects.toThrow("creation refused");
  await expect(stat(join(f.volume, "key-check"))).rejects.toMatchObject({ code: "ENOENT" });
});
