import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subkey, unseal, writeSealed } from "@chopin-ai/harness-pi";
import { expect, it, vi } from "vitest";
import { Vault } from "../src/vault.js";

vi.mock("@chopin-ai/harness-pi", async (original) => {
  const actual = await original<typeof import("@chopin-ai/harness-pi")>();
  return { ...actual, writeSealed: vi.fn(actual.writeSealed) };
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vault-failure-"));
  const volume = join(root, "volume"); const home = join(root, "home"); await mkdir(home);
  const key = randomBytes(32); const vault = await Vault.open(volume, home, key);
  await writeFile(join(home, "auth.json"), "original credential"); await vault.sync();
  const manifest = join(volume, "home", "manifest");
  const generation = async () => (JSON.parse(unseal(subkey(key, "home"), "chopin home manifest", await readFile(manifest)).toString()) as { generation: number }).generation;
  const restored = async () => {
    const other = await mkdtemp(join(root, "restored-")); await Vault.open(volume, other, key);
    return readFile(join(other, "auth.json"), "utf8");
  };
  return { root, volume, home, key, vault, manifest, generation, restored };
}

it("does not publish a new in-memory index before its manifest is durable", async () => {
  const f = await fixture(); const actual = await vi.importActual<typeof import("@chopin-ai/harness-pi")>("@chopin-ai/harness-pi");
  const before = await f.generation();
  const failure = new Error("manifest write failed"); let injected = false;
  vi.mocked(writeSealed).mockImplementation(async (...args) => { if (args[0] === f.manifest && !injected) { injected = true; throw failure; } return actual.writeSealed(...args); });
  try {
    await writeFile(join(f.home, "auth.json"), "replacement credential");
    await expect(f.vault.sync()).rejects.toBe(failure);
    expect(await f.restored()).toBe("original credential");
    await f.vault.sync();
    expect(await f.restored()).toBe("replacement credential");
    expect(await f.generation()).toBe(before + 1);
  } finally { vi.mocked(writeSealed).mockImplementation(actual.writeSealed); await f.vault.close(); }
});

it("reconciles a committed manifest after its acknowledgement was lost", async () => {
  const f = await fixture(); const actual = await vi.importActual<typeof import("@chopin-ai/harness-pi")>("@chopin-ai/harness-pi");
  const before = await f.generation(); const failure = new Error("manifest acknowledgement lost"); let injected = false;
  vi.mocked(writeSealed).mockImplementation(async (...args) => { await actual.writeSealed(...args); if (args[0] === f.manifest && !injected) { injected = true; throw failure; } });
  try {
    await writeFile(join(f.home, "auth.json"), "committed credential");
    await expect(f.vault.sync()).rejects.toBe(failure);
    expect(await f.restored()).toBe("committed credential");
    expect(await f.generation()).toBe(before + 1);
    await writeFile(join(f.home, "auth.json"), "subsequent credential");
    await f.vault.sync();
    expect(await f.restored()).toBe("subsequent credential");
    expect(await f.generation()).toBe(before + 2);
  } finally { vi.mocked(writeSealed).mockImplementation(actual.writeSealed); await f.vault.close(); }
});

it("preserves the manifest when the source home cannot be observed", async () => {
  const f = await fixture(); const before = await readFile(f.manifest); const preserved = join(f.root, "preserved-home");
  await rename(f.home, preserved);
  try {
    await expect(f.vault.sync()).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.manifest)).toEqual(before);
    expect(await f.restored()).toBe("original credential");
  } finally { await rename(preserved, f.home); await f.vault.close(); }
});
