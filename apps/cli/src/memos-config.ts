import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isCollection, isMap, parseDocument } from "yaml";

/** The memory plugin's config file, resolved in the plugin's own order when it runs under dsh. */
export function memosConfigPath(dshHome: string, env: NodeJS.ProcessEnv = process.env): string {
  const expand = (value: string) => resolve(value.trim().replace(/^~(?=$|\/)/, homedir()));
  if (env["MEMOS_HOME"]?.trim()) return join(expand(env["MEMOS_HOME"]), "config.yaml");
  if (env["MEMOS_CONFIG_FILE"]?.trim()) return expand(env["MEMOS_CONFIG_FILE"]);
  return join(dshHome, "memos-plugin", "config.yaml");
}

/**
 * Turn the memory plugin's usage telemetry off unless the user already chose a value: it ships
 * enabled and reports to its vendor, and chopin installs it on the user's behalf.
 * @returns Whether the file changed.
 */
export async function disableMemosTelemetry(path: string): Promise<boolean> {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`cannot parse ${path}: ${doc.errors[0]!.message}`);
  const telemetry = doc.get("telemetry", true);
  if (telemetry !== undefined && (!isMap(telemetry) || telemetry.has("enabled"))) return false;
  doc.setIn(["telemetry", "enabled"], false);
  for (const node of [doc.contents, doc.get("telemetry", true)]) if (isCollection(node)) node.flow = false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, doc.toString(), { mode: 0o600 });
  return true;
}
