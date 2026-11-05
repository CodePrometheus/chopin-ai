import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { InvalidFile, readJson } from "../json-file.js";
import { parseGates, type GateRule } from "./gates.js";
import { parseMcpServers, type McpServer } from "./mcp.js";
import { loadSkills, type Skill } from "./skills.js";

/**
 * The portable tier of the mutable layer: everything in it is an open format that both harnesses load the
 * same way. A layer is a directory:
 *
 *   AGENTS.md          instructions
 *   skills/<name>/     Agent Skills
 *   mcp.json           MCP servers
 *   gates.yaml         gate rules
 *
 * Every file is optional; an empty directory is an empty layer.
 */
export interface Layer {
  instructions: string | undefined;
  skills: Skill[];
  mcpServers: Record<string, McpServer>;
  gates: GateRule[];
}

export type LayerResult = { ok: true; layer: Layer } | { ok: false; problems: string[] };

export async function loadLayer(directory: string): Promise<LayerResult> {
  const problems: string[] = [];
  const instructions = await optional(join(directory, "AGENTS.md"));
  const skills = await loadSkills(join(directory, "skills"), problems);
  const mcpServers = parseMcpServers(await structured(join(directory, "mcp.json"), readJson, problems), "mcp.json", problems);
  const gates = parseGates(await structured(join(directory, "gates.yaml"), readYaml, problems), "gates.yaml", problems);
  return problems.length === 0 ? { ok: true, layer: { instructions, skills, mcpServers, gates } } : { ok: false, problems };
}

async function optional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** What `read` makes of the file at `path`; one it cannot read as it should is a problem, told by its name alone. */
async function structured(path: string, read: (path: string) => Promise<unknown>, problems: string[]): Promise<unknown> {
  try {
    return await read(path);
  } catch (error) {
    if (!(error instanceof InvalidFile)) throw error;
    problems.push(error.message);
    return undefined;
  }
}

async function readYaml(path: string): Promise<unknown> {
  const text = await optional(path);
  if (text === undefined) return undefined;
  try {
    return parse(text);
  } catch {
    // The parser shows the lines around its complaint.
    throw new InvalidFile(`${path} is not valid YAML`);
  }
}
