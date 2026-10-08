/**
 * Reports the mute state of MemOS console logging; makes a second pass when the
 * preload did not run.
 *
 * The normal path is `chopin` starting dsh with `node --import @chopin/memos-quiet/preload`,
 * so muting finishes before the main module and this only reports the outcome. Starting
 * via `dsh --profile` directly skips that preload, so we make a pass now using
 * `ctx.baseUrl` -- that path may lose the race against MemOS's startup logs, so it is
 * best effort.
 *
 * @module @chopin/memos-quiet
 */

import type { Context } from "@deepseek-ai/cordis";

import { OUTCOME_KEY, consoleRequested, silenceMemosConsole } from "./silence.js";

export const name = "chopin-memos-quiet";

export async function apply(ctx: Context): Promise<void> {
  const done = (globalThis as Record<symbol, unknown>)[OUTCOME_KEY];
  if (typeof done === "string") {
    ctx.logger.info(`memos-quiet: ${done}`);
    return;
  }
  if (consoleRequested()) {
    ctx.logger.info("memos-quiet: left MemOS console logging on (CHOPIN_MEMOS_CONSOLE=1)");
    return;
  }
  try {
    ctx.logger.info(`memos-quiet: ${await silenceMemosConsole((ctx as { baseUrl?: string }).baseUrl)}`);
  } catch (error) {
    ctx.logger.warn(`memos-quiet: could not silence MemOS logging (${String(error)}); the terminal may be noisy`);
  }
}
