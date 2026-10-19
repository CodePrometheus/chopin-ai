import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Command } from "@chopin-ai/core";
import { AgentService, integratorTokens, launchToken, listen } from "@chopin-ai/harness-pi";
import { errorChain, errorText } from "@chopin-ai/harness-pi/protocol";
import { createRemoteJWKSet } from "jose";
import { ContainerWorkspaceProvider } from "@chopin-ai/workspace";
import { agentSetup, webApp } from "./agent.js";
import { chopinHome } from "./home.js";

/**
 * A service whose workspaces are containers, for running agents isolated from this machine. Day-to-day local use
 * needs none of this: a bare `chopin` works in the current directory.
 */
function serveOptions(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    options: {
      jwks: { type: "string" },
      issuer: { type: "string" },
      audience: { type: "string" },
      image: { type: "string", default: "chopin-ai-workspace:local" },
      port: { type: "string", default: "0" },
      // Services sharing an engine each take their own: they see, store and reclaim only their own workspaces.
      prefix: { type: "string", default: "chopin" },
    },
  }).values;
}

export const serveCommand: Command = {
  name: "serve",
  args: "[--jwks <url> [--issuer <iss>] [--audience <aud>]] [--image <image>] [--port <port>] [--prefix <name>]",
  summary: "run a service with one container workspace per owner, named by the integrator's tokens, until interrupted",
  run: async (args, io) => {
    let values: ReturnType<typeof serveOptions>;
    try {
      values = serveOptions(args);
    } catch (error) {
      io.err(`chopin serve: ${errorText(error)}`);
      return 2;
    }
    const port = /^\d{1,5}$/.test(values.port) ? Number(values.port) : -1;
    const problem = !/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(values.prefix)
      ? "--prefix is a lowercase name of letters, digits, '.', '_' or '-'"
      : port < 0 || port > 65_535
        ? "--port is a port number"
        : values.jwks !== undefined && !URL.canParse(values.jwks)
          ? "--jwks is the address of the integrator's key set"
          : values.jwks === undefined && (values.issuer !== undefined || values.audience !== undefined)
            ? "--issuer and --audience go with --jwks"
            : values.issuer === "" || values.audience === ""
              ? "--issuer and --audience, when given, name something"
              : undefined;
    if (problem !== undefined) {
      io.err(`chopin serve: ${problem}`);
      return 2;
    }
    const service = new AgentService({
      ...await agentSetup(),
      dataDir: join(chopinHome(), "service", values.prefix),
      workspaces: new ContainerWorkspaceProvider({ image: values.image, prefix: values.prefix }),
      reclaimAfterMs: 30 * 60_000,
      report: (error) => io.err(`chopin serve: ${errorChain(error)}`),
    });
    const token = randomBytes(32).toString("base64url");
    const authenticate = values.jwks === undefined
      ? launchToken(token)
      : integratorTokens({
        key: createRemoteJWKSet(new URL(values.jwks)),
        ...(values.issuer !== undefined && { issuer: values.issuer }),
        ...(values.audience !== undefined && { audience: values.audience }),
      });
    try {
      // Caught before the address is announced, so a signal sent right after it still shuts down cleanly.
      const stopped = Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
      const server = await listen(service, { authenticate, port, web: webApp() });
      try {
        if (values.jwks === undefined) {
          io.err(`chopin: serving ws://127.0.0.1:${server.port}/ for one owner with credential ${token}; pass --jwks to serve each owner the integrator names`);
          io.err(`chopin: in a browser, open http://127.0.0.1:${server.port}/?token=${token}`);
        } else {
          io.err(`chopin: serving ws://127.0.0.1:${server.port}/ for the owners named by tokens signed with ${values.jwks}`);
        }
        await stopped;
      } finally {
        await server.close();
      }
    } finally {
      await service.close(BACKGROUND_CONTEXT);
    }
    return 0;
  },
};
