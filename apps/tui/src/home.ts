import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where this machine's chopin state lives: settings, the layer, and each project's store. */
export function chopinHome(): string {
  return process.env.CHOPIN_HOME ?? join(homedir(), ".chopin");
}

export interface Settings {
  /** `provider/model` that new conversations start with; the latest one picked. */
  model?: string;
  /** This installation, as some providers' sign-in asks to know it; made at the first such sign-in. */
  deviceId?: string;
  /** A proxy for every request, used when HTTP_PROXY and HTTPS_PROXY name none. */
  httpProxy?: string;
}

const settingsFile = () => join(chopinHome(), "config.json");

export async function readSettings(): Promise<Settings> {
  try {
    return JSON.parse(await readFile(settingsFile(), "utf8")) as Settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  await mkdir(chopinHome(), { recursive: true });
  await writeWhole(settingsFile(), `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Writes `file` whole, so a process reading it at the same moment sees it before or after, never half written;
 * a draft that could not become the file does not stay behind.
 */
export async function writeWhole(file: string, text: string, mode?: number): Promise<void> {
  const draft = `${file}.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(draft, text, mode === undefined ? {} : { mode });
    await rename(draft, file);
  } catch (error) {
    await rm(draft, { force: true });
    throw error;
  }
}
