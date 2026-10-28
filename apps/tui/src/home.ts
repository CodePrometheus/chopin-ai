import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { locked } from "./lock.js";

/** Where this machine's chopin state lives: settings, the layer, and each project's store. */
export function chopinHome(): string {
  return process.env.CHOPIN_HOME ?? join(homedir(), ".chopin");
}

export interface Settings {
  /** `provider/model` that new conversations start with; the latest one picked. */
  model?: string;
  /** The models ctrl+p goes through, as pi's patterns name them, such as `provider/id`, a glob, or either with `:level`. */
  enabledModels?: string[];
  /** pi's theme the terminal draws with; the one following the terminal's colors by default. */
  theme?: string;
  /** Whether the model's thinking starts hidden. */
  hideThinking?: boolean;
  /** This installation, as some providers' sign-in asks to know it; made at the first such sign-in. */
  deviceId?: string;
  /** A proxy for every request, used when HTTP_PROXY and HTTPS_PROXY name none. */
  httpProxy?: string;
  /** How the loop that improves the agent runs. */
  rsi?: RsiSettings;
}

export interface RsiSettings {
  /** Directories of other agents' session logs to learn from, one JSON object per line. */
  transcriptSources?: string[];
  /** What the loop may spend a week, in US dollars at list prices. */
  weeklyBudgetUsd?: number;
  /** The model for the loop's frequent, cheap calls, as `provider/model`: sorting failures. */
  regularModel?: string;
  /** The model for the loop's judges and auditor, as `provider/model`; the agent's own model proposes changes. */
  strongModel?: string;
  /** A file of practices the user has ruled out, which the auditor holds every change to. */
  rulesFile?: string;
  /** Whether a change the auditor cannot settle waits for the user's review, rather than being refused. */
  holdForReview?: boolean;
}

const settingsFile = () => join(chopinHome(), "config.json");

/** Where the portable layer every agent of this machine loads is kept. */
export function layerDirectory(): string {
  return join(chopinHome(), "layer");
}

/** Where the loop keeps what it learned for every project, and its records: the ledger, calibration, refusals. */
export function rsiDirectory(): string {
  return join(chopinHome(), "rsi");
}

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

let changing: Promise<unknown> = Promise.resolve();

/**
 * Keeps `change` in the settings, leaving the rest as they are. Changes apply in the order they are made, and one
 * at a time across every chopin of the machine, so none undoes another.
 */
export function changeSettings(change: Partial<Settings>): Promise<void> {
  const next = changing.then(async () => {
    await mkdir(chopinHome(), { recursive: true });
    await locked(`${settingsFile()}.lock`, async () => writeSettings({ ...(await readSettings()), ...change }));
  });
  changing = next.catch(() => {});
  return next;
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
