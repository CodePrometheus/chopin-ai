/**
 * Configured commands run through the host's shell seam, confined by its sandbox: checks
 * execute code workers wrote, so they never run with more than the slot writable.
 *
 * @module @chopin/team-runtime/commands
 */

import type { Context } from "@deepseek-ai/cordis";
import type { CommandPort, CommandResult } from "@chopin/team";
import type {} from "@deepseek-ai/dsh-shell";
import type { SessionId } from "@deepseek-ai/dsh-session";

/** Run `command` in `cwd`; it may write only under `writableRoot`, or nowhere when that is omitted. */
export async function runConfined(ctx: Context, command: string, options: {
  cwd: string; writableRoot?: string; signal: AbortSignal; sessionId?: SessionId;
}): Promise<CommandResult> {
  const sandboxPolicy = options.writableRoot === undefined
    ? { mode: "read-only" as const, workspaceRoot: options.cwd }
    : { mode: "workspace-write" as const, workspaceRoot: options.writableRoot };
  const execution = await ctx.shell.execute(ctx.shell.resolve({
    command, workdir: options.cwd, onExpiry: "none", signal: options.signal,
    sandboxPolicy: { ...sandboxPolicy, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) },
  }));
  const result = await execution.result();
  return { exitCode: result.exitCode, output: `${result.stdout.text}${result.stderr.text}` };
}

export class ShellCommandPort implements CommandPort {
  constructor(private readonly ctx: Context) {}

  run(command: string, options: { cwd: string; writableRoot?: string; signal: AbortSignal }): Promise<CommandResult> {
    return runConfined(this.ctx, command, options);
  }
}
