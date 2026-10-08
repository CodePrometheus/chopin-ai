import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("after a real failure, correction and delivery the lesson is saved automatically and a separate process reads and reuses it", async () => {
  const root = await mkdtemp(join(tmpdir(), "chopin-autonomy-flow-"));
  const results = [];
  for (const mode of ["capture", "reuse"]) {
    const { stdout } = await promisify(execFile)(process.execPath, [resolve("tests/fixtures/autonomy-flow.mjs"), root, mode], {
      timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    results.push(JSON.parse(stdout.trim().split("\n").at(-1)!));
  }
  expect(results[0].failures).toBeGreaterThan(0);
  expect(results[1].pid).not.toBe(results[0].pid);
  expect(results[1].artifactId).toBe(results[0].artifactId);
  expect(results.map((result) => result.artifactCount)).toEqual([1, 1]);
  expect(results.map((result) => result.approvalEvents)).toEqual([0, 0]);
}, 45_000);
