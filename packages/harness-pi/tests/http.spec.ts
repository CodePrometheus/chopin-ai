import { get } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  it("moves a credential from the address into a cookie and serves the web app", async () => {
    const base = await mkdtemp(join(tmpdir(), "chopin-web-"));
    const web = join(base, "web");
    await mkdir(web);
    await writeFile(join(web, "index.html"), "<!doctype html><title>chopin</title>");
    await writeFile(join(web, "app.js"), "console.log('app');");
    await writeFile(join(base, "outside.txt"), "secret");
    const service = new AgentService({ dataDir: await mkdtemp(join(tmpdir(), "chopin-http-")), workspaces: nowhere, models: () => createModels() });
    const server = await listen(service, { authenticate: launchToken("secret"), web });
    const at = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`, { redirect: "manual" });
    try {
      const signedIn = await at("/?token=secret");
      expect(signedIn.status).toBe(303);
      expect(signedIn.headers.get("location")).toBe("./");
      expect(signedIn.headers.get("set-cookie")).toBe(`chopin-${server.port}=secret; HttpOnly; SameSite=Strict`);
      const proxied = await fetch(`http://127.0.0.1:${server.port}/?token=secret`, { redirect: "manual", headers: { "x-forwarded-proto": "https" } });
      expect(proxied.headers.get("set-cookie")).toBe(`chopin-${server.port}=secret; HttpOnly; SameSite=Strict; Secure`);
      expect((await at("/?token=wrong")).status).toBe(401);
      const vouched = await fetch(`http://127.0.0.1:${server.port}/?token=wrong`, { redirect: "manual", headers: { authorization: "Bearer secret" } });
      expect(vouched.status).toBe(401);

      const script = await at("/app.js");
      expect(script.headers.get("content-type")).toContain("text/javascript");
      expect(await script.text()).toBe("console.log('app');");
      expect(await (await at("/")).text()).toContain("<title>chopin</title>");
      expect((await at("/conversations/3")).status).toBe(404);
      expect((await at("/..%2Foutside.txt")).status).toBe(404);
    } finally {
      await server.close();
      await service.close(context);
    }
  });

  it("never redirects the exchange to another host", async () => {
    const service = new AgentService({ dataDir: await mkdtemp(join(tmpdir(), "chopin-http-")), workspaces: nowhere, models: () => createModels() });
    const server = await listen(service, { authenticate: launchToken("secret") });
    try {
      // Sent as written: a browser-side client would normalize the path first.
      const location = await new Promise<string | undefined>((resolve, reject) => {
        get({ host: "127.0.0.1", port: server.port, path: "/.//elsewhere.test/?token=secret" }, (response) => {
          response.resume();
          resolve(response.headers.location);
        }).on("error", reject);
      });
      expect(location).toBe("./");
    } finally {
      await server.close();
      await service.close(context);
    }
  });
});

describe("serving without a built web app", () => {
  it("answers 404 instead of failing, and keeps serving", async () => {
    const service = new AgentService({ dataDir: await mkdtemp(join(tmpdir(), "chopin-http-")), workspaces: nowhere, models: () => createModels() });
    const web = await mkdtemp(join(tmpdir(), "chopin-empty-web-"));
    const server = await listen(service, { authenticate: launchToken("secret"), web });
    try {
      expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${server.port}/app.js`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${server.port}/%E0%A4%A`)).status).toBe(404);
    } finally {
      await server.close();
      await service.close(context);
    }
  });
});
