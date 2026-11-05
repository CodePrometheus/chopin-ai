import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSettings } from "../src/home.js";

describe("settings", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("says a file it cannot read holds no settings, without quoting what it holds", async () => {
    const home = await mkdtemp(join(tmpdir(), "chopin-home-"));
    vi.stubEnv("CHOPIN_HOME", home);
    await writeFile(join(home, "config.json"), "http://user:quoted-password@proxy.test");
    await expect(readSettings()).rejects.toThrow(new Error(`${join(home, "config.json")} is not valid JSON`));
    await writeFile(join(home, "config.json"), '{"model":"provider/model"}');
    expect(await readSettings()).toEqual({ model: "provider/model" });
  });
});
