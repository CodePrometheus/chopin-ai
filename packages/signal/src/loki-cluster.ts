import { normalizeErrorString } from "@chopin/ledger/normalize";

/**
 * Deterministic triage core for log-source signals: cluster raw error lines by normalized
 * key and score them by volume, trend and user reach. The LLM never touches raw logs (too
 * little value per line); the model only sees the few clusters this module selects.
 */

export interface ErrorLine {
  message: string;
  timestamp: string;
  userId?: string;
}

export interface ErrorCluster {
  key: string;
  sample: string;
  count: number;
  users: number;
  firstSeen: string;
  lastSeen: string;
  /** Ratio of occurrences in the second half of the window to the first half. */
  trend: number;
  score: number;
}

export function clusterErrorLines(lines: ErrorLine[]): ErrorCluster[] {
  const byKey = new Map<string, { sample: string; times: string[]; users: Set<string> }>();
  for (const line of lines) {
    const { key } = normalizeErrorString(line.message);
    let entry = byKey.get(key);
    if (!entry) {
      entry = { sample: line.message, times: [], users: new Set() };
      byKey.set(key, entry);
    }
    entry.times.push(line.timestamp);
    if (line.userId) entry.users.add(line.userId);
  }

  const clusters: ErrorCluster[] = [];
  for (const [key, entry] of byKey) {
    entry.times.sort();
    const count = entry.times.length;
    const first = entry.times[0];
    const last = entry.times[count - 1];
    if (first === undefined || last === undefined) continue;
    const mid = new Date((Date.parse(first) + Date.parse(last)) / 2).toISOString();
    const recent = entry.times.filter((t) => t >= mid).length;
    const earlier = count - recent;
    const trend = earlier === 0 ? recent : recent / earlier;
    clusters.push({
      key,
      sample: entry.sample,
      count,
      users: entry.users.size,
      firstSeen: first,
      lastSeen: last,
      trend,
      // Affected users weigh most, then volume (log-damped), then growth trend.
      score: entry.users.size * 10 + Math.log2(count + 1) * 3 + Math.min(trend, 10),
    });
  }
  return clusters.sort((a, b) => b.score - a.score);
}
