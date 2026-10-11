/**
 * Notify when a turn ends, preferring the terminal multiplexer.
 *
 * Unattended operation assumes nobody is watching the terminal, but when dsh finishes
 * a turn it merely hands control back to the prompt -- without a sound. A person
 * either keeps watching or comes back every few minutes to peek.
 *
 * Two channels, ordered by how much they carry:
 *
 *   1. The multiplexer's agent event hook. It knows which pane and which workspace
 *      this is, can mark the pane and classify the session; a notification popped
 *      by us cannot. dsh is not on its built-in agent list, so we report proactively
 *      instead of waiting for it to detect us.
 *   2. System notification -- the fallback when not running inside the multiplexer.
 *
 * The terminal bell (BEL) rides along either way: the terminal handles it itself,
 * it bypasses the notification center, needs no permission, and is the only one that
 * never fails silently.
 *
 * Ring once only when the turn really ends, and only when it took longer than the
 * threshold -- after a turn that returns in seconds the person is still looking at the screen.
 * Sessions no person has spoken in, such as team workers, end their turns without a sound; a
 * team task that stops for a decision does make one.
 *
 * @module @chopin/notify
 */

import { execFile } from "node:child_process";
import { platform } from "node:process";
import type { Context } from "@deepseek-ai/cordis";
// Imported so the agent/status event declaration enters the type system: dsh-agent registers it via module augmentation
import type { Agent, AgentStatus } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-loop";
import type {} from "@chopin/team-runtime";

export const name = "chopin-notify";

/** Turns shorter than this get no notification: the person is most likely still watching */
const QUIET_BELOW_MS = 20_000;

/** Source name used when reporting to the multiplexer, distinct from its built-in agent names */
const SOURCE = "dsh";

/** Workspace name, to tell sessions apart when several are open at once */
export function workspaceLabel(cwd: string): string {
  return cwd.split("/").filter(Boolean).at(-1) ?? "chopin";
}

/** Round into a human-readable duration */
export function humanDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m${seconds % 60}s`;
}

/** Whether a person has typed into this session; only their turns are worth a sound. */
export function spokenByPerson(events: readonly { type: string; data: unknown }[]): boolean {
  return events.some((event) => event.type === "user/message" && (event.data as { source?: { kind?: string } }).source?.kind === "user");
}

/** Get the person's attention: the bell, then the multiplexer, or a system notification without one. */
export function alert(label: string, message: string): void {
  ring();
  feedMultiplexer(`${label}: ${message}`, (ok) => {
    // Fall back to the system notification only when the multiplexer is unavailable, so one event does not pop twice
    if (!ok && platform === "darwin") notifyDesktop(`chopin · ${label}`, message);
  });
}

/** Write a BEL. Bypasses the notification center, so permissions and host identity do not matter */
function ring(): void {
  process.stdout.write("\u0007");
}

/**
 * Send a system notification.
 *
 * Try the tool with its own bundle id first. The fallback is AppleScript, but its
 * notification belongs to the host app that runs it; called from a deep child process
 * it gets no GUI session identity, the exit code is still 0 and the notification
 * never shows -- a silent failure, observed to not deliver from an IDE-embedded
 * terminal. Hence it is only the fallback.
 */
function notifyDesktop(title: string, message: string): void {
  execFile("terminal-notifier", ["-title", title, "-message", message], (error) => {
    if (error === null) return;
    const escape = (s: string): string => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    execFile(
      "osascript",
      ["-e", `display notification "${escape(message)}" with title "${escape(title)}"`],
      () => undefined,
    );
  });
}

/**
 * Report to the terminal multiplexer; the callback receives whether the command succeeded.
 *
 * Exit code 0 does not guarantee delivery: the command still succeeds when not running
 * in a multiplexer pane. It is only used here to tell "no multiplexer at all" (command
 * not found) from "present".
 */
function feedMultiplexer(message: string, done: (ok: boolean) => void): void {
  const child = execFile("cmux", ["hooks", "feed", "--source", SOURCE], (error) => {
    done(error === null);
  });
  child.stdin?.end(JSON.stringify({ event: "stop", message }));
}

export function apply(ctx: Context): void {
  // Record when each agent enters running. WeakMap rather than Map: the entry
  // disappears when the agent is collected, no cleanup needed on disposed.
  const startedAt = new WeakMap<Agent, number>();

  ctx.on("chopin-team/attention", (root, task) => {
    alert(workspaceLabel(root), `${task.spec.id} waits for a decision: ${task.attention?.reason ?? "attention"}`);
  });

  ctx.on("agent/status", (payload: { agent: Agent; status: AgentStatus }) => {
    const { agent, status } = payload;
    if (status === "running") {
      startedAt.set(agent, Date.now());
      return;
    }
    if (status !== "idle") return;

    const began = startedAt.get(agent);
    startedAt.delete(agent);
    // No start time means this idle did not come from running (e.g. a freshly created session); do not notify
    if (began === undefined) return;

    const elapsed = Date.now() - began;
    if (elapsed < QUIET_BELOW_MS || !spokenByPerson(agent.session.snapshotEvents())) return;

    alert(workspaceLabel((ctx as { cwd?: string }).cwd ?? process.cwd()), `Turn finished in ${humanDuration(elapsed)}`);
  });
}
