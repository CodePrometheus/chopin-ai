import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { acquireLease, leaseHolder, takeOverLease } from "../src/lease.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function leasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "team-lease-"));
  directories.push(directory);
  return join(directory, "engine.lease");
}

/** The id of a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "exit");
  return child.pid!;
}

describe("team engine lease", () => {
  it("lets one holder drive at a time", async () => {
    const path = await leasePath();
    const first = await acquireLease(path, "lead-1");
    expect(first?.holder).toMatchObject({ pid: process.pid, sessionId: "lead-1" });
    expect(await acquireLease(path, "lead-2")).toBeUndefined();
    await first!.release();
    expect(await acquireLease(path, "lead-2")).toBeDefined();
  });

  it("takes over a lease whose holder has exited, and the old holder cannot release the new one", async () => {
    const path = await leasePath();
    await writeFile(path, JSON.stringify({ pid: await deadPid(), sessionId: "gone", startedAt: new Date().toISOString(), nonce: "gone" }));
    const taken = await acquireLease(path, "lead-2");
    expect(taken?.holder.sessionId).toBe("lead-2");
  });

  it("hands a live lease over only on request, and the old holder then knows it lost it", async () => {
    const path = await leasePath();
    const first = (await acquireLease(path, "lead-1"))!;
    const { lease, previous } = await takeOverLease(path, "lead-2");
    expect(previous?.sessionId).toBe("lead-1");
    expect(await first.held()).toBe(false);
    await first.release();
    expect((await leaseHolder(path))?.nonce).toBe(lease.holder.nonce);
  });
});
