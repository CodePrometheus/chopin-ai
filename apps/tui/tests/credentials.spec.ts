import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chopinModels, FileCredentialStore } from "../src/credentials.js";

describe("FileCredentialStore", () => {
  it("keeps credentials in a file only its user reads, and serializes writes across stores of the same file", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "chopin-auth-")), "auth.json");
    const store = new FileCredentialStore(file);
    expect(await store.read("a")).toBeUndefined();
    await store.modify("a", async () => ({ type: "api_key", key: "k1" }));
    expect(await store.read("a")).toEqual({ type: "api_key", key: "k1" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    // Two stores of one file, as two processes would hold, each counting up under the lock.
    const other = new FileCredentialStore(file);
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? store : other).modify("n", async (current) => {
      const count = Number(current?.type === "api_key" ? current.key : "0");
      await sleep(2);
      return { type: "api_key", key: String(count + 1) };
    })));
    expect(await other.read("n")).toEqual({ type: "api_key", key: "10" });
    expect(await store.list()).toEqual([{ providerId: "a", type: "api_key" }, { providerId: "n", type: "api_key" }]);

    // A change that returns nothing leaves the credential as it was.
    expect(await store.modify("a", async () => undefined)).toEqual({ type: "api_key", key: "k1" });
    await store.delete("a");
    expect(await other.read("a")).toBeUndefined();
  });

  it("says a file it cannot read holds no credentials, without quoting what it holds", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "chopin-auth-")), "auth.json");
    await writeFile(file, "sk-cut-short-secret");
    const store = new FileCredentialStore(file);
    const refused = await store.list().then(() => undefined, (error: Error) => error.message);
    expect(refused).toBe(`${file} is not valid JSON`);
    await writeFile(file, '["sk-cut-short-secret"]');
    expect(await store.list().then(() => undefined, (error: Error) => error.message)).toBe(`${file} holds no credentials object`);
  });
});

describe("chopinModels", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("tells of a models.json it cannot read in full by its name alone, rather than leave it out unsaid", async () => {
    const home = await mkdtemp(join(tmpdir(), "chopin-home-"));
    vi.stubEnv("CHOPIN_HOME", home);
    const told: string[] = [];
    await chopinModels(new InMemoryCredentialStore(), (notice) => told.push(notice));
    expect(told).toEqual([]);
    await writeFile(join(home, "models.json"), '{"providers": {"mine": {"apiKey": "models-password"');
    await chopinModels(new InMemoryCredentialStore(), (notice) => told.push(notice));
    expect(told).toEqual([`${join(home, "models.json")} could not be read in full; models it adds may be missing`]);
  });
});


