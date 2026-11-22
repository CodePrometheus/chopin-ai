import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { subkey, syncDirectory, unseal, writeSealed } from "@chopin-ai/harness-pi";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/** API keys in the protected volume of a single admitted writer. */
export class PersonalCredentials implements CredentialStore {
  readonly #file: string;
  readonly #key: Buffer;
  readonly #binding: string;
  #line: Promise<unknown> = Promise.resolve();
  #uncertain = false;
  #closed = false;

  constructor(file: string, key: Uint8Array, agent: string, owner: string) {
    this.#file = file;
    this.#key = subkey(key, "personal model credentials");
    this.#binding = JSON.stringify(["personal model credentials", agent, owner]);
  }

  read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.#ordered((keys) => credential(keys.get(provider)), options);
  }

  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return this.#ordered<CredentialInfo[]>((keys) => [...keys.keys()].map((providerId) => ({ providerId, type: "api_key" })), options);
  }

  modify(provider: string, change: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.#ordered(async (keys) => {
      const current = keys.get(provider);
      const next = await change(credential(current));
      if (next === undefined) return credential(current);
      if (next.type !== "api_key" || !next.key || next.env !== undefined) throw new Error("a personal API key is required");
      if (next.key !== current) {
        keys.set(provider, next.key);
        await this.#write(keys);
      }
      return credential(next.key);
    }, options);
  }

  delete(provider: string, options?: AuthOperationOptions): Promise<void> {
    return this.#ordered(async (keys) => {
      if (keys.delete(provider)) await this.#write(keys);
    }, options);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#line;
    this.#key.fill(0);
  }

  #ordered<T>(work: (keys: Map<string, string>) => T | Promise<T>, options?: AuthOperationOptions): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("personal model credentials are closed"));
    const queued = this.#line.then(async () => {
      options?.signal?.throwIfAborted();
      // A failed acknowledgement may follow rename. Reconcile and flush the observed file before serving it.
      if (this.#uncertain) await syncDirectory(dirname(this.#file));
      const keys = await this.#read();
      this.#uncertain = false;
      return work(keys);
    });
    this.#line = queued.then(() => {}, () => {});
    return queued.catch(() => { throw new Error("protected model credentials are unavailable"); });
  }

  async #read(): Promise<Map<string, string>> {
    const bytes = await readFile(this.#file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (bytes === undefined) return new Map();
    const clear = unseal(this.#key, this.#binding, bytes);
    try {
      const rows: unknown = JSON.parse(clear.toString("utf8"));
      if (!Array.isArray(rows)) throw new Error("invalid personal credentials");
      const keys = new Map<string, string>();
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" ||
            typeof row[1] !== "string" || row[1] === "" || keys.has(row[0])) throw new Error("invalid personal credentials");
        keys.set(row[0], row[1]);
      }
      return keys;
    } finally {
      clear.fill(0);
    }
  }

  async #write(keys: Map<string, string>): Promise<void> {
    const clear = Buffer.from(JSON.stringify([...keys]));
    this.#uncertain = true;
    try {
      await writeSealed(this.#file, this.#key, this.#binding, clear);
      this.#uncertain = false;
    } finally {
      clear.fill(0);
    }
  }
}

function credential(key: string | undefined): Credential | undefined {
  return key === undefined ? undefined : { type: "api_key", key };
}
