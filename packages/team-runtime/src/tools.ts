/**
 * The two tools a team worker ends its rounds with. They are registered per worker session
 * by the host, so they know the task they serve; their verdicts come from the same gate the
 * host applies before delivering, and their results land in the session log the host reads.
 *
 * @module @chopin/team-runtime/tools
 */

import { CHECK_TOOL, REPORT_LIMITS, REPORT_TOOL, assertReport } from "@chopin/team";
import type { RoundGate } from "@chopin/team";
import { treeDigest } from "@chopin/team/git";
import type { ToolDefinition, ToolGuard } from "@deepseek-ai/dsh-tools";

import { roundSignals } from "./signals.js";
import type { CheckMeta, LoggedEvent } from "./signals.js";

type JsonValue = Parameters<ToolDefinition["output"]["render"]>[1];

export interface CommandRun {
  exitCode: number | null;
  output: string;
}

export interface TeamToolOptions {
  /** The slot the worker runs in. */
  cwd: string;
  gate: RoundGate;
  /** Run one configured check inside the worker's sandbox. */
  runCheck(command: string, signal: AbortSignal): Promise<CommandRun>;
  /** The worker session's log so far. */
  events(): readonly LoggedEvent[];
}

interface CheckValue extends CheckMeta {
  results: { command: string; exitCode: number | null; output: string }[];
}

const OUTPUT_TAIL = 4_000;

function tail(text: string): string {
  return text.length <= OUTPUT_TAIL ? text : `...${text.slice(-OUTPUT_TAIL)}`;
}

const STRING_LIST = (maxLength: number) => ({ type: "array", maxItems: REPORT_LIMITS.items, items: { type: "string", minLength: 1, maxLength } });

export function checkTool(options: TeamToolOptions): ToolDefinition {
  return {
    name: CHECK_TOOL,
    description: "Run the project's configured checks for the files changed so far, inside this workspace. Completion requires its last passing run to be on exactly the tree you leave.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: { type: "object" },
      render: (_args, value) => {
        const check = value as unknown as CheckValue;
        if (check.commands.length === 0) return [{ type: "text", text: "No configured check covers the current changes." }];
        return [{ type: "text", text: [`${check.passed ? "Passed" : "Failed"}.`, ...check.results.map((result) =>
          `$ ${result.command}\n[exit ${String(result.exitCode)}]\n${result.output}`)].join("\n\n") }];
      },
      presentationMeta: (_args, value) => {
        const check = value as unknown as CheckValue;
        return { passed: check.passed, tree: check.tree, commands: check.commands };
      },
    },
    async execute(_args, exec) {
      const commands = await options.gate.checkCommands();
      const results: CheckValue["results"] = [];
      for (const command of commands) {
        const run = await options.runCheck(command, exec.signal);
        results.push({ command, exitCode: run.exitCode, output: tail(run.output) });
        if (run.exitCode !== 0) break;
      }
      const passed = results.length === commands.length && results.every((result) => result.exitCode === 0);
      const value: CheckValue = { passed, tree: await treeDigest(options.cwd), commands, results };
      return value as unknown as JsonValue;
    },
  };
}

export function reportTool(options: TeamToolOptions): ToolDefinition {
  return {
    name: REPORT_TOOL,
    description: [
      "End this round with a structured report for the next round, the lead and the host.",
      "complete: the objective holds; the host verifies it before it commits anything.",
      "continue: hand the remaining work to a fresh worker; say exactly what remains in nextSteps.",
      "blocked / needs-decision: only a person can unblock it; say what in blocker.",
    ].join(" "),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["status", "summary", "evidence", "nextSteps"],
      properties: {
        status: { type: "string", enum: ["continue", "complete", "blocked", "needs-decision"] },
        summary: { type: "string", minLength: 1, maxLength: REPORT_LIMITS.summaryChars },
        evidence: { ...STRING_LIST(REPORT_LIMITS.itemChars), description: "What was verified and how: commands, files, observed results." },
        nextSteps: STRING_LIST(REPORT_LIMITS.itemChars),
        blocker: { type: "string", minLength: 1, maxLength: REPORT_LIMITS.blockerChars },
        checks: {
          type: "array", maxItems: REPORT_LIMITS.checks,
          description: "Acceptance tasks only: which check file gates which task.",
          items: {
            type: "object", additionalProperties: false, required: ["forTaskId", "path"],
            properties: { forTaskId: { type: "string", minLength: 1 }, path: { type: "string", minLength: 1 } },
          },
        },
      },
    },
    output: {
      schema: { type: "object" },
      render: () => [{ type: "text", text: "Report recorded. This round is over." }],
    },
    async execute(args, exec) {
      assertReport(args);
      if (args.status === "complete") {
        const refusal = await options.gate.refusal(args, roundSignals(options.events()).passingCheck);
        if (refusal !== undefined) throw new Error(`Completion refused: ${refusal.detail}. Fix it, or report another status.`);
      }
      exec.concludeTurn();
      return { recorded: true };
    },
  };
}

/** Matches `prefix*` patterns or exact names. */
function matches(name: string, pattern: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

/** Deny tools that belong to the lead's session, such as curation and evolution submissions. */
export function leadOnlyGuard(patterns: readonly string[]): ToolGuard {
  return (execution) => patterns.some((pattern) => matches(execution.name, pattern))
    ? `${execution.name} belongs to the lead's session in team mode; record what you found in ${REPORT_TOOL} instead.`
    : undefined;
}
