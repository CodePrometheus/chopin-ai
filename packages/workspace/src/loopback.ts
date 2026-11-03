import { connect } from "node:net";
import { extname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Workspace, WorkspaceProvider } from "./workspace.js";

/** The only address the workspace's listener is reached at: one no other machine can reach. */
const LOOPBACK = "127.0.0.1";

export interface LoopbackWorkspaceOptions {
  /** The port the workspace's listener serves on the loopback address. */
  port: number;
  /** The persistent directory inside the workspace, where work happens. */
  root: string;
  /** The execution daemon as the listener starts it, the one command this workspace runs. */
  daemon: string;
  /** How long `start` waits for the listener to answer; a minute by default. */
  startTimeoutMs?: number;
}

// The connector next to this module, run by Node as it is: compiled, or as source while testing.
const CONNECTOR = fileURLToPath(new URL(`./loopback-connect${extname(fileURLToPath(import.meta.url))}`, import.meta.url));

/**
 * A workspace someone else runs beside the service on the same network, such as another container of the same pod,
 * whose listener on a loopback port starts the execution daemon for each connection. Starting and stopping it is
 * theirs. The daemon is all it runs: a byte stream carries no exit status, which any other command would need.
 */
export class LoopbackWorkspaceProvider implements WorkspaceProvider {
  readonly #options: LoopbackWorkspaceOptions;

  constructor(options: LoopbackWorkspaceOptions) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) throw new Error(`${options.port} is no port`);
    this.#options = options;
  }

  open(owner: string): Workspace {
    const { port, root, daemon, startTimeoutMs = 60_000 } = this.#options;
    const at = `${LOOPBACK}:${port}`;
    const managed = async () => {
      throw new Error(`the workspace at ${at} is started and stopped by whoever runs it`);
    };
    return {
      owner,
      root,
      state: async () => ((await answers(port)) ? "running" : "stopped"),
      start: async () => {
        const deadline = Date.now() + startTimeoutMs;
        while (!(await answers(port))) {
          if (Date.now() >= deadline) throw new Error(`no workspace listener answered at ${at}`);
          await sleep(250);
        }
      },
      pause: managed,
      stop: managed,
      destroy: managed,
      command: (argv, env = {}) => {
        if (argv.length !== 1 || argv[0] !== daemon || Object.keys(env).length > 0) {
          throw new Error(`the workspace at ${at} runs only its execution daemon, ${daemon}`);
        }
        return { argv: [process.execPath, CONNECTOR, String(port)], env: {} };
      },
    };
  }

  /** Nothing here can be reclaimed: whoever runs the workspace does that. */
  async list(): Promise<Workspace[]> {
    return [];
  }
}

/** Whether a listener accepts a connection on the loopback `port` now. */
function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(port, LOOPBACK, () => {
      probe.destroy();
      resolve(true);
    });
    probe.on("error", () => resolve(false));
  });
}
