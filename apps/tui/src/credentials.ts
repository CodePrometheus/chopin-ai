import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { chopinHome, writeWhole } from "./home.js";
import { locked } from "./lock.js";

/**
 * Credentials kept in one file only this user can read, one per provider. Every process of this machine's chopin
 * shares it, so a sign-in in a terminal reaches the service at once, and its writes are serialized across processes.
 */
export class FileCredentialStore implements CredentialStore {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.#all())[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(await this.#all()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(providerId: string, change: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.#locked(async () => {
      const all = await this.#all();
      const next = await change(all[providerId]);
      if (next === undefined) return all[providerId];
      await this.#write({ ...all, [providerId]: next });
      return next;
    }, options);
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.#locked(async () => {
      const { [providerId]: _gone, ...rest } = await this.#all();
      await this.#write(rest);
    }, options);
  }

  async #locked<T>(work: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    await mkdir(dirname(this.#file), { recursive: true });
    return locked(`${this.#file}.lock`, work, options?.signal);
  }

  async #all(): Promise<Record<string, Credential>> {
    const text = await readFile(this.#file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    });
    const all = JSON.parse(text) as unknown;
    if (typeof all !== "object" || all === null || Array.isArray(all)) throw new Error(`${this.#file} holds no credentials object`);
    return all as Record<string, Credential>;
  }

  async #write(all: Record<string, Credential>): Promise<void> {
    await writeWhole(this.#file, `${JSON.stringify(all, null, 2)}\n`, 0o600);
  }
}

/** The credentials signed in on this machine, kept in its chopin home. */
export function chopinCredentials(): FileCredentialStore {
  return new FileCredentialStore(join(chopinHome(), "auth.json"));
}

/** Every model chopin knows, reaching each provider with the credentials signed in here or the usual variables. */
export function chopinModels(credentials: CredentialStore = chopinCredentials()): Models {
  return builtinModels({ credentials });
}
