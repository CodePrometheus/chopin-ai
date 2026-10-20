import { stripVTControlCharacters } from "node:util";
import type { Context } from "@earendil-works/chord";
import { OutputBuffer, Progress, utf8ByteLength } from "@earendil-works/chord/output";
import type { UserMessage } from "@earendil-works/pi-ai";
import { defineEntry, type EntryDraft } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** A command the user ran in a conversation, and what came of it. */
export type ShellRun = {
  command: string;
  /** The tail of its output, as much as the agent's own shell tool keeps. */
  output: string;
  /** Absent when it was stopped. */
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
  /** The whole output, when there was more than is kept. */
  fullOutputPath?: string;
  /** Whether the model is kept from seeing it. */
  excluded: boolean;
};

/** A command the user ran, as the transcript keeps it. */
export const ShellEntry = defineEntry<ShellRun>("chopin.shell");

/**
 * The entry a run is written as: the model reads it as the user's message unless it is excluded, and an excluded one,
 * changing nothing the model sees, is written even while the agent works.
 */
export function shellEntry(run: ShellRun): EntryDraft {
  const told: UserMessage = { role: "user", content: shellText(run), timestamp: Date.now() };
  return { kind: ShellEntry.kind, data: run, ...(!run.excluded && { model: [told] }) };
}

/** What the model reads of a run, worded as the coding agent words it. */
export function shellText(run: ShellRun): string {
  const ended = run.cancelled
    ? "\n\n(command cancelled)"
    : run.exitCode !== undefined && run.exitCode !== 0 ? `\n\nCommand exited with code ${run.exitCode}` : "";
  const whole = run.truncated && run.fullOutputPath !== undefined ? `\n\n[Output truncated. Full output: ${run.fullOutputPath}]` : "";
  return `Ran \`${run.command}\`\n${run.output === "" ? "(no output)" : `\`\`\`\n${run.output}\n\`\`\``}${ended}${whole}`;
}

/** As much output as the agent's own shell tool keeps, from the end. */
const KEPT = { maxBytes: 50 * 1024, maxLines: 2_000, retain: "tail" } as const;

/** How often the output so far is told while a command runs. */
const PROGRESS_MS = 100;

/**
 * Runs `command` through `env`'s shell, telling `onOutput` the kept output as it grows, one telling at a time. A command
 * stopped through `context` ends as cancelled; one that cannot run throws.
 */
export async function runShell(
  env: ExecutionEnv,
  command: string,
  onOutput: (kept: string) => Promise<unknown>,
  context: Context,
): Promise<Omit<ShellRun, "command" | "excluded">> {
  const kept = new OutputBuffer(KEPT);
  // Every telling has landed by the time the run ends.
  const progress = new Progress(async () => {
    const { text } = kept.snapshot();
    await onOutput(text);
    return utf8ByteLength(text);
  }, () => {}, PROGRESS_MS);
  const result = await env.exec(command, {
    // Colors and cursor moves would be marks in what is kept; the text they decorate is what the user reads.
    onOutput: (text) => void (kept.push(stripVTControlCharacters(text)) && progress.mark()),
    spill: { afterBytes: KEPT.maxBytes, afterLines: KEPT.maxLines },
  }, context);
  await progress.stop();
  kept.end();
  if (!result.ok && result.error.code !== "aborted") throw result.error;
  const { text, droppedBytes, droppedLines } = kept.snapshot();
  const spillPath = result.ok ? result.value.spillPath : result.error.spillPath;
  return {
    output: text.endsWith("\n") ? text.slice(0, -1) : text,
    ...(result.ok && { exitCode: result.value.exitCode }),
    cancelled: !result.ok,
    truncated: droppedBytes > 0 || droppedLines > 0,
    ...(spillPath !== undefined && { fullOutputPath: spillPath }),
  };
}
