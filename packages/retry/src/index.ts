/**
 * Automatically retry known transient tool failures.
 *
 * Some tool failures have nothing to do with the call itself: process spawn failures,
 * search tool launch failures. Rerunning once usually fixes them, but unattended they
 * get read as the command really failing and shift the judgment -- "check did not
 * pass" becomes a conclusion, or a perfectly viable path gets bypassed.
 *
 * There is no point in every session discovering this on its own, so it is handled
 * once at the tool layer.
 *
 * The retry count is deliberately tiny: a transient failure usually recovers on the
 * first retry, while repeated retries delay the exposure of a real failure several-fold.
 *
 * @module @chopin/retry
 */

import type { Context } from "@deepseek-ai/cordis";
// Imported so the tools/pre-execute event declaration enters the type system: that package registers it via module augmentation
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";

import { isTransient } from "./transient.js";

export const name = "chopin-retry";

/** Attempt cap. A transient failure recovers on one retry; more only delays exposing a real failure */
const MAX_ATTEMPTS = 2;

/** Gap between attempts, giving resources like file descriptors a moment to be reclaimed */
const BACKOFF_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Pull the error text out of a tool result; failure shapes differ per tool, and nothing found means no error */
function errorText(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as Record<string, unknown>;
  if (record.isError !== true) return undefined;
  const content = record.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((block) => (typeof block === "object" && block !== null
      ? String((block as Record<string, unknown>).text ?? "")
      : ""))
    .join("");
}

export function apply(ctx: Context): void {
  ctx.on("tools/pre-execute", async (_exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
    let outcome: PreToolDecision = await next();

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const message = errorText(outcome);
      if (message === undefined || !isTransient(message)) return outcome;

      ctx.logger.info(`retry: transient tool failure, attempt ${attempt + 1}/${MAX_ATTEMPTS}`);
      await sleep(BACKOFF_MS);
      outcome = await next();
    }

    return outcome;
  });
}

export { isTransient } from "./transient.js";
