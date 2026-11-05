/**
 * The owner's data key, which only clients ever hold: made in a client, wrapped for safekeeping by a passphrase and
 * by a recovery key, and unwrapped into a key nothing can read out of the client again. A sealed service opens with a
 * key derived from it, never with the data key itself. Web Crypto alone, so browsers and terminals share it; where
 * the wrapped keys are kept is the integrator's choice.
 */

/** A key Web Crypto holds, as the environment at hand names its type. */
export type DataKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/**
 * PBKDF2-HMAC-SHA256 iterations that make a wrapping key from a passphrase, as the OWASP Password Storage Cheat Sheet
 * recommends for that hash. A wrapped key records its own count, so a later raise leaves earlier ones readable.
 */
export const PASSPHRASE_ITERATIONS = 600_000;

/** Beyond this, a count is no setting but a stall, which a wrapped key from elsewhere must not cause. */
const MOST_ITERATIONS = 10_000_000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/** The data key wrapped with AES-GCM, as an integrator keeps it: JSON, its binary parts in base64url. */
export type WrappedKey =
  | { version: 1; by: "passphrase"; salt: string; iterations: number; iv: string; data: string }
  | { version: 1; by: "recovery"; iv: string; data: string };

/** A passphrase or recovery key that does not open the wrapped key it was given for. */
export class WrongSecret extends Error {
  constructor(by: WrappedKey["by"]) {
    super(by === "passphrase" ? "the passphrase does not open this key" : "the recovery key does not open this key");
  }
}

export interface NewDataKey {
  /** The data key, which nothing reads out of this client; it may be kept as it is, such as in IndexedDB. */
  key: DataKey;
  /** The data key wrapped by the passphrase, and by the recovery key, for the integrator to keep. */
  byPassphrase: WrappedKey;
  byRecovery: WrappedKey;
  /** What opens `byRecovery` when the passphrase is forgotten, for the owner to write down: shown once, kept nowhere. */
  recoveryKey: string;
}

/** A new random data key, wrapped by `passphrase` and by a new recovery key. */
export async function createDataKey(passphrase: string): Promise<NewDataKey> {
  const raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const recovery = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  try {
    return {
      key: await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]),
      byPassphrase: await byPassphrase(raw, passphrase),
      byRecovery: await seal(raw, { version: 1, by: "recovery" }, await recoveryWrapping(recovery)),
      recoveryKey: recoveryText(recovery),
    };
  } finally {
    raw.fill(0);
    recovery.fill(0);
  }
}

/**
 * The data key `wrapped` holds, opened with what wrapped it, the passphrase or the recovery key; the key goes straight
 * into Web Crypto, never into this script's memory.
 */
export async function unwrapDataKey(wrapped: WrappedKey, secret: string): Promise<DataKey> {
  const { key, iv, additionalData } = await opening(wrapped, secret);
  try {
    return await crypto.subtle.unwrapKey("raw", decode(wrapped.data), key, { name: "AES-GCM", iv, additionalData }, "HKDF", false, ["deriveBits"]);
  } catch {
    throw new WrongSecret(wrapped.by);
  }
}

/** The data key of `wrapped`, opened with `secret`, wrapped anew by `passphrase`: a passphrase changed, or set after recovery. */
export async function rewrapDataKey(wrapped: WrappedKey, secret: string, passphrase: string): Promise<WrappedKey> {
  const { key, iv, additionalData } = await opening(wrapped, secret);
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData }, key, decode(wrapped.data)).catch(() => {
    throw new WrongSecret(wrapped.by);
  }));
  try {
    return await byPassphrase(raw, passphrase);
  } finally {
    raw.fill(0);
  }
}

/** The key a sealed service opens with, derived from the data key, for that and nothing else: 32 bytes, base64url. */
export async function serviceKey(key: DataKey): Promise<string> {
  const info = new TextEncoder().encode("chopin service");
  return encode(new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info }, key, KEY_BYTES * 8)));
}

async function byPassphrase(raw: Uint8Array<ArrayBuffer>, passphrase: string): Promise<WrappedKey> {
  if (passphrase === "") throw new Error("a passphrase cannot be empty");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const wrapped = { version: 1, by: "passphrase", salt: encode(salt), iterations: PASSPHRASE_ITERATIONS } as const;
  return seal(raw, wrapped, await passphraseWrapping(passphrase, salt, PASSPHRASE_ITERATIONS));
}

async function seal<T extends Omit<WrappedKey, "iv" | "data">>(raw: Uint8Array<ArrayBuffer>, header: T, key: DataKey): Promise<T & { iv: string; data: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: purpose(header.by) }, key, raw);
  return { ...header, iv: encode(iv), data: encode(new Uint8Array(data)) };
}

/** The wrapping key `secret` makes for `wrapped`, and what AES-GCM opens it with. */
async function opening(wrapped: WrappedKey, secret: string) {
  checkWrapped(wrapped);
  const key = wrapped.by === "passphrase"
    ? await passphraseWrapping(secret, decode(wrapped.salt), wrapped.iterations)
    : await recoveryWrapping(recoveryBytes(secret));
  return { key, iv: decode(wrapped.iv), additionalData: purpose(wrapped.by) };
}

/** Binds a wrapped key to what wraps it, so one wrapped by a passphrase is never read as one wrapped by a recovery key. */
function purpose(by: WrappedKey["by"]): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`chopin data key, wrapped by ${by}`);
}

/** Deliberately slow, so guessing passphrases offline costs as much. NFKC makes one typed on any device the same bytes. */
async function passphraseWrapping(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<DataKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt", "unwrapKey"]);
}

/** A recovery key is random already, so it wraps as it is. */
function recoveryWrapping(recovery: Uint8Array<ArrayBuffer>): Promise<DataKey> {
  return crypto.subtle.importKey("raw", recovery, "AES-GCM", false, ["encrypt", "decrypt", "unwrapKey"]);
}

function checkWrapped(wrapped: WrappedKey): void {
  const binary = (text: unknown) => typeof text === "string" && /^[A-Za-z0-9_-]+$/.test(text);
  const whole = wrapped?.version === 1 && binary(wrapped.iv) && binary(wrapped.data) && (wrapped.by === "recovery"
    || (wrapped.by === "passphrase" && binary(wrapped.salt) && Number.isSafeInteger(wrapped.iterations)
      && wrapped.iterations > 0 && wrapped.iterations <= MOST_ITERATIONS));
  if (!whole) throw new Error("this is no wrapped data key");
}

/** Hexadecimal in groups of eight, which reads back without confusing any two characters. */
function recoveryText(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").replace(/.{8}(?!$)/g, "$&-");
}

/** A recovery key as written down, its case, spaces and dashes aside. */
function recoveryBytes(text: string): Uint8Array<ArrayBuffer> {
  const hex = text.replace(/[\s-]/g, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new WrongSecret("recovery");
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
