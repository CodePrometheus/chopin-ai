import type { SourceAdapter } from "./adapter.js";
import { clusterErrorLines } from "./loki-cluster.js";
import type { ErrorLine } from "./loki-cluster.js";
import { newRequestId } from "./manual.js";

/**
 * Loki source adapter: query_range pulls error lines -> deterministic clustering and
 * scoring -> only clusters above the threshold become investigation requests. The LLM
 * never sees the raw log stream. Transport is the standard Loki HTTP API; when the
 * internal network is unreachable (no port-forward) available() returns false and triage
 * marks the source unavailable explicitly rather than silently.
 */

export interface LokiSourceOptions {
  /**
   * Loki API base URL. Either transport works:
   * - direct (port-forward): http://127.0.0.1:3100
   * - Grafana datasource proxy (reachable from outside, recommended):
   *   https://<your-grafana>/api/datasources/proxy/uid/<loki-datasource-uid>
   *   with Authorization: Bearer <grafana token> in headers
   */
  url: string;
  /** LogQL query; it should already filter down to error lines server-side. */
  query: string;
  /** Fetch window in minutes. */
  windowMinutes: number;
  /** Field name holding the user id in the log line JSON (optional; used for reach scoring). */
  userField?: string;
  /** Minimum cluster score; anything below is not enqueued. */
  minScore: number;
  headers?: Record<string, string>;
}

interface LokiStream {
  values: Array<[string, string]>;
}

function parseUser(line: string, userField: string | undefined): string | undefined {
  if (!userField) return undefined;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const v = obj[userField];
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

export function createLokiAdapter(options: LokiSourceOptions): SourceAdapter {
  const base = options.url.replace(/\/$/, "");
  return {
    name: `loki:${options.query.slice(0, 40)}`,
    available: async () => {
      // Probe via the labels endpoint: it exists on both direct and Grafana proxy transports (/ready is direct-only)
      try {
        const res = await fetch(`${base}/loki/api/v1/labels?limit=1`, {
          headers: options.headers,
          signal: AbortSignal.timeout(5000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    poll: async () => {
      const end = Date.now();
      const start = end - options.windowMinutes * 60_000;
      const params = new URLSearchParams({
        query: options.query,
        start: String(start * 1e6),
        end: String(end * 1e6),
        limit: "5000",
      });
      const res = await fetch(`${base}/loki/api/v1/query_range?${params}`, {
        headers: options.headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`loki query failed: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { data?: { result?: LokiStream[] } };

      const lines: ErrorLine[] = [];
      for (const stream of body.data?.result ?? []) {
        for (const [ns, text] of stream.values) {
          lines.push({
            message: text,
            timestamp: new Date(Number(ns) / 1e6).toISOString(),
            userId: parseUser(text, options.userField),
          });
        }
      }

      return clusterErrorLines(lines)
        .filter((c) => c.score >= options.minScore)
        .map((c) => ({
          id: newRequestId("loki"),
          // ref is the normalized key: the same defect's cluster keeps the same ref across rounds, so SeenStore can dedupe it
          source: { kind: "loki" as const, ref: c.key },
          errorString: c.sample,
          symptom: `Loki cluster: ${c.count} hits / ${c.users} users, trend ${c.trend.toFixed(1)}\n${c.sample}`,
          evidencePointers: [`loki-query: ${options.query}`],
          timeWindow: { from: c.firstSeen, to: c.lastSeen },
          createdAt: new Date().toISOString(),
        }));
    },
  };
}
