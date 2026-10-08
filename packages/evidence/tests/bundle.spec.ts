import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { downloadAndExtract, extractBundle } from "../src/bundle.js";

const directories: string[] = [];
async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Zip a `logs/` tree prepared by `build`, storing symbolic links as links. */
async function archive(build: (logs: string) => Promise<void>): Promise<string> {
  const root = await temporary("bundle-src-");
  await mkdir(join(root, "logs"));
  await build(join(root, "logs"));
  const zipPath = join(root, "bundle.zip");
  const result = spawnSync("zip", ["-q", "-y", "-r", zipPath, "logs"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`zip failed: ${result.stderr}`);
  return zipPath;
}

describe("bundle url", () => {
  it.each(["-K/tmp/curl.conf", "--output=/tmp/written", "file:///etc/hosts", "ftp://example.com/logs.zip"])(
    "refuses %s before touching the disk",
    async (url) => {
      const home = await temporary("bundle-home-");
      const saved = process.env.HOME;
      process.env.HOME = home;
      try {
        await expect(downloadAndExtract(url)).rejects.toThrow(/http or https|not a valid URL/);
        await expect(access(join(home, ".chopin"))).rejects.toThrow();
      } finally {
        process.env.HOME = saved;
      }
    },
  );
});

describe.runIf(spawnSync("zip", ["-v"]).status === 0)("bundle extraction", () => {
  it("extracts an ordinary archive", async () => {
    const zipPath = await archive((logs) => writeFile(join(logs, "app.log"), "hello\n"));
    const out = join(await temporary("bundle-out-"), "extract");
    await extractBundle(zipPath, out);
    expect(await readFile(join(out, "logs", "app.log"), "utf8")).toBe("hello\n");
  });

  it("refuses an archive holding a symbolic link", async () => {
    const zipPath = await archive(async (logs) => {
      await symlink("/etc/hosts", join(logs, "link"));
      await writeFile(join(logs, "app.log"), "hello\n");
    });
    const out = join(await temporary("bundle-out-"), "extract");
    await expect(extractBundle(zipPath, out)).rejects.toThrow("symbolic link");
    await expect(access(out)).rejects.toThrow();
  });

  it("refuses an archive that expands past the size cap", async () => {
    const zipPath = await archive((logs) => writeFile(join(logs, "big.log"), Buffer.alloc(64 * 1024)));
    const out = join(await temporary("bundle-out-"), "extract");
    await expect(extractBundle(zipPath, out, 1024)).rejects.toThrow("over the 1024-byte limit");
    await expect(access(out)).rejects.toThrow();
  });
});
