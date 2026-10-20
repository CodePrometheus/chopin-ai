import type { Command } from "@chopin-ai/core";
import { HAND_OVER, runDaemon } from "./project.js";

/** The background service of one project; the other commands start it when they need it. */
export const daemonCommand: Command = {
  name: "daemon",
  args: "<directory>",
  summary: "serve a project in the background until idle; chopin starts this on its own",
  run: async (args, io) => {
    const [directory] = args;
    if (directory === undefined || args.length > 1) {
      io.err("usage: chopin daemon <directory>");
      return 2;
    }
    const stop = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => stop.abort());
    const retire = new AbortController();
    // Asked again while it finishes its work, it keeps finishing rather than ending at once.
    process.on(HAND_OVER, () => retire.abort());
    await runDaemon(directory, { signal: stop.signal, retire: retire.signal });
    // Its lock and record are released; nothing left open may keep a finished daemon around.
    process.exit(0);
  },
};
