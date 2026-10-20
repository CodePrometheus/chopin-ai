import type { Command } from "@chopin-ai/core";
import { chopinModels } from "./credentials.js";
import { onScreen, signIn } from "./sign-in.js";

/** Connects a provider for every chopin of this machine, before any conversation, such as for an editor's. */
export const loginCommand: Command = {
  name: "login",
  args: "[provider]",
  summary: "connect a provider, by its sign-in or a key, for every chopin on this machine",
  run: async (args, io) => {
    if (args.length > 1) {
      io.err("usage: chopin login [provider]");
      return 2;
    }
    const runtime = await chopinModels();
    const id = await onScreen((stage) => signIn(stage, runtime, args[0]));
    if (id === undefined) {
      io.err("chopin: nothing was connected");
      return 1;
    }
    io.err(`chopin: connected ${runtime.getProvider(id)?.name ?? id}`);
    return 0;
  },
};
