import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Layer } from "./layer.js";
import { loadSkills, type Skill } from "./skills.js";

/** One thing the loop added to the layer, with where it came from and where it has passed the gate. */
export interface LayerItem {
  /** Stable across versions. */
  id: string;
  kind: "instruction" | "skill";
  /** An instruction's text. */
  text?: string;
  /** A skill's name; its files are under `skills/<name>/` in the version. */
  skill?: string;
  /** Where it passed the gate: model references such as `provider/id`, and harness names. */
  validated: { models: string[]; harnesses: string[] };
  /** The kind of failure it answers and the certificate that admitted it. */
  source: { failure?: string; certificate?: string };
  pinned: boolean;
  archived: boolean;
  added: string;
}

/** What a session runs with, for choosing the items that apply to it. */
export interface Runner {
  model: string;
  harness: string;
  /** When true, an item applies on every model, not only those it passed the gate on. */
  anyModel?: boolean;
}

/** Limits on what every session carries, so the layer cannot grow without bound. */
export const LAYER_LIMITS = { residentTokens: 4000, skills: 30 } as const;

const ITEMS = "items.json";
const CHECKSUM = "SHA256";
const CURRENT = "current";

/**
 * The loop's versions of the layer under one directory: each version is a whole directory written beside the others
 * and published by renaming it into place, so a crash never leaves a half-written one, and `current` names the one
 * in use. Every change, including archiving and pinning, is a new version.
 */
export class LayerVersions {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** The version in use; 0 is the empty one. */
  async current(): Promise<number> {
    const text = await readFile(join(this.root, CURRENT), "utf8").catch(absent);
    return text === undefined ? 0 : Number(text.trim());
  }

  async items(version: number): Promise<LayerItem[]> {
    if (version === 0) return [];
    return JSON.parse(await readFile(join(this.directory(version), ITEMS), "utf8")) as LayerItem[];
  }

  directory(version: number): string {
    return join(this.root, `v${version}`);
  }

  /**
   * A new version made from the current one: `edit` gives its items, and `files` writes (a string) or removes
   * (`null`) files by their path in the version. The new version becomes current.
   */
  async commit(edit: (items: LayerItem[]) => LayerItem[], files: Readonly<Record<string, string | null>> = {}): Promise<number> {
    await mkdir(this.root, { recursive: true });
    const from = await this.current();
    const next = (await this.versions()).reduce((max, v) => Math.max(max, v), from) + 1;
    const staging = await mkdtemp(join(this.root, ".staging-"));
    try {
      if (from !== 0) await cp(this.directory(from), staging, { recursive: true });
      for (const [path, text] of Object.entries(files)) {
        const target = join(staging, path);
        if (relative(staging, target).startsWith("..")) throw new Error(`${path} is outside the layer`);
        if (text === null) await rm(target, { recursive: true, force: true });
        else {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, text);
        }
      }
      await writeFile(join(staging, ITEMS), JSON.stringify(edit(await this.items(from)), null, 2));
      await writeFile(join(staging, CHECKSUM), await checksum(staging));
      await rename(staging, this.directory(next));
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    await this.use(next);
    return next;
  }

  /** Makes `version` the one in use, by an atomic replace of the pointer. */
  async use(version: number): Promise<void> {
    const temporary = join(this.root, `.${CURRENT}-${process.pid}`);
    await writeFile(temporary, `${version}\n`);
    await rename(temporary, join(this.root, CURRENT));
  }

  /** Whether `version` still holds exactly what was written when it was made. */
  async intact(version: number): Promise<boolean> {
    if (version === 0) return true;
    const recorded = await readFile(join(this.directory(version), CHECKSUM), "utf8").catch(absent);
    return recorded !== undefined && recorded === (await checksum(this.directory(version)).catch(() => undefined));
  }

  /**
   * When the version in use was changed after it was made, goes back to the newest earlier version that was not, and
   * says which versions it moved between.
   */
  async recover(): Promise<{ from: number; to: number } | undefined> {
    const from = await this.current();
    if (await this.intact(from)) return undefined;
    const earlier = (await this.versions()).filter((v) => v < from).sort((a, b) => b - a);
    let to = 0;
    for (const version of earlier) {
      if (await this.intact(version)) {
        to = version;
        break;
      }
    }
    await this.use(to);
    return { from, to };
  }

  private async versions(): Promise<number[]> {
    const names = await readdir(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return names.flatMap((name) => (/^v\d+$/.test(name) ? [Number(name.slice(1))] : []));
  }
}

/** The layer a session runs with: the hand-written `base`, then the loop's items that apply to `runner`. */
export async function effectiveLayer(base: Layer, versions: LayerVersions, version: number, runner: Runner): Promise<Layer> {
  const applies = (item: LayerItem) => !item.archived && item.validated.harnesses.includes(runner.harness) &&
    (runner.anyModel === true || item.validated.models.includes(runner.model));
  const items = (await versions.items(version)).filter(applies);
  const texts = items.flatMap((item) => (item.kind === "instruction" && item.text !== undefined ? [item.text] : []));
  const instructions = [base.instructions, ...texts].filter((text) => text !== undefined && text !== "").join("\n\n");
  const names = new Set(items.flatMap((item) => (item.kind === "skill" && item.skill !== undefined ? [item.skill] : [])));
  const problems: string[] = [];
  const added = (await loadSkills(join(versions.directory(version), "skills"), problems)).filter((skill) => names.has(skill.name));
  if (problems.length > 0) throw new Error(`layer version ${version}: ${problems.join("; ")}`);
  const skills: Skill[] = [...base.skills.filter((skill) => !names.has(skill.name)), ...added];
  return { ...base, instructions: instructions === "" ? undefined : instructions, skills };
}

/** What in `layer` exceeds the limits on what every session carries; empty when within them. */
export function overLimits(layer: Layer): string[] {
  const resident = (layer.instructions ?? "").length + layer.skills.reduce((n, s) => n + s.name.length + s.description.length + 4, 0);
  const tokens = Math.ceil(resident / 4);
  return [
    ...(tokens > LAYER_LIMITS.residentTokens ? [`resident context is about ${tokens} tokens, over ${LAYER_LIMITS.residentTokens}`] : []),
    ...(layer.skills.length > LAYER_LIMITS.skills ? [`${layer.skills.length} skills, over ${LAYER_LIMITS.skills}`] : []),
  ];
}

async function checksum(directory: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of (await files(directory)).sort()) {
    if (file === CHECKSUM) continue;
    hash.update(`${file}\0`).update(await readFile(join(directory, file))).update("\0");
  }
  return hash.digest("hex");
}

async function files(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? files(directory, path) : Promise.resolve([path]);
  }));
  return nested.flat();
}

function absent(error: NodeJS.ErrnoException): undefined {
  if (error.code === "ENOENT") return undefined;
  throw error;
}
