import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import type { Workspace, WorkspaceProvider } from "@chopin-ai/workspace";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { AgentService, launchToken, listen } from "../src/index.js";

const nowhere: WorkspaceProvider = {
  open: (owner): Workspace => ({
    owner, root: "/", state: async () => "running",
    start: async () => {}, pause: async () => {}, stop: async () => {}, destroy: async () => {}, command: (argv, env = {}) => ({ argv: [...argv], env: { ...env } }),
  }),
  list: async () => [],
};

/** Whether the service keeps a socket open for a while, or closes it. */
async function kept(socket: WebSocket): Promise<boolean> {
  const closed = once(socket, "close").then(() => false);
  const held = new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 300));
  const result = await Promise.race([closed, held]);
  socket.terminate();
  return result;
}

describe("WebSocket origins", () => {
  it("refuses a page of another origin even with the credential cookie, and admits its own", async () => {
    const service = new AgentService({ dataDir: await mkdtemp(join(tmpdir(), "chopin-origin-")), workspaces: nowhere, models: () => createModels() });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const url = `ws://127.0.0.1:${server.port}/`;
    try {
      expect(await kept(new WebSocket(url, { headers: { cookie: `chopin-${server.port}=secret`, origin: "http://127.0.0.1:1" } }))).toBe(false);
      expect(await kept(new WebSocket(url, { headers: { cookie: `chopin-${server.port}=secret`, origin: `http://127.0.0.1:${server.port}` } }))).toBe(true);
      // Behind a proxy, the page's address is the one the proxy names.
      const proxied = { cookie: `chopin-${server.port}=secret`, origin: "https://chopin.example.test", "x-forwarded-host": "Chopin.Example.Test:443" };
      expect(await kept(new WebSocket(url, { headers: proxied }))).toBe(true);
    } finally {
      await server.close();
      await service.close(context);
    }
  });
});
