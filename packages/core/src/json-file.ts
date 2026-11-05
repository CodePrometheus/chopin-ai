import { readFile } from "node:fs/promises";

/**
 * Reading JSON and JSON Lines files, whose errors name the file and never quote it: a parser's complaint quotes what
 * it read, and a file may hold a credential.
 */

/** A file that does not hold what it should, told by its name alone. */
export class InvalidFile extends Error {}

/** `text`, read from `file`, as JSON; `line` is its line in a JSON Lines file. */
export function parseJson(text: string, file: string, line?: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidFile(`${file} is not valid JSON${line === undefined ? "" : ` at line ${line}`}`);
  }
}

/** The JSON `file` holds, or `undefined` when there is no such file. */
export async function readJson(file: string): Promise<unknown> {
  const text = await readOptional(file);
  return text === undefined ? undefined : parseJson(text, file);
}

/** The JSON object `file` holds, or `undefined` when there is no such file; any other value in it is no `what`. */
export async function readJsonObject(file: string, what: string): Promise<Record<string, unknown> | undefined> {
  const value = await readJson(file);
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidFile(`${file} holds no ${what}`);
  return value as Record<string, unknown>;
}

/** The values of the JSON Lines `file`, blank lines aside; none when there is no such file. */
export async function readJsonLines(file: string): Promise<unknown[]> {
  return parseJsonLines((await readOptional(file)) ?? "", file);
}

/** `text`, read from the JSON Lines `file`, one value per line, blank lines aside. */
export function parseJsonLines(text: string, file: string): unknown[] {
  return text.split("\n").flatMap((line, index) => (line.trim() === "" ? [] : [parseJson(line, file, index + 1)]));
}

async function readOptional(file: string): Promise<string | undefined> {
  return readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}
