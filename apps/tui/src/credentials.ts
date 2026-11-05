import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { InMemoryCredentialStore, type AuthOperationOptions, type Credential, type CredentialInfo, type CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readJsonObject } from "@chopin-ai/core";
import { chopinHome, writeKept } from "./home.js";
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
    return ((await readJsonObject(this.#file, "credentials object")) ?? {}) as Record<string, Credential>;
  }

  async #write(all: Record<string, Credential>): Promise<void> {
    await writeKept(this.#file, `${JSON.stringify(all, null, 2)}\n`, 0o600);
  }
}

/** The credentials signed in on this machine, kept in its chopin home. */
export function chopinCredentials(): FileCredentialStore {
  return new FileCredentialStore(join(chopinHome(), "auth.json"));
}

/** Every credential `store` holds, as one text a process this one starts takes over with `credentialsFrom`. */
export async function credentialsText(store: CredentialStore): Promise<string> {
  const all: Record<string, Credential> = {};
  for (const { providerId } of await store.list()) {
    const credential = await store.read(providerId);
    if (credential !== undefined) all[providerId] = credential;
  }
  return JSON.stringify(all);
}

/** The credentials `credentialsText` wrote, held in memory alone. */
export async function credentialsFrom(text: string): Promise<CredentialStore> {
  const store = new InMemoryCredentialStore();
  for (const [providerId, credential] of Object.entries(JSON.parse(text) as Record<string, Credential>)) await store.modify(providerId, async () => credential);
  return store;
}

/**
 * Every model chopin knows, reaching each provider with the credentials signed in here or the usual variables, and
 * the providers `models.json` in the chopin home adds; catalogs are kept beside it, read as kept at the start and
 * fetched anew on request. A `models.json` that cannot be read in full is told to `told` by its name alone.
 */
export async function chopinModels(credentials: CredentialStore = chopinCredentials(), told?: (notice: string) => void): Promise<ModelRuntime> {
  const file = join(chopinHome(), "models.json");
  const runtime = await ModelRuntime.create({ credentials, modelsPath: file });
  // Fresh, the runtime has fetched nothing, so what went wrong lies in what that file adds; the runtime's own account
  // of it may quote the file.
  if (runtime.getError() !== undefined) told?.(`${file} could not be read in full; models it adds may be missing`);
  return runtime;
}
