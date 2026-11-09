import { createHash, randomBytes } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { subkey, unseal, Unsealable, writeSealed, WrongKey } from "@chopin-ai/harness-pi";

const CHECK = "key-check";
const STORE = "store";
const HOME = "home";
const MANIFEST = "manifest";
const OBJECTS = "objects";

/** The home's files as a sync left them on the volume, by their paths in the home. */
interface Manifest {
  generation: number;
  files: Record<string, { object: string; sha256: string; mode: number }>;
}

/** A file of the home as last sealed, and how it looked then, so one unchanged since is not read again. */
interface Sealed {
  object: string;
  sha256: string;
  mode: number;
  size: number;
  mtimeMs: number;
}

/** A sealed home whose manifest or files were changed, so it is not opened. */
export class TamperedHome extends Error {}

/**
 * The persistent volume of a sealed service, holding nothing but what is sealed with the owner's key: what tells that
 * key from any other, the conversation store, and the files of the chopin home. The home itself lives in memory;
 * opening the vault restores it, and syncs seal what changed in it since.
 */
export class Vault {
  readonly #volume: string;
  readonly #home: string;
  readonly #key: Uint8Array;
  readonly #homeKey: Buffer;
  #sealed = new Map<string, Sealed>();
  #generation = 0;
  /** Syncs, one at a time. */
  #line: Promise<unknown> = Promise.resolve();
  #syncing: NodeJS.Timeout | undefined;
  #watching: FSWatcher | undefined;

  private constructor(volume: string, home: string, key: Uint8Array) {
    this.#volume = volume;
    this.#home = home;
    this.#key = key;
    this.#homeKey = subkey(key, "home");
  }

  /** Opens the vault on `volume` with `key`, refusing any key but the one it was first opened with, and restores `home`. */
  static async open(volume: string, home: string, key: Uint8Array): Promise<Vault> {
    await checkKey(volume, key);
    const vault = new Vault(volume, home, key);
    await vault.#restore();
    return vault;
  }

  /** Refuses any key but the vault's own, as opening does. */
  verify(key: Uint8Array): Promise<void> {
    return checkKey(this.#volume, key);
  }

  /** Where the conversation store is sealed, under a key of its own. */
  get store(): { dir: string; key: Buffer } {
    return { dir: join(this.#volume, STORE), key: subkey(this.#key, "store") };
  }

  /** Seals what changed in the home since the last sync: new and changed files, and which are gone. */
  sync(): Promise<void> {
    const next = this.#line.then(() => this.#sync());
    this.#line = next.catch(() => {});
    return next;
  }

  /**
   * Syncs every `everyMs` until closed, and at once when a file at the top of the home changes: settings and
   * credentials, which another process may write too, such as the loop refreshing a token. A sync that failed is told
   * to `report`; the next one tries again.
   */
  keepSynced(everyMs: number, report: (error: unknown) => void): void {
    this.#stopSyncing();
    const sync = () => void this.sync().catch(report);
    this.#syncing = setInterval(sync, everyMs);
    this.#syncing.unref();
    this.#watching = watch(this.#home, sync).on("error", report);
    this.#watching.unref();
  }

  /** Stops syncing on its own, after one last sync. */
  async close(): Promise<void> {
    this.#stopSyncing();
    await this.sync();
  }

  #stopSyncing(): void {
    clearInterval(this.#syncing);
    this.#watching?.close();
  }

  async #restore(): Promise<void> {
    const manifest = await this.#manifest();
    if (manifest === undefined) return;
    this.#generation = manifest.generation;
    for (const [path, file] of Object.entries(manifest.files)) {
      const at = join(this.#home, path);
      // One there already outlived a service before this one in the same pod, and is newer than its sealed copy.
      if ((await stat(at).catch(() => undefined)) !== undefined) {
        this.#sealed.set(path, { ...file, size: -1, mtimeMs: -1 });
        continue;
      }
      const sealed = await readFile(join(this.#volume, HOME, OBJECTS, file.object)).catch(() => undefined);
      let content: Buffer;
      try {
        if (sealed === undefined) throw new Unsealable();
        content = unseal(this.#homeKey, objectContext(file.object), sealed);
      } catch (error) {
        if (!(error instanceof Unsealable)) throw error;
        throw new TamperedHome(`the sealed copy of ${path} in the home is missing or does not open with this key: it was changed`);
      }
      await mkdir(dirname(at), { recursive: true, mode: 0o700 });
      await writeFile(at, content, { mode: file.mode });
      const now = await stat(at);
      this.#sealed.set(path, { ...file, size: now.size, mtimeMs: now.mtimeMs });
    }
  }

  async #manifest(): Promise<Manifest | undefined> {
    const sealed = await readFile(join(this.#volume, HOME, MANIFEST)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (sealed === undefined) return undefined;
    try {
      return JSON.parse(unseal(this.#homeKey, MANIFEST_CONTEXT, sealed).toString("utf8")) as Manifest;
    } catch (error) {
      if (!(error instanceof Unsealable)) throw error;
      throw new TamperedHome("the home's sealed manifest does not open with this key: it was changed");
    }
  }

  async #sync(): Promise<void> {
    const objects = join(this.#volume, HOME, OBJECTS);
    await mkdir(objects, { recursive: true, mode: 0o700 });
    const now = new Map<string, Sealed>();
    let changed = false;
    for (const path of await homeFiles(this.#home)) {
      const at = join(this.#home, path);
      // A file gone between listing and reading, such as a draft renamed into place, is passed over.
      const info = await stat(at).catch(() => undefined);
      if (info === undefined || !info.isFile()) continue;
      const mode = info.mode & 0o777;
      const known = this.#sealed.get(path);
      if (known !== undefined && known.size === info.size && known.mtimeMs === info.mtimeMs && known.mode === mode) {
        now.set(path, known);
        continue;
      }
      const content = await readFile(at).catch(() => undefined);
      if (content === undefined) continue;
      const sha256 = createHash("sha256").update(content).digest("hex");
      changed ||= known?.sha256 !== sha256 || known.mode !== mode;
      if (known?.sha256 === sha256) {
        now.set(path, { ...known, mode, size: info.size, mtimeMs: info.mtimeMs });
        continue;
      }
      const object = randomBytes(16).toString("hex");
      await writeSealed(join(objects, object), this.#homeKey, objectContext(object), content);
      now.set(path, { object, sha256, mode, size: info.size, mtimeMs: info.mtimeMs });
    }
    changed ||= [...this.#sealed.keys()].some((path) => !now.has(path));
    this.#sealed = now;
    if (!changed) return;
    this.#generation += 1;
    const manifest: Manifest = {
      generation: this.#generation,
      files: Object.fromEntries([...now].map(([path, { object, sha256, mode }]) => [path, { object, sha256, mode }])),
    };
    await writeSealed(join(this.#volume, HOME, MANIFEST), this.#homeKey, MANIFEST_CONTEXT, Buffer.from(JSON.stringify(manifest)));
    // Sealed copies the manifest no longer names, and drafts a stop left behind.
    const named = new Set([...now.values()].map(({ object }) => object));
    for (const name of await readdir(objects)) if (!named.has(name)) await unlink(join(objects, name)).catch(() => {});
  }
}

const MANIFEST_CONTEXT = "chopin home manifest";
const CHECK_CONTEXT = "chopin key check";

function objectContext(object: string): string {
  return `chopin home file ${object}`;
}

/**
 * Refuses any key but the one the volume was first opened with, recording that one on first use; a volume holding
 * sealed things but no record of its key lost it, and is refused too. Only what the vault writes counts as sealed: a
 * volume's root may hold what its file system put there, such as lost+found.
 */
async function checkKey(volume: string, key: Uint8Array): Promise<void> {
  const file = join(volume, CHECK);
  const check = subkey(key, "check");
  const sealed = await readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (sealed !== undefined) {
    try {
      unseal(check, CHECK_CONTEXT, sealed);
      return;
    } catch (error) {
      if (error instanceof Unsealable) throw new WrongKey();
      throw error;
    }
  }
  await mkdir(volume, { recursive: true, mode: 0o700 });
  if ((await readdir(volume)).some((name) => name === STORE || name === HOME)) throw new TamperedHome(`${volume} holds sealed things but no record of the key they were sealed with`);
  await writeSealed(file, check, CHECK_CONTEXT, randomBytes(16));
}

/** Every regular file under `home`, as a path relative to it. */
async function homeFiles(home: string): Promise<string[]> {
  const entries = await readdir(home, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(home, join(entry.parentPath, entry.name)));
}

