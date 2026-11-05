import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Command } from "@chopin-ai/core";
import { AgentService, integratorTokens, launchToken, listen } from "@chopin-ai/harness-pi";
import { errorChain, errorText } from "@chopin-ai/harness-pi/protocol";
import { createRemoteJWKSet } from "jose";
import { ContainerWorkspaceProvider } from "@chopin-ai/workspace";
import { agentSetup } from "./agent.js";
import { chopinHome } from "./home.js";
import { serveWorkspace } from "./project.js";

/**
 * A service whose workspaces are containers, for running agents isolated from this machine, or the service of one
 * owner whose workspace runs beside it, such as another container of the same pod. Day-to-day local use needs none of this: a bare `chopin` works in
 * the current directory.
 */
function serveOptions(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    options: {
      jwks: { type: "string" },
      issuer: { type: "string" },
      audience: { type: "string" },
      image: { type: "string" },
      port: { type: "string", default: "0" },
      host: { type: "string" },
      // Services sharing an engine each take their own: they see, store and reclaim only their own workspaces.
      prefix: { type: "string" },
      // One owner, whose workspace's listener answers on this loopback port and keeps its files under the root.
      "workspace-port": { type: "string" },
      root: { type: "string" },
      // That owner's things kept sealed in this directory, opened once a client unlocks the service.
      sealed: { type: "string" },
    },
  }).values;
}

export const serveCommand: Command = {
  name: "serve",
  args: "[--jwks <url> [--issuer <iss>] [--audience <aud>]] [--image <image>] [--prefix <name>] | --workspace-port <port> --root <dir> [--sealed <dir>]; [--host <address>] [--port <port>]",
  summary: "run a service with one container workspace per owner, or for one owner whose workspace answers on a loopback port, until interrupted",
  run: async (args, io) => {
    let values: ReturnType<typeof serveOptions>;
    try {
      values = serveOptions(args);
    } catch (error) {
      io.err(`chopin serve: ${errorText(error)}`);
      return 2;
    }
    const port = /^\d{1,5}$/.test(values.port) ? Number(values.port) : -1;
    const token = process.env.CHOPIN_TOKEN;
    const owned = values["workspace-port"];
    const workspacePort = owned !== undefined && /^\d{1,5}$/.test(owned) ? Number(owned) : -1;
    const containers = [values.jwks, values.issuer, values.audience, values.image, values.prefix].some((value) => value !== undefined);
    const problem = ([
      [values.prefix !== undefined && !/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(values.prefix), "--prefix is a lowercase name of letters, digits, '.', '_' or '-'"],
      [port < 0 || port > 65_535, "--port is a port number"],
      [values.host === "", "--host, when given, names an address"],
      [values.jwks !== undefined && !URL.canParse(values.jwks), "--jwks is the address of the integrator's key set"],
      [values.jwks === undefined && (values.issuer !== undefined || values.audience !== undefined), "--issuer and --audience go with --jwks"],
      [values.issuer === "" || values.audience === "", "--issuer and --audience, when given, name something"],
      [(owned === undefined) !== (values.root === undefined), "--workspace-port and --root go together"],
      [owned !== undefined && (workspacePort < 1 || workspacePort > 65_535), "--workspace-port is a port number"],
      [owned !== undefined && containers, "--workspace-port serves one owner in a workspace of its own; --jwks, --issuer, --audience, --image and --prefix do not apply"],
      [values.root !== undefined && !isAbsolute(values.root), "--root is the workspace's directory, as an absolute path"],
      [owned !== undefined && !token, "--workspace-port admits the one credential in CHOPIN_TOKEN, which is not set"],
      [values.sealed !== undefined && owned === undefined, "--sealed keeps the things of the one owner --workspace-port serves"],
      [values.sealed !== undefined && !isAbsolute(values.sealed), "--sealed is an absolute path"],
      [values.sealed !== undefined && !relative(values.sealed, chopinHome()).startsWith(".."), "the chopin home lives in memory, outside --sealed"],
    ] as const).find(([wrong]) => wrong)?.[1];
    if (problem !== undefined) {
      io.err(`chopin serve: ${problem}`);
      return 2;
    }
    // Caught before the address is announced, so a signal sent right after it still shuts down cleanly.
    const stopped = Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
    if (owned !== undefined && values.root !== undefined && token) {
      const stop = new AbortController();
      void stopped.then(() => stop.abort());
      await serveWorkspace({
        workspacePort, root: values.root, token, port, signal: stop.signal,
        ...(values.host !== undefined && { hostname: values.host }),
        ...(values.sealed !== undefined && { sealed: values.sealed }),
        listening: (at) => io.err(`chopin: serving ws://${values.host ?? "127.0.0.1"}:${at}/ for one owner with the credential in CHOPIN_TOKEN, whose workspace answers at 127.0.0.1:${workspacePort}${values.sealed === undefined ? "" : "; locked until a client unlocks it with its key"}`),
      });
      return 0;
    }
    const prefix = values.prefix ?? "chopin";
    const service = new AgentService({
      ...await agentSetup(),
      dataDir: join(chopinHome(), "service", prefix),
      workspaces: new ContainerWorkspaceProvider({ image: values.image ?? "chopin-ai-workspace:local", prefix }),
      reclaimAfterMs: 30 * 60_000,
      report: (error) => io.err(`chopin serve: ${errorChain(error)}`),
    });
    const launch = randomBytes(32).toString("base64url");
    const authenticate = values.jwks === undefined
      ? launchToken(launch)
      : integratorTokens({
        key: createRemoteJWKSet(new URL(values.jwks)),
        ...(values.issuer !== undefined && { issuer: values.issuer }),
        ...(values.audience !== undefined && { audience: values.audience }),
      });
    try {
      const server = await listen(service, { authenticate, port, ...(values.host !== undefined && { hostname: values.host }) });
      try {
        const address = `${values.host ?? "127.0.0.1"}:${server.port}`;
        if (values.jwks === undefined) {
          io.err(`chopin: serving ws://${address}/ for one owner with credential ${launch}; pass --jwks to serve each owner the integrator names`);
        } else {
          io.err(`chopin: serving ws://${address}/ for the owners named by tokens signed with ${values.jwks}`);
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
