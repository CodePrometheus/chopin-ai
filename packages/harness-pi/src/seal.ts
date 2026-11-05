import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { open, rename } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Data sealed at rest: encrypted and authenticated with AES-256-GCM under a fresh nonce, and bound to a context the
 * opener must name again, so sealed bytes moved where other bytes belong do not open.
 */

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Data is encrypted this much at a time, so sealing a large image holds one copy of it, not two. */
const CHUNK_BYTES = 1 << 20;

/** Sealed bytes that do not open: changed, sealed under another key, or sealed for another context. */
export class Unsealable extends Error {}

/** A key for one purpose alone, derived from `key`, so that none of them reveals another or `key`. */
export function subkey(key: Uint8Array, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key, new Uint8Array(0), `chopin ${purpose}`, 32));
}

/** `data` sealed under `key` for `context`: nonce, ciphertext, tag. */
export function seal(key: Uint8Array, context: string, data: Uint8Array): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce).setAAD(Buffer.from(context));
  return Buffer.concat([nonce, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
}

/** What `seal` sealed under `key` for `context`. */
export function unseal(key: Uint8Array, context: string, sealed: Uint8Array): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new Unsealable();
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, NONCE_BYTES)).setAAD(Buffer.from(context));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new Unsealable();
  }
}

/**
 * Writes `data` sealed for `context` to `file` whole and durably: after `header`, written as it is, into a draft
 * beside it, flushed, then renamed over it, so a stop midway leaves the file as it was.
 */
export async function writeSealed(file: string, key: Uint8Array, context: string, data: Uint8Array, header: Uint8Array = new Uint8Array(0)): Promise<void> {
  const draft = `${file}.partial`;
  const handle = await open(draft, "w", 0o600);
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce).setAAD(Buffer.from(context));
    await handle.write(Buffer.concat([header, nonce]));
    for (let at = 0; at < data.length; at += CHUNK_BYTES) await handle.write(cipher.update(data.subarray(at, at + CHUNK_BYTES)));
    await handle.write(Buffer.concat([cipher.final(), cipher.getAuthTag()]));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(draft, file);
  await syncDirectory(dirname(file));
}

/** Makes what was renamed or created in `directory` outlast a crash. */
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
