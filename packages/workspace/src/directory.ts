import { carried, type Workspace, type WorkspaceProvider } from "./workspace.js";

/**
 * Single-user local mode: the workspace is a directory of this machine, used as it is. There is nothing to start or
 * stop, and nothing is ever deleted: the directory is the user's own.
 */
export class DirectoryWorkspaceProvider implements WorkspaceProvider {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
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
        return { argv: ["sh", "-c", `cd "$1" && shift && ${carry.exec}`, "sh", this.#root, ...argv], env: carry.env };
      },
    };
  }

  /** Nothing here can be reclaimed. */
  async list(): Promise<Workspace[]> {
    return [];
  }
}
