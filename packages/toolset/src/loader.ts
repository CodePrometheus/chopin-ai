import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { validateToolset } from "./schema.js";
import type { ToolsetDef } from "./schema.js";

/** Load every *.yaml toolset under the given directories; a missing directory is skipped. */
export async function loadToolsets(dirs: string[]): Promise<ToolsetDef[]> {
  const sets: ToolsetDef[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const name of names) {
      if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
      const path = join(dir, name);
      const raw = parse(await readFile(path, "utf8"));
      sets.push(validateToolset(raw, path));
    }
  }
  const seen = new Set<string>();
  for (const s of sets) {
    if (seen.has(s.name)) throw new Error(`duplicate toolset name: ${s.name}`);
    seen.add(s.name);
  }
  return sets;
}
