/**
 * Evidence tools plugin. Lives in the agent plane: declared in each mission's preset.
 *
 * @module @chopin/evidence
 */

import type { Context } from "@deepseek-ai/cordis";
import { evidenceTools } from "./tools.js";

export { evidenceTools } from "./tools.js";
export { downloadAndExtract, bundleCacheDir } from "./bundle.js";
export type { BundlePaths } from "./bundle.js";
export { getRun, getSystemPrompt, listRuns, reconstructHistory } from "./trace.js";
export type { RunDetail, TraceRunSummary } from "./trace.js";

export const name = "chopin-evidence";
export const inject = ["tools"];

export function apply(ctx: Context): void {
  for (const tool of evidenceTools()) ctx.tools.register(tool);
}
