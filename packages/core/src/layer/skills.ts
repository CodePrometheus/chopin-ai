import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

/** A skill in the Agent Skills format. Agents get the index; they read the body themselves when it applies. */
export interface Skill {
  name: string;
  description: string;
  /** The skill's directory, holding `SKILL.md` and whatever it bundles. */
  directory: string;
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function loadSkills(root: string, problems: string[]): Promise<Skill[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(missing);
  const skills: Skill[] = [];
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = join(root, entry.name);
    const file = join(directory, "SKILL.md");
    const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      problems.push(error.code === "ENOENT" ? `${file}: missing` : `${file}: ${error.message}`);
      return undefined;
    });
    if (text === undefined) continue;
    const skill = parseSkill(text, entry.name, file, problems);
    if (skill !== undefined) skills.push({ ...skill, directory });
  }
  return skills;
}

function parseSkill(text: string, directoryName: string, file: string, problems: string[]) {
  const match = FRONTMATTER.exec(text);
  if (match === null) {
    problems.push(`${file}: no YAML frontmatter`);
    return undefined;
  }
  let front: unknown;
  try {
    front = parse(match[1] ?? "");
  } catch (error) {
    problems.push(`${file}: frontmatter is not valid YAML: ${(error as Error).message}`);
    return undefined;
  }
  const { name, description } = (typeof front === "object" && front !== null ? front : {}) as Record<string, unknown>;
  const before = problems.length;
  if (typeof name !== "string" || name.length > 64 || !NAME.test(name)) {
    problems.push(`${file}: name must be 1-64 lowercase letters, digits and single hyphens`);
  } else if (name !== directoryName) {
    problems.push(`${file}: name "${name}" must match its directory "${directoryName}"`);
  }
  if (typeof description !== "string" || description.trim() === "" || description.length > 1024) {
    problems.push(`${file}: description must be 1-1024 characters`);
  }
  return problems.length === before ? { name: name as string, description: description as string } : undefined;
}

function missing(error: NodeJS.ErrnoException): never[] {
  if (error.code === "ENOENT") return [];
  throw error;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** A skill's instructions as the model reads them, the same on every harness: its SKILL.md without the frontmatter. */
export function skillBody(text: string): string {
  return text.replace(FRONTMATTER, "");
}
