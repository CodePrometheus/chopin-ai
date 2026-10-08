import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { InvestigationRequest } from "./types.js";

/**
 * Common contract for source adapters. Where the data lives does not matter; every source
 * answers only two questions: is it reachable right now (available), and what is new (poll).
 * poll yields a uniform InvestigationRequest, so everything downstream is source-agnostic.
 * Adapters do no deduplication or ordering themselves: that is the triage orchestration's
 * job (separation of concerns).
 */
export interface SourceAdapter {
  /** Source instance name, e.g. "github:my-org/my-product". */
  name: string;
  /** Up-front availability check, modeled on toolset prerequisites: unavailable means an explicit skip, never a silent failure. */
  available(): Promise<boolean>;
  /** Fetch the current signals (a full snapshot; cross-round deduplication is done centrally by SeenStore). */
  poll(): Promise<InvestigationRequest[]>;
}

/**
 * Cross-round deduplication: records the signal keys seen so far (source + stable ref)
 * so triage only enqueues new ones. File-backed; enough for one machine, one process.
 */
export class SeenStore {
  private seen: Set<string> | undefined;

  constructor(private readonly filePath: string) {}

  private async load(): Promise<Set<string>> {
    if (this.seen) return this.seen;
    try {
      this.seen = new Set(JSON.parse(await readFile(this.filePath, "utf8")) as string[]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.seen = new Set();
    }
    return this.seen;
  }

  async has(key: string): Promise<boolean> {
    return (await this.load()).has(key);
  }

  async markAll(keys: string[]): Promise<void> {
    const seen = await this.load();
    for (const key of keys) seen.add(key);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify([...seen], null, 2), "utf8");
  }
}

export interface TriageOutcome {
  /** New (unseen) signals, in the order each source returned them. */
  fresh: InvestigationRequest[];
  /** Status of every source this round, with the reason for a skip: unavailable must be said out loud, never silent. */
  sources: Array<{ name: string; status: "ok" | "unavailable" | "error"; detail?: string; count: number }>;
}

/** Signal key: the same issue/cluster is enqueued only once across rounds. */
export function signalKey(request: InvestigationRequest): string {
  return `${request.source.kind}:${request.source.ref}`;
}

/** Triage orchestration: poll every source concurrently, deduplicate centrally, aggregate status. */
export async function runTriage(adapters: SourceAdapter[], seenStore: SeenStore): Promise<TriageOutcome> {
  const fresh: InvestigationRequest[] = [];
  const sources: TriageOutcome["sources"] = [];

  const polls = adapters.map(async (adapter) => {
    if (!(await adapter.available())) {
      return { name: adapter.name, status: "unavailable" as const, requests: [] as InvestigationRequest[] };
    }
    try {
      return { name: adapter.name, status: "ok" as const, requests: await adapter.poll() };
    } catch (err) {
      return {
        name: adapter.name,
        status: "error" as const,
        detail: (err as Error).message,
        requests: [] as InvestigationRequest[],
      };
    }
  });

  for (const outcome of await Promise.all(polls)) {
    let count = 0;
    for (const request of outcome.requests) {
      if (await seenStore.has(signalKey(request))) continue;
      fresh.push(request);
      count += 1;
    }
    sources.push({ name: outcome.name, status: outcome.status, detail: outcome.detail, count });
  }
  return { fresh, sources };
}
