import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readSettings, rsiDirectory, writeWhole } from "../home.js";

/** How long the loop waits between runs it starts on its own. */
export const EVOLVE_EVERY_MS = 6 * 60 * 60_000;

/**
 * Starts `chopin evolve` in the background when the loop is set up, its last run is long enough ago, and `idle` says
 * the agent has nothing in hand, so the loop never competes with the user's own work. Says whether it started one.
 */
export async function evolveIfDue(bin: string, home: string, idle: () => Promise<boolean>, now = Date.now()): Promise<boolean> {
  if ((await readSettings()).rsi?.weeklyBudgetUsd === undefined) return false;
  const root = rsiDirectory();
  const marker = join(root, "last-run.json");
  const last = await readFile(marker, "utf8").then((text) => (JSON.parse(text) as { at: number }).at, () => 0);
  if (now - last < EVOLVE_EVERY_MS || !(await idle())) return false;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeWhole(marker, JSON.stringify({ at: now }), 0o600);
  const log = await open(join(root, "evolve.log"), "a", 0o600);
  try {
    const child = spawn(process.execPath, [bin, "evolve"], { detached: true, stdio: ["ignore", log.fd, log.fd], env: { ...process.env, CHOPIN_HOME: home } });
    child.unref();
  } finally {
    await log.close();
  }
  return true;
}
