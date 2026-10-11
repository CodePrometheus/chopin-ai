/**
 * Acceptance checks are pinned by content: a task carries the checks written for it, and
 * delivery refuses any that are missing or differ from what the acceptance task wrote.
 *
 * @module @chopin/team/checks
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function sha256File(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Checks under `root` that are missing or whose content no longer matches its digest. */
export async function modifiedChecks(root: string, checks: readonly { path: string; sha256: string }[]): Promise<string[]> {
  const digests = await Promise.all(checks.map((check) => sha256File(join(root, check.path))));
  return checks.filter((check, index) => digests[index] !== check.sha256).map((check) => check.path);
}
