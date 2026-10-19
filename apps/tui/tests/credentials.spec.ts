import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { FileCredentialStore } from "../src/credentials.js";

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
});
