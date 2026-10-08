/**
 * The actual act of turning off MemOS console logging, shared by the preload entry
 * and the plugin entry.
 *
 * MemOS's logger is a module-level singleton: as soon as the module loads it installs
 * a ConsoleTransport that is **always on and writes INFO to stdout**. The config-reading
 * `initLogger()` is only called under `bootstrapMemoryCore({ initLogging: true })`,
 * and its dsh adapter passes `false` (the comment says "embedded hosts keep their
 * own logger") -- so nobody reads the config, that default logger stays, and
 * hundreds of INFO lines go straight into the stdout the TUI is painting on.
 * Upstream 2.0.17 is still like this; no config option or environment variable
 * turns it off.
 *
 * Here we call `initLogger()` once on its behalf, console off, file logging as
 * before -- nothing is lost, the logs just go back to MemOS's own `logs/`.
 *
 * The cost, stated plainly: this deep-imports another package's internal path (it has
 * no `exports` field, so deep imports work, and its own cordis line is a deep path
 * too). Every call site must wrap it in try/catch -- if MemOS reshuffles its
 * internals or is not installed at all, the only outcome allowed is a degraded
 * notice, never a broken startup.
 *
 * @module @chopin/memos-quiet/silence
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Minimal shape of MemOS internal modules, only the parts actually used here. */
interface MemosConfigModule {
  resolveHome: (agent: string, configuredHome: string) => unknown;
  loadConfig: (home: unknown, agent: string) => Promise<{ config: MemosConfig }>;
}
interface MemosLoggerModule {
  initLogger: (config: MemosConfig, home: unknown) => void;
}
interface MemosConfig {
  logging: { console: { enabled: boolean } };
}

const AGENT = "deepseek-harness";
const CONFIG_MODULE = "@memtensor/memos-local-plugin/dist/core/config/index.js";
const LOGGER_MODULE = "@memtensor/memos-local-plugin/dist/core/logger/index.js";

/** The mute outcome hangs on this global key so the plugin entry knows the preload already ran. */
export const OUTCOME_KEY = Symbol.for("chopin.memos-quiet.outcome");

/** Same home rule as the MemOS adapter: explicit config first, otherwise `$DSH_HOME/memos-plugin`. */
function memosHome(): string {
  const dshHome = process.env["DSH_HOME"]?.trim();
  const base = dshHome !== undefined && dshHome !== "" ? dshHome : join(homedir(), ".dsh");
  return join(base, "memos-plugin");
}

/**
 * Resolve and load a MemOS internal module from the given directory.
 *
 * The resolution anchor must be the profile directory, not this package: chopin's
 * packages are `link:`ed into the profile, so resolving `@memtensor/memos-local-plugin`
 * from this package's real path (in the repo) is bound to fail -- it is only installed
 * in the profile's node_modules. And what we need to fix is precisely "the copy of
 * MemOS running in this profile".
 * @param specifier - Deep path inside the MemOS package.
 * @param baseUrl - URL of the anchor directory; falls back to this package's own resolution when omitted.
 * @returns The loaded module.
 */
async function importFrom<T>(specifier: string, baseUrl: string | undefined): Promise<T> {
  if (baseUrl === undefined) return (await import(specifier)) as T;
  const anchor = new URL("package.json", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  return (await import(pathToFileURL(createRequire(anchor).resolve(specifier)).href)) as T;
}

/** Turn a directory path into a resolution anchor URL. */
export function anchorFor(directory: string): string {
  return pathToFileURL(join(directory, "/")).href;
}

/**
 * Turn off MemOS console logging.
 * @param baseUrl - Resolution anchor, usually the profile directory.
 * @returns A one-line outcome ready for display.
 */
export async function silenceMemosConsole(baseUrl: string | undefined): Promise<string> {
  const configModule = await importFrom<MemosConfigModule>(CONFIG_MODULE, baseUrl);
  const loggerModule = await importFrom<MemosLoggerModule>(LOGGER_MODULE, baseUrl);

  const home = configModule.resolveHome(AGENT, memosHome());
  const loaded = await configModule.loadConfig(home, AGENT);
  // Only change the console entry; everything else (level, file rotation, timezone) keeps MemOS's own resolution.
  const quiet: MemosConfig = {
    ...loaded.config,
    logging: { ...loaded.config.logging, console: { ...loaded.config.logging.console, enabled: false } },
  };
  loggerModule.initLogger(quiet, home);
  return "MemOS console logging is off; its logs stay in the plugin's own logs/";
}

/** Whether the user explicitly asked to keep MemOS console logging. */
export function consoleRequested(): boolean {
  return process.env["CHOPIN_MEMOS_CONSOLE"] === "1";
}
