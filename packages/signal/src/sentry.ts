import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SourceAdapter } from "./adapter.js";
import { newRequestId } from "./manual.js";

const execFileAsync = promisify(execFile);

/**
 * Sentry source adapter: goes through the local sentry-cli (reusing its configured auth)
 * to list unresolved issues. Only issues whose event count clears the threshold are
 * enqueued. Sentry already clusters by error, so there is no second clustering here, only
 * threshold filtering.
 */

export interface SentrySourceOptions {
  org: string;
  project: string;
  /** Minimum event count; anything below is not enqueued. */
  minEvents: number;
  maxRows?: number;
}

/** Parse sentry-cli's ASCII table output (| separated). */
function parseTable(stdout: string): Array<Record<string, string>> {
  const rows = stdout
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.startsWith("|"))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
    .filter((cells) => cells.some(Boolean));
  if (rows.length < 2) return [];
  const headers = rows[0];
  if (!headers) return [];
  const records: Array<Record<string, string>> = [];
  for (const row of rows.slice(1)) {
    if (row.every((c) => /^-+$/.test(c))) continue;
    const record: Record<string, string> = {};
    headers.forEach((h, i) => {
      record[h.toLowerCase()] = row[i] ?? "";
    });
    records.push(record);
  }
  return records;
}

export function createSentryAdapter(options: SentrySourceOptions): SourceAdapter {
  return {
    name: `sentry:${options.org}/${options.project}`,
    available: async () => {
      try {
        await execFileAsync("sentry-cli", ["--version"], { timeout: 10_000 });
        return true;
      } catch {
        return false;
      }
    },
    poll: async () => {
      const { stdout } = await execFileAsync(
        "sentry-cli",
        [
          "issues", "list",
          "-o", options.org,
          "-p", options.project,
          "--query", "is:unresolved",
          "--max-rows", String(options.maxRows ?? 50),
        ],
        { maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
      );
      const records = parseTable(stdout);
      return records
        .filter((r) => Number(r["events"] ?? 0) >= options.minEvents)
        .map((r) => {
          const id = r["id"] ?? r["short id"] ?? "(unknown)";
          const title = r["title"] ?? "";
          return {
            id: newRequestId(`sentry-${id}`),
            source: { kind: "sentry" as const, ref: `${options.project}:${id}` },
            errorString: title,
            symptom: `Sentry ${options.project} ${id}: ${title} (events=${r["events"] ?? "?"}, users=${r["users"] ?? "?"})`,
            evidencePointers: [`sentry-issue: ${options.org}/${options.project}/${id}`],
            createdAt: new Date().toISOString(),
          };
        });
    },
  };
}
