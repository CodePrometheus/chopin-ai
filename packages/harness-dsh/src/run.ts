import { chopinMeta, parseTranscript, withChopinMeta, type TaskRun, type TranscriptEntry } from "@chopin-ai/core";
import { diff, run, snapshot, type Workspace } from "@chopin-ai/workspace";

export interface DshTaskOptions {
  /** A profile, inside the workspace, that mounts this plugin. */
  profile: string;
  /** The `transcripts` directory that profile's plugin writes to, inside the workspace. */
  transcripts: string;
}

/**
 * Runs one prompt headless with the harness inside the workspace, where it keeps its agent, and returns the run
 * as the plugin recorded it in ACP, with what it changed in the workspace.
 */
export async function runTask(workspace: Workspace, prompt: string, options: DshTaskOptions): Promise<TaskRun> {
  await workspace.start();
  const base = await snapshot(workspace);
  const result = await run(workspace, ["dsh", "--profile", options.profile, "--json"], { input: prompt });
  const session = result.stdout.split("\n").map(event)
    .find((e): e is { sessionId: string } => e?.type === "session" && typeof e.sessionId === "string");
  if (session === undefined) throw new Error(`dsh did not start a session (exit ${result.exitCode}): ${result.stderr.trim()}`);
  const recorded = await run(workspace, ["cat", `${options.transcripts}/${session.sessionId}.jsonl`]);
  // A finished run without a transcript means the profile does not record; an unfinished one may have stopped first.
  if (recorded.exitCode !== 0 && result.exitCode === 0) {
    throw new Error(`no transcript for ${session.sessionId}: ${recorded.stderr.trim()}`);
  }
  const transcript = recorded.exitCode === 0 ? parseTranscript(recorded.stdout) : [];
  if (result.exitCode !== 0) failed(transcript, session.sessionId, `dsh exited with ${result.exitCode}: ${result.stderr.trim()}`);
  return { transcript, diff: base === undefined ? undefined : await diff(workspace, base) };
}

/** Marks a run the harness did not finish: on its last turn end, or on one added when it recorded none. */
function failed(transcript: TranscriptEntry[], sessionId: string, error: string): void {
  const last = transcript.at(-1);
  if (last !== undefined && "turnEnd" in last) {
    const meta = chopinMeta(last.turnEnd);
    if (meta?.error === undefined) last.turnEnd = withChopinMeta(last.turnEnd, { ...meta, error });
    return;
  }
  transcript.push({ at: new Date().toISOString(), sessionId, turnEnd: withChopinMeta({ stopReason: "end_turn" }, { error }) });
}

/** One line of the harness's JSON output; anything else it printed is not an event. */
function event(line: string): { type?: unknown; sessionId?: string } | undefined {
  try {
    return JSON.parse(line) as { type?: unknown; sessionId?: string };
  } catch {
    return undefined;
  }
}
