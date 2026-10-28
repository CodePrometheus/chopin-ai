import { layerUsage, type LayerVersions } from "@chopin-ai/core";
import { readSession, type Source } from "./harvest.js";

/** How long a skill the loop added may go unread before it is archived. */
const UNUSED_MS = 30 * 24 * 60 * 60_000;

/**
 * Archives the loop's skills that no recent session read, once they are older than the unused period; pinned ones
 * stay. Instructions are left alone, since every session loads them and none records whether it followed one.
 * Returns the ids archived; an archived item comes back with `chopin evolve undo`'s reverse, a new version.
 */
export async function archiveUnused(versions: LayerVersions, sources: readonly Source[], secrets: readonly string[], now = Date.now()): Promise<string[]> {
  const items = await versions.items(await versions.current());
  const old = items.filter((item) => item.kind === "skill" && !item.archived && !item.pinned && now - Date.parse(item.added) >= UNUSED_MS);
  if (old.length === 0) return [];
  const read = new Set<string>();
  for (const source of sources) {
    for (const name of layerUsage(await readSession(source, secrets), []).skills.keys()) read.add(name);
  }
  const unused = old.filter((item) => item.skill !== undefined && !read.has(item.skill)).map((item) => item.id);
  if (unused.length > 0) await versions.commit((all) => all.map((item) => (unused.includes(item.id) ? { ...item, archived: true } : item)));
  return unused;
}
