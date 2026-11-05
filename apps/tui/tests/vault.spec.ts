import { randomBytes } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { WrongKey } from "@chopin-ai/harness-pi";
import { describe, expect, it } from "vitest";
import { TamperedHome, Vault } from "../src/vault.js";

async function temporary(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `chopin-${name}-`));
}

/** Every file under `dir`, by its path there, with what it holds and its mode. */
async function contents(dir: string): Promise<Record<string, { text: string; mode: number }>> {
  const found: Record<string, { text: string; mode: number }> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const at = join(entry.parentPath, entry.name);
    found[at.slice(dir.length + 1)] = { text: await readFile(at, "utf8"), mode: (await stat(at)).mode & 0o777 };
  }
  return found;
}

/** Whether any file under `dir` holds `text` as it was written. */
async function holds(dir: string, text: string): Promise<boolean> {
  return Object.values(await contents(dir)).some((file) => file.text.includes(text));
}

describe("a vault", () => {
  it("answers to the key it was first opened with alone, and refuses a volume that lost its record of it", async () => {
    const volume = await temporary("volume");
    const key = randomBytes(32);
    await (await Vault.open(volume, await temporary("home"), key)).close();
    await expect(Vault.open(volume, await temporary("home"), randomBytes(32))).rejects.toThrow(WrongKey);
    const vault = await Vault.open(volume, await temporary("home"), key);
    await expect(vault.verify(randomBytes(32))).rejects.toThrow(WrongKey);
    await vault.verify(key);
    const lost = await temporary("volume");
    await mkdir(join(lost, "store"));
    await expect(Vault.open(lost, await temporary("home"), key)).rejects.toThrow(TamperedHome);
  });

  it("restores the home from its sealed copy, which holds none of it as written and only what it still holds", async () => {
    const volume = await temporary("volume");
    const key = randomBytes(32);
    const home = await temporary("home");
    await mkdir(join(home, "rsi", "layer"), { recursive: true });
    await writeFile(join(home, "config.json"), '{"model":"provider/a-sealed-model"}');
    await writeFile(join(home, "auth.json"), '{"provider":{"key":"a-sealed-key"}}', { mode: 0o600 });
    await writeFile(join(home, "rsi", "layer", "v1.json"), "a sealed layer");
    const vault = await Vault.open(volume, home, key);
    await vault.sync();
    for (const text of ["a-sealed-model", "a-sealed-key", "a sealed layer", "config.json", "auth.json"]) expect(await holds(volume, text)).toBe(false);
    const restored = await temporary("home");
    await Vault.open(volume, restored, key);
    expect(await contents(restored)).toEqual(await contents(home));

    // What changed is sealed anew; what is gone leaves nothing behind.
    await writeFile(join(home, "config.json"), '{"model":"provider/another-model"}');
    await writeFile(join(home, "rsi", "spend.jsonl"), "1\n");
    await rename(join(home, "auth.json"), join(home, "credentials.json"));
    await chmod(join(home, "rsi", "layer", "v1.json"), 0o600);
    await vault.close();
    const again = await temporary("home");
    await Vault.open(volume, again, key);
    expect(await contents(again)).toEqual(await contents(home));
    // Four files, four sealed copies: the old ones went with the manifest that named them.
    expect((await readdir(join(volume, "home", "objects"))).length).toBe(4);
  });

  it("seals a file at the top of the home as soon as another process writes it, well before the next sync", async () => {
    const volume = await temporary("volume");
    const key = randomBytes(32);
    const home = await temporary("home");
    const vault = await Vault.open(volume, home, key);
    vault.keepSynced(60 * 60_000, (error) => { throw error; });
    try {
      // Written as every writer of the home writes, a draft renamed into place.
      await writeFile(join(home, "auth.json.draft"), '{"provider":{"refresh":"a-refreshed-token"}}');
      await rename(join(home, "auth.json.draft"), join(home, "auth.json"));
      // What a new pod would restore, asked until it holds the token, for no longer than a second.
      const restored = async () => {
        const elsewhere = await temporary("home");
        await Vault.open(volume, elsewhere, key);
        return readFile(join(elsewhere, "auth.json"), "utf8").catch(() => "");
      };
      for (let tries = 0; !(await restored()).includes("a-refreshed-token"); tries++) {
        expect(tries).toBeLessThan(50);
        await sleep(20);
      }
    } finally {
      await vault.close();
    }
  });

  it("keeps a file a service before it left in the home, newer than its sealed copy", async () => {
    const volume = await temporary("volume");
    const key = randomBytes(32);
    const home = await temporary("home");
    await writeFile(join(home, "config.json"), "sealed");
    await (await Vault.open(volume, home, key)).close();
    // The home outlived that service, as memory does a restart of its container, and changed after the last sync.
    await writeFile(join(home, "config.json"), "newer");
    const vault = await Vault.open(volume, home, key);
    expect(await readFile(join(home, "config.json"), "utf8")).toBe("newer");
    await vault.close();
    const elsewhere = await temporary("home");
    await Vault.open(volume, elsewhere, key);
    expect(await readFile(join(elsewhere, "config.json"), "utf8")).toBe("newer");
  });

  it("refuses a home whose sealed manifest or files were changed, saying which", async () => {
    const volume = await temporary("volume");
    const key = randomBytes(32);
    const home = await temporary("home");
    await writeFile(join(home, "config.json"), "{}");
    await (await Vault.open(volume, home, key)).close();
    const changed = async (file: string) => {
      const copy = await temporary("volume");
      await cp(volume, copy, { recursive: true });
      const bytes = await readFile(join(copy, file));
      bytes[bytes.length - 1]! ^= 1;
      await writeFile(join(copy, file), bytes);
      return copy;
    };
    await expect(Vault.open(await changed(join("home", "manifest")), await temporary("home"), key)).rejects.toThrow("manifest does not open");
    const [object] = await readdir(join(volume, "home", "objects"));
    await expect(Vault.open(await changed(join("home", "objects", object ?? "")), await temporary("home"), key)).rejects.toThrow("sealed copy of config.json");
  });
});
