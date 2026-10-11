/**
 * What one worker round left in its session log, read deterministically: the report it
 * submitted, what it spent, the approvals refused for it and its last passing check. Only
 * calls that completed successfully count; nothing the model says about itself does.
 *
 * @module @chopin/team-runtime/signals
 */

import { assertReport, CHECK_TOOL, REPORT_TOOL } from "@chopin/team";
import type { CheckRun, RoundReport, RoundUsage } from "@chopin/team";

/** The fields of a session event this module reads; the log's own type is wider. */
export interface LoggedEvent {
  type: string;
  data: unknown;
}

export interface RoundSignals {
  report?: RoundReport;
  usage: RoundUsage;
  deniedApprovals: string[];
  passingCheck?: CheckRun;
}

/** What `team_check` records on its result for the host to read back. */
export interface CheckMeta {
  passed: boolean;
  tree: string;
  commands: string[];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function checkMeta(value: unknown): CheckMeta | undefined {
  const meta = record(value);
  if (typeof meta.passed !== "boolean" || typeof meta.tree !== "string" || !Array.isArray(meta.commands)
    || meta.commands.some((command) => typeof command !== "string")) return undefined;
  return { passed: meta.passed, tree: meta.tree, commands: meta.commands as string[] };
}

export function roundSignals(events: readonly LoggedEvent[]): RoundSignals {
  const usage: RoundUsage = { requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  const calls = new Map<string, { name: string; arguments: string }>();
  const asked = new Map<string, string>();
  const deniedApprovals: string[] = [];
  let report: RoundReport | undefined;
  let passingCheck: CheckRun | undefined;
  for (const event of events) {
    const data = record(event.data);
    switch (event.type) {
      case "assistant/attempt":
        usage.requests += 1;
        break;
      case "assistant/message": {
        usage.requests += 1;
        const tokens = record(data.usage);
        usage.inputTokens += count(tokens.inputTokens);
        usage.outputTokens += count(tokens.outputTokens);
        usage.cacheReadTokens += count(tokens.cacheReadTokens);
        usage.cacheWriteTokens += count(tokens.cacheWriteTokens);
        break;
      }
      case "tool/call":
        if (typeof data.callId === "string" && typeof data.name === "string" && typeof data.arguments === "string") {
          calls.set(data.callId, { name: data.name, arguments: data.arguments });
        }
        break;
      case "tool/result": {
        const message = record(data.message);
        const call = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
        if (call === undefined || message.isError !== false) break;
        if (call.name === REPORT_TOOL) {
          try {
            const value: unknown = JSON.parse(call.arguments);
            assertReport(value);
            report = value;
          } catch {
            // A call the tool accepted always parses; anything else is not a report.
          }
        } else if (call.name === CHECK_TOOL) {
          const meta = checkMeta(data.meta);
          if (meta?.passed === true) passingCheck = { tree: meta.tree, commands: meta.commands };
        }
        break;
      }
      case "approval/asked":
        if (typeof data.id === "string" && typeof data.toolName === "string") asked.set(data.id, data.toolName);
        break;
      case "approval/decided":
        if (typeof data.id === "string" && (data.outcome === "rejected" || data.outcome === "unavailable")) {
          const tool = asked.get(data.id);
          if (tool !== undefined) deniedApprovals.push(tool);
        }
        break;
    }
  }
  return { ...(report === undefined ? {} : { report }), usage, deniedApprovals, ...(passingCheck === undefined ? {} : { passingCheck }) };
}
