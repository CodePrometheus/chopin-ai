/**
 * Host-side git for team mode. Workers never commit or push: their sandbox cannot write the
 * repository's shared git directory, and delivery is a host action taken after the gates.
 * Nothing here deletes a branch or discards work, and nothing force-pushes.
 *
 * @module @chopin/team/git
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { DeliveryMode } from "./types.js";

const execFileAsync = promisify(execFile);

export interface TrunkRef {
  remote: string;
  trunk: string;
}

export class GitError extends Error {
  constructor(readonly args: readonly string[], readonly stderr: string) {
    super(`git ${args.join(" ")} failed: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
    this.name = "GitError";
  }
}

export class SlotDirtyError extends Error {
  constructor(readonly slot: string, readonly entries: string[]) {
    super(`slot ${slot} has uncommitted changes: ${entries.slice(0, 5).join(", ")}${entries.length > 5 ? ", ..." : ""}`);
    this.name = "SlotDirtyError";
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const failure = error as { stderr?: string; message: string };
    throw new GitError(args, failure.stderr || failure.message);
  }
}

/** Run git with `input` on its stdin. */
function gitInput(cwd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new GitError(args, stderr || error.message));
      else resolve(stdout);
    });
    child.stdin!.end(input);
  });
}

async function succeeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch (error) {
    if (error instanceof GitError) return false;
    throw error;
  }
}

function nulList(output: string): string[] {
  return output.split("\0").filter((entry) => entry !== "");
}

function trunkRef(ref: TrunkRef): string {
  return `${ref.remote}/${ref.trunk}`;
}

async function fetchTrunk(cwd: string, ref: TrunkRef): Promise<void> {
  await git(cwd, ["fetch", "--quiet", ref.remote, ref.trunk]);
}

/** Uncommitted entries, untracked files included; empty means clean. */
export async function dirtyEntries(slot: string): Promise<string[]> {
  return nulList(await git(slot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
}

export async function currentBranch(slot: string): Promise<string | undefined> {
  const name = (await git(slot, ["branch", "--show-current"])).trim();
  return name === "" ? undefined : name;
}

/**
 * Put a clean slot on the task's branch: an existing branch resumes where the last attempt
 * left it, a new one starts from the latest trunk.
 */
export async function prepareSlot(slot: string, branch: string, ref: TrunkRef): Promise<void> {
  const dirty = await dirtyEntries(slot);
  if (dirty.length > 0) throw new SlotDirtyError(slot, dirty);
  await fetchTrunk(slot, ref);
  if (await succeeds(slot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) {
    await git(slot, ["switch", "--quiet", branch]);
  } else {
    await git(slot, ["switch", "--quiet", "--no-track", "-c", branch, trunkRef(ref)]);
  }
}

/**
 * Keep a paused task's work on its branch and hand the slot back on the trunk. Hooks are
 * skipped: this commit only preserves work and never reaches the trunk as is.
 * @returns The branch head after saving.
 */
export async function saveWork(slot: string, branch: string, message: string, ref: TrunkRef): Promise<string> {
  if (await currentBranch(slot) !== branch) throw new Error(`slot ${slot} is not on ${branch}`);
  if ((await dirtyEntries(slot)).length > 0) {
    await git(slot, ["add", "--all"]);
    await git(slot, ["commit", "--quiet", "--no-verify", "-m", message]);
  }
  const head = (await git(slot, ["rev-parse", "HEAD"])).trim();
  await fetchTrunk(slot, ref);
  await git(slot, ["switch", "--quiet", "--detach", trunkRef(ref)]);
  return head;
}

/** Every path whose content differs between where the task left the trunk and its working tree now. */
export async function changedFiles(slot: string, ref: TrunkRef): Promise<string[]> {
  const base = (await git(slot, ["merge-base", "HEAD", trunkRef(ref)])).trim();
  const files = new Set([
    ...nulList(await git(slot, ["diff", "--name-only", "--no-renames", "-z", base])),
    ...nulList(await git(slot, ["ls-files", "--others", "--exclude-standard", "-z"])),
  ]);
  return [...files].sort();
}

export type DeliveryResult =
  | { kind: "delivered"; commit: string }
  | { kind: "conflict"; detail: string }
  | { kind: "rejected"; detail: string };

/**
 * Squash the task branch into one commit on the latest trunk. `local` leaves it on the task
 * branch; `push` publishes it straight onto the trunk and `pull-request` as the task branch.
 * The final commit runs the project's hooks. A conflict aborts the rebase and leaves the
 * branch as it was before it.
 */
export async function deliver(slot: string, branch: string, message: string, mode: DeliveryMode, ref: TrunkRef): Promise<DeliveryResult> {
  if (await currentBranch(slot) !== branch) throw new Error(`slot ${slot} is not on ${branch}`);
  if ((await dirtyEntries(slot)).length > 0) {
    await git(slot, ["add", "--all"]);
    await git(slot, ["commit", "--quiet", "--no-verify", "-m", `wip: ${message}`]);
  }
  await fetchTrunk(slot, ref);
  const before = (await git(slot, ["rev-parse", "HEAD"])).trim();
  const base = (await git(slot, ["merge-base", "HEAD", trunkRef(ref)])).trim();
  if (base === before) return { kind: "rejected", detail: "the task branch has no changes to deliver" };
  await git(slot, ["reset", "--quiet", "--soft", base]);
  try {
    await git(slot, ["commit", "--quiet", "-m", message]);
  } catch (error) {
    await git(slot, ["reset", "--quiet", "--soft", before]);
    if (error instanceof GitError) return { kind: "rejected", detail: `commit hook: ${error.message}` };
    throw error;
  }
  if (!(await succeeds(slot, ["rebase", "--quiet", trunkRef(ref)]))) {
    const detail = nulList(await git(slot, ["diff", "--name-only", "-z", "--diff-filter=U"])).join(", ");
    await git(slot, ["rebase", "--abort"]);
    return { kind: "conflict", detail: detail === "" ? "rebase onto the trunk failed" : `conflicts in ${detail}` };
  }
  const commit = (await git(slot, ["rev-parse", "HEAD"])).trim();
  if (mode === "local") return { kind: "delivered", commit };
  const target = mode === "push" ? `refs/heads/${ref.trunk}` : `refs/heads/${branch}`;
  try {
    await git(slot, ["push", "--quiet", ref.remote, `HEAD:${target}`]);
  } catch (error) {
    if (error instanceof GitError) return { kind: "rejected", detail: error.message };
    throw error;
  }
  return { kind: "delivered", commit };
}

/** Write `paths` into the slot's working tree exactly as they are in `commit`. */
export async function restoreFiles(slot: string, commit: string, paths: readonly string[]): Promise<void> {
  if (paths.length > 0) await git(slot, ["restore", `--source=${commit}`, "--worktree", "--", ...paths]);
}

/** Hand a clean slot back on the latest trunk once its task has delivered. */
export async function releaseSlot(slot: string, ref: TrunkRef): Promise<void> {
  const dirty = await dirtyEntries(slot);
  if (dirty.length > 0) throw new SlotDirtyError(slot, dirty);
  await fetchTrunk(slot, ref);
  await git(slot, ["switch", "--quiet", "--detach", trunkRef(ref)]);
}

/** Whether `commit` is reachable from the remote trunk, after fetching it. */
export async function onTrunk(cwd: string, commit: string, ref: TrunkRef): Promise<boolean> {
  await fetchTrunk(cwd, ref);
  return succeeds(cwd, ["merge-base", "--is-ancestor", commit, trunkRef(ref)]);
}

/**
 * The trunk commit that carries `commit`: itself once reachable, or, after a squash, rebase or
 * cherry-pick, the recent trunk commit with the same patch. The remote trunk always counts;
 * with `local`, so does the local trunk branch the person merges into.
 */
export async function landedAs(cwd: string, commit: string, ref: TrunkRef, local = false, depth = 200): Promise<string | undefined> {
  await fetchTrunk(cwd, ref);
  const trunks = [trunkRef(ref)];
  if (local && await succeeds(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${ref.trunk}`])) trunks.push(`refs/heads/${ref.trunk}`);
  for (const trunk of trunks) {
    if (await succeeds(cwd, ["merge-base", "--is-ancestor", commit, trunk])) return commit;
  }
  const id = (await gitInput(cwd, ["patch-id", "--stable"], await git(cwd, ["show", "--format=", commit]))).split(" ")[0];
  if (id === undefined || id === "") return undefined;
  for (const trunk of trunks) {
    const ids = await gitInput(cwd, ["patch-id", "--stable"], await git(cwd, ["log", "-p", `-n${depth}`, "--format=commit %H", trunk]));
    const found = ids.split("\n").map((line) => line.split(" ")).find(([patch]) => patch === id)?.[1];
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Trunk commits from oldest to newest that are not ancestors of `base`. */
export async function trunkCommitsSince(cwd: string, base: string, ref: TrunkRef): Promise<string[]> {
  await fetchTrunk(cwd, ref);
  return (await git(cwd, ["rev-list", "--reverse", `${base}..${trunkRef(ref)}`])).split("\n").filter((line) => line !== "");
}

/** How many commits `commit` has in its history, itself included; orders commits on one line of history. */
export async function ancestorCount(cwd: string, commit: string): Promise<number> {
  return Number((await git(cwd, ["rev-list", "--count", commit])).trim());
}

export async function parentOf(cwd: string, commit: string): Promise<string> {
  return (await git(cwd, ["rev-parse", `${commit}^`])).trim();
}

/** Move a clean, unassigned slot to `commit`, detached; `trunk` means the latest remote trunk. */
export async function detachAt(slot: string, commit: string | "trunk", ref: TrunkRef): Promise<void> {
  const dirty = await dirtyEntries(slot);
  if (dirty.length > 0) throw new SlotDirtyError(slot, dirty);
  if (commit === "trunk") await fetchTrunk(slot, ref);
  await git(slot, ["switch", "--quiet", "--detach", commit === "trunk" ? trunkRef(ref) : commit]);
}

/**
 * A digest of the working tree as the task leaves it: HEAD plus the content of every
 * uncommitted entry, ignored files excluded. Two equal digests mean the same tree.
 */
export async function treeDigest(slot: string): Promise<string> {
  const hash = createHash("sha256").update((await git(slot, ["rev-parse", "HEAD"])).trim());
  const paths = nulList(await git(slot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]))
    .map((entry) => entry.slice(3)).sort();
  for (const path of paths) {
    let content: Buffer | undefined;
    try {
      content = await readFile(join(slot, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "EISDIR") throw error;
    }
    hash.update(`\0${path}\0`).update(content === undefined ? "deleted" : createHash("sha256").update(content).digest("hex"));
  }
  return hash.digest("hex");
}
