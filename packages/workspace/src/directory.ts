import { carried, type Launch, type Workspace, type WorkspaceProvider } from "./workspace.js";

export interface DirectoryWorkspaceOptions {
  /**
   * Directories no command in the workspace may read or write, each a real path with no symbolic link on the way,
   * since that is how the sandbox sees them. Only macOS enforces this; elsewhere commands run unconfined.
   */
  hidden?: readonly string[];
}

/**
 * Single-user local mode: the workspace is a directory of this machine, used as it is. There is nothing to start or
 * stop, and nothing is ever deleted: the directory is the user's own.
 */
export class DirectoryWorkspaceProvider implements WorkspaceProvider {
  readonly #root: string;
  readonly #hidden: readonly string[];

  constructor(root: string, options: DirectoryWorkspaceOptions = {}) {
    this.#root = root;
    this.#hidden = options.hidden ?? [];
  }

  open(owner: string): Workspace {
    return {
      owner,
      root: this.#root,
      state: async () => "running",
      start: async () => {},
      pause: async () => {},
      stop: async () => {},
      destroy: async () => {
        throw new Error(`${this.#root} is the user's own directory and is never destroyed`);
      },
      command: (argv, env = {}) => {
        const carry = carried(argv, env);
        return confined({ argv: ["sh", "-c", `cd "$1" && shift && ${carry.exec}`, "sh", this.#root, ...argv], env: carry.env }, this.#hidden);
      },
    };
  }

  /** Nothing here can be reclaimed. */
  async list(): Promise<Workspace[]> {
    return [];
  }
}

/** `launch` under a macOS sandbox that denies every file operation within `hidden`, and allows all else. */
function confined(launch: Launch, hidden: readonly string[]): Launch {
  if (hidden.length === 0 || process.platform !== "darwin") return launch;
  // Paths travel as parameters, so none is ever quoted into the profile.
  const params = hidden.flatMap((path, i) => ["-D", `HIDDEN_${i}=${path}`]);
  const denied = hidden.map((_, i) => `(subpath (param "HIDDEN_${i}"))`).join(" ");
  const profile = `(version 1)(allow default)(deny file-read* file-write* ${denied})`;
  return { argv: ["/usr/bin/sandbox-exec", ...params, "-p", profile, ...launch.argv], env: launch.env };
}
