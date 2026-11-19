import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { initializeEncryptedStore, subkey, unseal, writeSealed, type EncryptedStoreOptions, type RecoveryHead } from "@chopin-ai/harness-pi";
import { exclusive } from "./lock.js";
import { Vault } from "./vault.js";

export interface CustodyReceipt {
  operationId: string;
  revision: number;
  action: "enrolled";
  createdAt: string;
}

/** Only the host's current admitted initializer receives these capabilities. */
export interface InitializationAuthority {
  verifyCreation(): Promise<void>;
  /** Returns independently owned key bytes; the initializer wipes them after use. */
  key(): Promise<{ operationId: string; key: Uint8Array }>;
  complete(head: RecoveryHead): Promise<CustodyReceipt>;
}

export interface InitializationReceipt {
  version: 1;
  operationId: string;
  confirmedHead: RecoveryHead;
  custody: CustodyReceipt;
}

export interface InitializationOptions {
  volume: string;
  home: string;
  operationId: string;
  authority: InitializationAuthority;
  storage: Omit<EncryptedStoreOptions, "dir" | "key" | "create">;
}

/** Initializes or reconciles the original vault and store without starting an execution service. */
export async function initializeProject(options: InitializationOptions): Promise<InitializationReceipt> {
  if (!isAbsolute(options.volume) || !isAbsolute(options.home) || options.operationId === "") throw new Error("initialization requires trusted absolute locations and an operation identity");
  requireSeparate(resolve(options.volume), resolve(options.home));
  const lease = await options.authority.key();
  if (lease.operationId !== options.operationId || lease.key.length !== 32) {
    lease.key.fill(0);
    throw new Error("the host key lease does not belong to this initialization");
  }
  const key = Buffer.from(lease.key);
  lease.key.fill(0);
  const receiptKey = subkey(key, "initialization");
  let lock: { close(): void } | undefined;
  try {
    if (await stat(options.volume).catch(missing) === undefined) {
      await options.authority.verifyCreation();
      await mkdir(options.volume, { recursive: true, mode: 0o700 });
    }
    lock = exclusive(join(options.volume, "initialization.lock"), 0);
    if (lock === undefined) throw new Error("another initializer owns this vault");
    const file = join(options.volume, "initialization");
    const context = `chopin initialization ${options.operationId}`;
    const previous = await readFile(file).catch(missing);
    let recorded: unknown;
    if (previous !== undefined) {
      recorded = JSON.parse(unseal(receiptKey, context, previous).toString()) as unknown;
      if (recorded === null || typeof recorded !== "object" || !("version" in recorded) || recorded.version !== 1 || !("operationId" in recorded) || recorded.operationId !== options.operationId) throw new Error("the existing initialization receipt does not match this operation");
    }
    await mkdir(options.home, { recursive: true, mode: 0o700 });
    requireSeparate(await realpath(options.volume), await realpath(options.home));
    const vault = await Vault.initialize(options.volume, options.home, key, () => options.authority.verifyCreation());
    const store = vault.store;
    let head: RecoveryHead;
    try {
      head = await initializeEncryptedStore({ ...options.storage, ...store, verifyCreation: () => options.authority.verifyCreation() });
    } finally { store.key.fill(0); }
    await vault.close();
    const custody = await options.authority.complete(head);
    if (custody.operationId !== options.operationId || custody.action !== "enrolled" || !Number.isSafeInteger(custody.revision) || custody.revision < 1 || !Number.isFinite(Date.parse(custody.createdAt))) throw new Error("the host returned an invalid initialization receipt");
    const receipt: InitializationReceipt = { version: 1, operationId: options.operationId, confirmedHead: head, custody };
    if (previous !== undefined && !isDeepStrictEqual(recorded, receipt)) throw new Error("the original initialization receipt conflicts with the confirmed store");
    if (previous === undefined) await writeSealed(file, receiptKey, context, Buffer.from(JSON.stringify(receipt)));
    return receipt;
  } finally {
    // Initialization starts no watchers; failure must not publish a replacement home manifest.
    try { lock?.close(); }
    finally { key.fill(0); receiptKey.fill(0); }
  }
}

function requireSeparate(volume: string, home: string): void {
  if (volume === home || volume.startsWith(`${home}${sep}`) || home.startsWith(`${volume}${sep}`)) throw new Error("the sealed volume and restored home must be separate locations");
}

function missing(error: NodeJS.ErrnoException): undefined {
  if (error.code !== "ENOENT") throw error;
  return undefined;
}
