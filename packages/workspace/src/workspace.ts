export type WorkspaceState = "absent" | "stopped" | "paused" | "running";

/** One owner's isolated machine. Its volume outlives every state but `destroy`. */
export interface Workspace {
  readonly owner: string;
  /** The persistent directory inside the workspace, where work happens. */
  readonly root: string;
  state(): Promise<WorkspaceState>;
  /** Brings the workspace to running: creates, boots or resumes it as needed. */
  start(): Promise<void>;
  /** Freezes its processes and keeps their memory; `start` resumes them. */
  pause(): Promise<void>;
  /** Releases compute and keeps the volume; `start` boots it again. */
  stop(): Promise<void>;
  /** Deletes the workspace together with its volume. */
  destroy(): Promise<void>;
  /** How to run `argv` inside the running workspace, in its root, with stdio attached and `env` set. */
  command(argv: readonly string[], env?: Readonly<Record<string, string>>): Launch;
}

/** A command line, and what to add to the environment it is started with. */
export interface Launch {
  argv: string[];
  env: Record<string, string>;
}

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CARRIED = "CHOPIN_ENV_";

/**
 * Whether a workspace can carry a variable of this name: a portable name, other than `_`, which a shell sets anew
 * for every command it starts, and those under which workspaces carry variables.
 */
export function isVariableName(name: string): boolean {
  return VARIABLE.test(name) && name !== "_" && !name.startsWith(CARRIED);
}

/**
 * Carries variables into a workspace with no value on any command line and none of their names in the launcher's own
 * environment, where a PATH or a preload would change how the launcher runs. Each travels under a name of its own,
 * and `exec`, a shell command that runs "$@", sets it under its name; one the shell does not keep as given, such as
 * a variable it computes or holds read-only, stops the command from starting rather than reaching it changed.
 */
export function carried(argv: readonly string[], env: Readonly<Record<string, string>>): { env: Record<string, string>; exec: string } {
  if (argv.length === 0) throw new Error("there is no command to run");
  const names = Object.keys(env);
  if (names.length === 0) return { env: {}, exec: 'exec "$@"' };
  const invalid = names.find((name) => !isVariableName(name));
  if (invalid !== undefined) throw new Error(`${JSON.stringify(invalid)} is not a variable name a workspace can carry`);
  const carrier = (name: string) => CARRIED + name;
  // A subshell tries each export first, since a failing one would end the shell itself.
  const set = names.map((name) => {
    const value = `"$${carrier(name)}"`;
    return `{ (export ${name}=${value}) 2>/dev/null && export ${name}=${value} && [ "$${name}" = ${value} ] || { echo "the workspace's shell keeps its own ${name}" >&2; exit 126; }; }`;
  });
  return {
    env: Object.fromEntries(names.map((name) => [carrier(name), env[name] as string])),
    exec: `${set.join(" && ")} && unset ${names.map(carrier).join(" ")} && exec "$@"`,
  };
}

export interface WorkspaceProvider {
  /** The owner's workspace. Nothing is created until it is started. */
  open(owner: string): Workspace;
  /** Every workspace this provider has created and not destroyed. */
  list(): Promise<Workspace[]>;
}

/** What a sweep did: the owners whose workspaces it stopped, and those it could not, with why. */
export interface Reclaimed {
  stopped: string[];
  failed: { owner: string; error: unknown }[];
}

/**
 * Stops the workspaces of owners idle for at least `idleMs`, a few at a time, keeping their volumes. An owner is
 * asked again right before its workspace stops, so work that began meanwhile keeps it; a workspace that fails to
 * stop keeps no other from stopping.
 */
export async function reclaimIdle(
  provider: WorkspaceProvider,
  lastActive: (owner: string) => number | undefined,
  idleMs: number,
  now: number = Date.now(),
): Promise<Reclaimed> {
  const reclaimed: Reclaimed = { stopped: [], failed: [] };
  const idle = (owner: string) => {
    const active = lastActive(owner);
    return active === undefined || now - active >= idleMs;
  };
  const queue = (await provider.list()).filter((workspace) => idle(workspace.owner));
  const worker = async () => {
    for (let workspace = queue.shift(); workspace !== undefined; workspace = queue.shift()) {
      try {
        const state = await workspace.state();
        if ((state !== "running" && state !== "paused") || !idle(workspace.owner)) continue;
        await workspace.stop();
        reclaimed.stopped.push(workspace.owner);
      } catch (error) {
        reclaimed.failed.push({ owner: workspace.owner, error });
      }
    }
  };
  await Promise.all(Array.from({ length: RECLAIMING_AT_ONCE }, worker));
  return reclaimed;
}

/** How many workspaces a sweep stops at once, so an engine with many is not flooded. */
const RECLAIMING_AT_ONCE = 8;
