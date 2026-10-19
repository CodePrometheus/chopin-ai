import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { Command } from "@chopin-ai/core";
import { serveAcp } from "@chopin-ai/harness-pi";
import { connect } from "@chopin-ai/harness-pi/protocol";
import { notInteractive } from "./model.js";
import { findProject, openProject } from "./project.js";

/**
 * Lets an ACP client, such as an editor, drive the agent through this process's stdio: this project's agent by
 * default, or one of a remote service, whose credential comes from CHOPIN_TOKEN.
 */
export const acpCommand: Command = {
  name: "acp",
  args: "[service url]",
  summary: "speak ACP on stdio for this project's agent, or a remote service's",
  run: async (args, io) => {
    const remote = args[0];
    if (args.length > 1 || (remote !== undefined && !(URL.canParse(remote) && /^(ws|http)s?:$/.test(new URL(remote).protocol)))) {
      io.err("usage: chopin acp [service url]");
      return 2;
    }
    const local = remote === undefined ? await openProject(process.cwd(), notInteractive) : undefined;
    const host = local === undefined
      ? connect(remote ?? "", process.env.CHOPIN_TOKEN === undefined ? {} : { token: process.env.CHOPIN_TOKEN })
      : connect(local.url, { token: local.token, find: findProject(process.cwd()) });
    const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
    await serveAcp(stream, host).closed;
    await host.close();
    return 0;
  },
};
