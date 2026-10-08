import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { assertCapabilityManifest, capabilityManifestDigest, capabilitySurfaceDigest } from "./manifest.js";
import type { CapabilityManifest } from "./types.js";

export interface StagedArtifact {
  path: string;
  contentDigest: string;
  manifestDigest: string;
  surfaceDigest: string;
  manifest: CapabilityManifest;
  files: string[];
}

export class ArtifactStoreError extends Error {
  constructor(message: string) {
    super(`artifact store: ${message}`);
    this.name = "ArtifactStoreError";
  }
}

function slash(path: string): string {
  return path.split(sep).join("/");
}

async function filesUnder(root: string): Promise<string[]> {
  const pending = [root];
  const files: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new ArtifactStoreError(`symbolic links are not allowed: ${slash(relative(root, path))}`);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
      else throw new ArtifactStoreError(`unsupported file type: ${slash(relative(root, path))}`);
    }
  }
  return files.sort((left, right) => slash(relative(root, left)).localeCompare(slash(relative(root, right))));
}

async function treeDigest(root: string, files: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of files) {
    const rel = slash(relative(root, path));
    const info = await lstat(path);
    hash.update(`${rel}\0${info.size}\0`);
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(path);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function loadManifest(root: string): Promise<CapabilityManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(root, "capability.json"), "utf8"));
  } catch (error) {
    throw new ArtifactStoreError(`cannot read capability.json: ${(error as Error).message}`);
  }
  assertCapabilityManifest(parsed);
  return parsed;
}

async function copyTree(source: string, target: string, files: readonly string[]): Promise<void> {
  for (const sourcePath of files) {
    const rel = relative(source, sourcePath);
    const targetPath = join(target, rel);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
  }
}

export class ArtifactStore {
  constructor(readonly root: string) {}

  /** Validate a source tree not yet committed to the CAS and compute every digest the approval must bind. */
  async inspectSource(source: string): Promise<StagedArtifact> {
    const manifest = await loadManifest(source);
    const files = await filesUnder(source);
    const names = files.map((path) => slash(relative(source, path)));
    if (!names.includes("capability.json")) throw new ArtifactStoreError("capability.json is missing");
    if (!names.includes(manifest.entry)) throw new ArtifactStoreError(`entry ${manifest.entry} is missing`);
    const contentDigest = await treeDigest(source, files);
    return {
      path: source,
      contentDigest,
      manifestDigest: capabilityManifestDigest(manifest),
      surfaceDigest: capabilitySurfaceDigest(manifest),
      manifest,
      files: names,
    };
  }

  async stage(source: string): Promise<StagedArtifact> {
    const inspected = await this.inspectSource(source);
    const { contentDigest, manifest } = inspected;
    const files = inspected.files.map((path) => join(source, path));
    const hex = contentDigest.slice("sha256:".length);
    const target = join(this.root, "sha256", hex);
    const existing = await this.inspect(contentDigest).catch(() => undefined);
    if (existing !== undefined) return existing;

    await mkdir(join(this.root, "sha256"), { recursive: true });
    const temporary = join(this.root, `.staging-${process.pid}-${randomUUID()}`);
    try {
      await mkdir(temporary, { recursive: false });
      await copyTree(source, temporary, files);
      const copiedFiles = await filesUnder(temporary);
      const copiedDigest = await treeDigest(temporary, copiedFiles);
      if (copiedDigest !== contentDigest) throw new ArtifactStoreError("content changed while staging");
      try {
        await rename(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
        const raced = await this.inspect(contentDigest);
        await rm(temporary, { recursive: true, force: true });
        return raced;
      }
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
    return this.inspect(contentDigest);
  }

  async inspect(contentDigest: string): Promise<StagedArtifact> {
    if (!/^sha256:[a-f0-9]{64}$/.test(contentDigest)) throw new ArtifactStoreError("content digest must be sha256:<hex>");
    const path = join(this.root, "sha256", contentDigest.slice("sha256:".length));
    const files = await filesUnder(path);
    const actual = await treeDigest(path, files);
    if (actual !== contentDigest) throw new ArtifactStoreError(`digest mismatch: expected ${contentDigest}, got ${actual}`);
    const manifest = await loadManifest(path);
    return {
      path,
      contentDigest,
      manifestDigest: capabilityManifestDigest(manifest),
      surfaceDigest: capabilitySurfaceDigest(manifest),
      manifest,
      files: files.map((file) => slash(relative(path, file))),
    };
  }
}
