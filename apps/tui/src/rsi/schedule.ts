import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { credentialsText } from "../credentials.js";
import { readSettings, rsiDirectory, writeWhole } from "../home.js";

/** How long the loop waits between runs it starts on its own. */
export const EVOLVE_EVERY_MS = 6 * 60 * 60_000;

export interface EvolveOptions {
  now?: number;
  /** Credentials the loop is handed through a pipe, where they live in this process alone; else it reads its home's. */
  credentials?: CredentialStore;
}

/**
 * Starts `chopin evolve` in the background when the loop is set up, its last run is long enough ago, and `idle` says
 * the agent has nothing in hand, so the loop never competes with the user's own work. `chopin` is the node arguments
 * that start chopin. Says whether it started one.
 */
export async function evolveIfDue(chopin: readonly string[], home: string, idle: () => Promise<boolean>, options: EvolveOptions = {}): Promise<boolean> {
  const now = options.now ?? Date.now();
  if ((await readSettings()).rsi?.weeklyBudgetUsd === undefined) return false;
  const root = rsiDirectory();
  const marker = join(root, "last-run.json");
  const last = await readFile(marker, "utf8").then((text) => (JSON.parse(text) as { at: number }).at, () => 0);
  if (now - last < EVOLVE_EVERY_MS || !(await idle())) return false;
  const handed = options.credentials === undefined ? undefined : await credentialsText(options.credentials);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeWhole(marker, JSON.stringify({ at: now }), 0o600);
  const log = await open(join(root, "evolve.log"), "a", 0o600);
  try {
    const child = spawn(process.execPath, [...chopin, "evolve", ...(handed === undefined ? [] : ["--credentials-on-stdin"])], {
      detached: true,
      stdio: [handed === undefined ? "ignore" : "pipe", log.fd, log.fd],
      env: { ...process.env, CHOPIN_HOME: home },
    });
    // Never on a command line or in the environment, where other processes of the machine could read them.
    child.stdin?.on("error", () => {});
    child.stdin?.end(handed);
    child.unref();
  } finally {
    await log.close();
  }
  return true;
}
