/**
 * One session drives a project's team at a time: the current lead. Its process holds the
 * lease, a file naming the process and the session. A lease whose process no longer runs is
 * free; a live one changes hands only when a person asks the new lead to take over.
 *
 * @module @chopin/team/lease
 */

import { randomUUID } from "node:crypto";
import { link, readFile, rename, unlink, writeFile } from "node:fs/promises";

import { processIsAlive } from "@chopin/journal";

export interface LeaseHolder {
  pid: number;
  sessionId: string;
  startedAt: string;
  nonce: string;
}

export class Lease {
  constructor(readonly path: string, readonly holder: LeaseHolder) {}

  /** Whether the file still names this holder; another process may have taken over. */
  async held(): Promise<boolean> {
    return (await leaseHolder(this.path))?.nonce === this.holder.nonce;
  }

  /** Give the lease up, unless another process has already taken it over. */
  async release(): Promise<void> {
    if (await this.held()) await unlink(this.path).catch(() => undefined);
  }
}

/** The holder the lease at `path` names, if any. */
export async function leaseHolder(path: string): Promise<LeaseHolder | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<LeaseHolder>;
    return typeof value.pid === "number" && typeof value.sessionId === "string" && typeof value.nonce === "string"
      && typeof value.startedAt === "string"
      ? { pid: value.pid, sessionId: value.sessionId, startedAt: value.startedAt, nonce: value.nonce } : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** Whether a holder's process still runs. */
export function holderAlive(holder: LeaseHolder): boolean {
  return processIsAlive(holder.pid);
}

function newHolder(sessionId: string): LeaseHolder {
  return { pid: process.pid, sessionId, startedAt: new Date().toISOString(), nonce: randomUUID() };
}

/** Write the holder to a private draft first, so the lease always appears complete. */
async function draft(path: string, holder: LeaseHolder): Promise<string> {
  const file = `${path}.${holder.nonce}`;
  await writeFile(file, `${JSON.stringify(holder)}\n`, { flag: "wx", mode: 0o600 });
  return file;
}

/** Take a free lease for `sessionId`; undefined while a running process holds it. */
export async function acquireLease(path: string, sessionId: string): Promise<Lease | undefined> {
  const holder = newHolder(sessionId);
  const file = await draft(path, holder);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await link(file, path);
        return new Lease(path, holder);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const current = await leaseHolder(path);
      if (current !== undefined && holderAlive(current)) return undefined;
      // Remove the dead holder's file only if nobody replaced it since it was read.
      if ((await leaseHolder(path))?.nonce === current?.nonce) await unlink(path).catch(() => undefined);
    }
    return undefined;
  } finally {
    await unlink(file).catch(() => undefined);
  }
}

/** Take the lease over for `sessionId` whoever holds it; the old holder notices and stops driving. */
export async function takeOverLease(path: string, sessionId: string): Promise<{ lease: Lease; previous?: LeaseHolder }> {
  const previous = await leaseHolder(path);
  const holder = newHolder(sessionId);
  await rename(await draft(path, holder), path);
  return { lease: new Lease(path, holder), ...(previous === undefined ? {} : { previous }) };
}
