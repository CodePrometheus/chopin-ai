/**
 * The round report: the only thing that crosses from one round's worker to the next. It is
 * bounded so a handoff stays small; an oversized report is refused, never truncated.
 *
 * @module @chopin/team/report
 */

import type { RoundReport } from "./types.js";

export const REPORT_LIMITS = {
  summaryChars: 2_000,
  itemChars: 500,
  items: 12,
  blockerChars: 2_000,
  checks: 50,
} as const;

export class InvalidReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReportError";
  }
}

const STATUSES = new Set(["continue", "complete", "blocked", "needs-decision"]);
const KEYS = new Set(["status", "summary", "evidence", "nextSteps", "blocker", "checks"]);

function fail(message: string): never {
  throw new InvalidReportError(message);
}

function text(value: unknown, what: string, limit: number): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${what} must be a non-empty string`);
  if (value.length > limit) fail(`${what} has ${value.length} characters; the limit is ${limit}`);
  return value;
}

function items(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) fail(`${what} must be an array of strings`);
  if (value.length > REPORT_LIMITS.items) fail(`${what} has ${value.length} items; the limit is ${REPORT_LIMITS.items}`);
  return value.map((item, index) => text(item, `${what}[${index}]`, REPORT_LIMITS.itemChars));
}

/** Validate a report as submitted; `blocked` and `needs-decision` must say what stands in the way. */
export function assertReport(value: unknown, what = "report"): asserts value is RoundReport {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${what} must be an object`);
  const report = value as Record<string, unknown>;
  for (const key of Object.keys(report)) if (!KEYS.has(key)) fail(`${what} has unknown field ${key}`);
  if (!STATUSES.has(report.status as string)) fail(`${what}.status must be continue, complete, blocked or needs-decision`);
  text(report.summary, `${what}.summary`, REPORT_LIMITS.summaryChars);
  items(report.evidence, `${what}.evidence`);
  items(report.nextSteps, `${what}.nextSteps`);
  if (report.blocker !== undefined) text(report.blocker, `${what}.blocker`, REPORT_LIMITS.blockerChars);
  if ((report.status === "blocked" || report.status === "needs-decision") && report.blocker === undefined) {
    fail(`${what}.blocker must say what stands in the way when the status is ${String(report.status)}`);
  }
  if (report.checks !== undefined) {
    if (!Array.isArray(report.checks) || report.checks.length === 0) fail(`${what}.checks must be a non-empty array when present`);
    if (report.checks.length > REPORT_LIMITS.checks) fail(`${what}.checks has ${report.checks.length} entries; the limit is ${REPORT_LIMITS.checks}`);
    report.checks.forEach((entry: unknown, index: number) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail(`${what}.checks[${index}] must be an object`);
      const check = entry as Record<string, unknown>;
      text(check.forTaskId, `${what}.checks[${index}].forTaskId`, 128);
      const path = text(check.path, `${what}.checks[${index}].path`, 500);
      if (path.startsWith("/") || path.split("/").includes("..")) fail(`${what}.checks[${index}].path must be repository-relative`);
    });
  }
}
