/**
 * `node --import` preload entry: turns off MemOS console logging before the dsh main
 * module starts running.
 *
 * Why it has to be a preload: as an ordinary cordis plugin our module does start
 * executing first, but the moment `await import(...)` yields the event loop, MemOS
 * runs `core.init()` in that gap and prints seven or eight startup lines -- in
 * practice we win one time and lose the next. `node --import` waits for this
 * module's top-level await to finish before running the main module, which removes
 * the race entirely.
 *
 * The profile directory comes from `chopin` via `CHOPIN_PROFILE_DIR`; without it we
 * do nothing and leave the plugin entry to make a best-effort pass.
 *
 * @module @chopin/memos-quiet/preload
 */

import { OUTCOME_KEY, anchorFor, consoleRequested, silenceMemosConsole } from "./silence.js";

const outcome: string | undefined = await (async () => {
  if (consoleRequested()) return "left MemOS console logging on (CHOPIN_MEMOS_CONSOLE=1)";
  const profileDir = process.env["CHOPIN_PROFILE_DIR"]?.trim();
  if (profileDir === undefined || profileDir === "") return undefined;
  try {
    return await silenceMemosConsole(anchorFor(profileDir));
  } catch (error) {
    return `could not silence MemOS logging (${String(error)}); the terminal may be noisy`;
  }
})();

if (outcome !== undefined) {
  (globalThis as Record<symbol, unknown>)[OUTCOME_KEY] = outcome;
}
