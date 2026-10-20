import { localDaemon } from "@earendil-works/pi-env";
import type { Workspace, WorkspaceProvider } from "@chopin-ai/workspace";
import { DAEMON_PATH } from "../src/index.js";

/** A workspace on this machine: the daemon is this machine's own, and commands run in the root as everywhere. */
export function localWorkspace(root: string): WorkspaceProvider {
  return {
    open: (owner): Workspace => ({
      owner, root,
      state: async () => "running", start: async () => {}, pause: async () => {}, stop: async () => {}, destroy: async () => {},
      command: (argv) => ({
        argv: ["sh", "-c", 'cd "$1" && shift && exec "$@"', "sh", root, ...(argv[0] === DAEMON_PATH ? [localDaemon(), ...argv.slice(1)] : argv)],
        env: {},
      }),
    }),
    list: async () => [],
  };
}
