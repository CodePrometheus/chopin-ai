import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import type { Workspace, WorkspaceProvider } from "@chopin-ai/workspace";
import { describe, expect, it } from "vitest";
import { AgentService, launchToken, listen } from "../src/index.js";

const nowhere: WorkspaceProvider = {
  open: (owner): Workspace => ({
    owner, root: "/", state: async () => "running",
    start: async () => {}, pause: async () => {}, stop: async () => {}, destroy: async () => {}, command: (argv, env = {}) => ({ argv: [...argv], env: { ...env } }),
  }),
  list: async () => [],
};

describe("the service over HTTP", () => {
  it("serves no page and sets no cookie, whatever credential an address carries", async () => {
    const service = new AgentService({ dataDir: await mkdtemp(join(tmpdir(), "chopin-http-")), workspaces: nowhere, models: () => createModels() });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const at = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`, { redirect: "manual" });
    try {
      for (const path of ["/", "/?token=secret", "/app.js", "/%E0%A4%A"]) {
        const answer = await at(path);
        expect(answer.status).toBe(404);
        expect(answer.headers.get("set-cookie")).toBeNull();
      }
    } finally {
      await server.close();
      await service.close(context);
    }
  });

  it("tells its owner whether it has work in hand, without counting the question as use", async () => {
    const service = new AgentService({ dataDir: await mkdtemp(join(tmpdir(), "chopin-http-")), workspaces: nowhere, models: () => createModels() });
    let busy = false;
    const server = await listen(service, { authenticate: launchToken("secret"), busy: async () => busy });
    try {
      const status = (credential?: string) => fetch(`http://127.0.0.1:${server.port}/status`, credential === undefined ? {} : { headers: { authorization: `Bearer ${credential}` } });
      const reached = server.reachedAt;
      expect(await (await status("secret")).json()).toEqual({ busy: false, locked: false });
      busy = true;
      expect(await (await status("secret")).json()).toEqual({ busy: true, locked: false });
      expect((await status("wrong")).status).toBe(401);
      expect((await status()).status).toBe(401);
      expect(server.reachedAt).toBe(reached);
    } finally {
      await server.close();
      await service.close(context);
    }
  });
});
