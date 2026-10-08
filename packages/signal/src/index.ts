/**
 * Triage service (`ctx.chopinSignals`).
 *
 * Triage involves no LLM at all: poll every source concurrently, cluster by normalized
 * error string, rank by occurrence and reach, and only what clears the bar is worth an
 * investigation. Hundreds of thousands of log lines carry too little value per line;
 * having a model read them is paying for noise.
 *
 * The SeenStore that deduplicates across rounds is cross-session state, which is why this
 * is a host-layer service: if two sessions each kept their own "what have I seen", the same
 * signal would be investigated twice.
 *
 * There is deliberately no queue. The queue came from the old architecture, where the
 * triage process and the investigation process were separate; now both live in the same
 * session, the model can start investigating a new signal right away, and a store in
 * between is just one more place for state to drift.
 *
 * @module @chopin/signal
 */

import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { SeenStore, runTriage, signalKey } from "./adapter.js";
import type { SourceAdapter, TriageOutcome } from "./adapter.js";
import { buildAdapters, loadSourceConfigs } from "./sources-config.js";

export { SeenStore, runTriage, signalKey } from "./adapter.js";
export type { SourceAdapter, TriageOutcome } from "./adapter.js";
export { buildAdapters, loadSourceConfigs } from "./sources-config.js";
export type { SourceConfig } from "./sources-config.js";
export type { InvestigationRequest } from "./types.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    chopinSignals: ChopinSignals;
  }
}

export interface Config {
  /** Path to the source list YAML. */
  sourcesFile: string;
  /** Where the cross-round deduplication record is persisted. */
  seenFile: string;
}

export const Config: z<Config> = z.object({
  sourcesFile: z.string().required(),
  seenFile: z.string().required(),
});

export class ChopinSignals extends Service {
  private adapters: SourceAdapter[] | undefined;

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, "chopinSignals");
  }

  /** The source list is read on the first triage, not at plugin load, so a config change needs no restart. */
  private async resolveAdapters(): Promise<SourceAdapter[]> {
    if (this.adapters !== undefined) return this.adapters;
    // The path usually comes from an env var expression and is empty when unset: that means
    // "no sources configured", not "an empty file was configured". Triage still runs, with no sources.
    if (this.config.sourcesFile.trim() === "") {
      this.ctx.logger.warn("no signal source file configured; triage has nothing to poll");
      this.adapters = [];
      return this.adapters;
    }
    this.adapters = buildAdapters(await loadSourceConfigs(this.config.sourcesFile));
    return this.adapters;
  }

  /**
   * Run one triage round. New signals are marked seen before returning: better to miss one
   * than to report the same signal repeatedly, since a repeated "new signal" destroys all
   * trust in this list.
   */
  async runOnce(): Promise<TriageOutcome> {
    const seen = new SeenStore(this.config.seenFile);
    const outcome = await runTriage(await this.resolveAdapters(), seen);
    if (outcome.fresh.length > 0) await seen.markAll(outcome.fresh.map(signalKey));
    return outcome;
  }
}

// The cordis loader resolves Service-class plugins by default export; this one is the framework contract.
export default ChopinSignals;
