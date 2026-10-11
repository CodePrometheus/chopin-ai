import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { modifiedChecks, sha256File } from "../src/checks.js";
import { changedFiles, currentBranch, deliver, dirtyEntries, landedAs, onTrunk, prepareSlot, releaseSlot, restoreFiles, saveWork, SlotDirtyError } from "../src/git.js";

const run = promisify(execFile);
const REF = { remote: "origin", trunk: "main" };
const directories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd })).stdout.trim();
}

/** A bare remote, a project clone with one commit on main, and two worktree slots. */
async function project() {
  const root = await mkdtemp(join(tmpdir(), "team-git-"));
  directories.push(root);
  const remote = join(root, "remote.git");
  await run("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  const main = join(root, "project");
  await run("git", ["clone", "--quiet", remote, main]);
  await git(main, "config", "user.name", "Team Test");
  await git(main, "config", "user.email", "team@example.com");
  await writeFile(join(main, "shared.txt"), "base\n");
  await git(main, "add", ".");
  await git(main, "commit", "--quiet", "-m", "base");
  await git(main, "push", "--quiet", "origin", "HEAD:main");
  const slots = [join(root, "slot-1"), join(root, "slot-2")];
  for (const slot of slots) await git(main, "worktree", "add", "--quiet", "--detach", slot, "origin/main");
  return { main, remote, slots: slots as [string, string] };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("team git", () => {
  it("saves paused work on the task branch and resumes it in another slot", async () => {
    const { slots: [first, second] } = await project();
    await prepareSlot(first, "team/alpha", REF);
    expect(await currentBranch(first)).toBe("team/alpha");
    await writeFile(join(first, "alpha.txt"), "half done\n");
    expect(await changedFiles(first, REF)).toEqual(["alpha.txt"]);
    await saveWork(first, "team/alpha", "wip: alpha paused", REF);
    expect(await currentBranch(first)).toBeUndefined();
    expect(await dirtyEntries(first)).toEqual([]);
    await prepareSlot(second, "team/alpha", REF);
    expect(await readFile(join(second, "alpha.txt"), "utf8")).toBe("half done\n");
    expect(await changedFiles(second, REF)).toEqual(["alpha.txt"]);
  });

  it("carries checks from the acceptance branch into another task's slot and notices any edit", async () => {
    const { slots: [author, worker] } = await project();
    const path = "tests/alpha.spec.ts";
    await prepareSlot(author, "team/author", REF);
    await mkdir(join(author, "tests"));
    await writeFile(join(author, path), "expect alpha\n");
    const digest = (await sha256File(join(author, path)))!;
    const commit = await saveWork(author, "team/author", "checks for alpha", REF);
    await prepareSlot(worker, "team/alpha", REF);
    await restoreFiles(worker, commit, [path]);
    const checks = [{ path, sha256: digest }];
    expect(await modifiedChecks(worker, checks)).toEqual([]);
    await writeFile(join(worker, path), "expect nothing\n");
    expect(await modifiedChecks(worker, checks)).toEqual([path]);
    await rm(join(worker, path));
    expect(await modifiedChecks(worker, checks)).toEqual([path]);
  });

  it("keeps a local delivery on the task branch and counts it landed once the person merges it", async () => {
    const { main, slots: [first] } = await project();
    await prepareSlot(first, "team/alpha", REF);
    await writeFile(join(first, "alpha.txt"), "alpha\n");
    const result = await deliver(first, "team/alpha", "feat: alpha", "local", REF);
    if (result.kind !== "delivered") throw new Error(result.detail);
    await releaseSlot(first, REF);
    expect(await git(main, "log", "-1", "--format=%s", "origin/main")).toBe("base");
    expect(await git(main, "log", "--format=%s", "origin/main..team/alpha")).toBe("feat: alpha");
    expect(await landedAs(main, result.commit, REF, true)).toBeUndefined();
    await git(main, "merge", "--quiet", "--squash", "team/alpha");
    await git(main, "commit", "--quiet", "-m", "feat: alpha, merged by hand");
    const merged = await git(main, "rev-parse", "HEAD");
    expect(await landedAs(main, result.commit, REF, true)).toBe(merged);
    expect(await landedAs(main, result.commit, REF, false)).toBeUndefined();
  });

  it("refuses to hand out a dirty slot", async () => {
    const { slots: [first] } = await project();
    await writeFile(join(first, "stray.txt"), "left behind\n");
    await expect(prepareSlot(first, "team/alpha", REF)).rejects.toBeInstanceOf(SlotDirtyError);
  });

  it("delivers one squashed commit straight onto the trunk", async () => {
    const { main, slots: [first] } = await project();
    await prepareSlot(first, "team/alpha", REF);
    await writeFile(join(first, "alpha.txt"), "one\n");
    await saveWork(first, "team/alpha", "wip 1", REF);
    await prepareSlot(first, "team/alpha", REF);
    await writeFile(join(first, "alpha.txt"), "two\n");
    const result = await deliver(first, "team/alpha", "feat: alpha", "push", REF);
    expect(result.kind).toBe("delivered");
    const commit = (result as { commit: string }).commit;
    expect(await onTrunk(main, commit, REF)).toBe(true);
    expect(await git(main, "log", "--format=%s", "origin/main")).toBe("feat: alpha\nbase");
    await releaseSlot(first, REF);
    expect(await currentBranch(first)).toBeUndefined();
  });

  it("aborts the rebase and reports the files when the trunk moved underneath", async () => {
    const { main, slots: [first] } = await project();
    await prepareSlot(first, "team/alpha", REF);
    await writeFile(join(first, "shared.txt"), "from the task\n");
    await writeFile(join(main, "shared.txt"), "from someone else\n");
    await git(main, "commit", "--quiet", "-am", "elsewhere");
    await git(main, "push", "--quiet", "origin", "HEAD:main");
    const result = await deliver(first, "team/alpha", "feat: alpha", "push", REF);
    expect(result).toEqual({ kind: "conflict", detail: "conflicts in shared.txt" });
    expect(await currentBranch(first)).toBe("team/alpha");
    expect(await readFile(join(first, "shared.txt"), "utf8")).toBe("from the task\n");
  });

  it("rejects an empty delivery and a commit its hook refuses, keeping the branch intact", async () => {
    const { main, slots: [first] } = await project();
    await prepareSlot(first, "team/alpha", REF);
    expect(await deliver(first, "team/alpha", "feat: nothing", "push", REF)).toEqual({ kind: "rejected", detail: "the task branch has no changes to deliver" });
    const hook = join(main, ".git", "hooks", "commit-msg");
    await writeFile(hook, "#!/bin/sh\necho 'subject must start with feat' >&2\nexit 1\n");
    await chmod(hook, 0o755);
    await writeFile(join(first, "alpha.txt"), "work\n");
    const result = await deliver(first, "team/alpha", "alpha without prefix", "push", REF);
    expect(result.kind).toBe("rejected");
    expect(await git(first, "log", "--format=%s", "-1")).toBe("wip: alpha without prefix");
    expect(await readFile(join(first, "alpha.txt"), "utf8")).toBe("work\n");
  });
});
