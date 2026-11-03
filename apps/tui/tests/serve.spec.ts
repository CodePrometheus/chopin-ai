import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { localDaemon } from "@earendil-works/pi-env";
import { Conversations, Credentials, connect, Loop } from "@chopin-ai/harness-pi/protocol";
import { describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
// The workspace's listener ships beside the workspace package's `dist/`.
const LISTENER = join(dirname(dirname(fileURLToPath(import.meta.resolve("@chopin-ai/workspace")))), "loopback-listener.sh");
const hasRelay = spawnSync("socat", ["-V"]).status === 0;

/** A loopback port nothing listens on now. */
async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Resolves with the first value `subscribe` hands over that passes `test`. */
function until<T>(subscribe: (listener: (value: T) => void) => () => void, test: (value: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    const stop = subscribe((value) => {
      if (test(value)) {
        queueMicrotask(() => stop());
        resolve(value);
      }
    });
  });
}

describe("chopin serve", () => {
  it("serves with the chosen model until interrupted, and no web page", async () => {
    const [model] = builtinModels().getModels();
    const child = spawn(process.execPath, [bin, "serve"], {
      env: { ...process.env, CHOPIN_HOME: await mkdtemp(join(tmpdir(), "chopin-home-")), CHOPIN_MODEL: `${model?.provider}/${model?.id}` },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const address = await new Promise<{ port: string; token: string }>((resolve, reject) => {
      child.stderr.on("data", (chunk: Buffer) => {
        const found = /ws:\/\/127\.0\.0\.1:(\d+)\/ for one owner with credential (\S+);/.exec(chunk.toString());
        if (found !== null) resolve({ port: found[1] ?? "", token: found[2] ?? "" });
      });
      child.once("exit", (code) => reject(new Error(`serve exited early with ${code}`)));
    });

    const host = connect(`ws://127.0.0.1:${address.port}/?token=${address.token}`);
    const conversations = await host.get(Conversations, {});
    expect(await host.root((ctx) => conversations.create(ctx))).toBeTypeOf("number");
    // The credentials of a service for many owners are no client's to change.
    const keys = await host.get(Credentials, {});
    await expect(host.root((ctx) => keys.setKey({ provider: "anthropic", key: "k" }, ctx))).rejects.toThrow("not from its clients");
    await host.close();
    expect((await fetch(`http://127.0.0.1:${address.port}/`)).status).toBe(404);

    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
  }, 30_000);

  it("refuses a prefix that could not name a container or would leave its store's folder", async () => {
    const child = spawn(process.execPath, [bin, "serve", "--prefix", "../elsewhere"], {
      env: { ...process.env, CHOPIN_HOME: await mkdtemp(join(tmpdir(), "chopin-home-")) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const [code] = await once(child, "exit");
    expect(code).toBe(2);
    expect(stderr).toContain("--prefix is a lowercase name");
  });

  it("names a flag it does not know as a usage error", async () => {
    const child = spawn(process.execPath, [bin, "serve", "--jwk", "https://example.test/keys"], {
      env: { ...process.env, CHOPIN_HOME: await mkdtemp(join(tmpdir(), "chopin-home-")) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const [code] = await once(child, "exit");
    expect(code).toBe(2);
    expect(stderr).toContain("chopin serve: Unknown option '--jwk'");
  });

  it("refuses a port that is no port number", async () => {
    const child = spawn(process.execPath, [bin, "serve", "--port", "abc"], {
      env: { ...process.env, CHOPIN_HOME: await mkdtemp(join(tmpdir(), "chopin-home-")) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const [code] = await once(child, "exit");
    expect(code).toBe(2);
    expect(stderr).toContain("--port is a port number");
  });

  it("explains how to choose a model when none is chosen", async () => {
    const child = spawn(process.execPath, [bin, "serve"], {
      env: { ...process.env, CHOPIN_HOME: await mkdtemp(join(tmpdir(), "chopin-home-")), CHOPIN_MODEL: "" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const [code] = await once(child, "exit");
    expect(code).toBe(1);
    expect(stderr).toContain("run chopin once to connect a provider and pick one");
  });

  it("serves the owners an integrator names when given its key set", async () => {
    const [model] = builtinModels().getModels();
    const child = spawn(process.execPath, [bin, "serve", "--jwks", "http://127.0.0.1:9/jwks.json", "--issuer", "integrator"], {
      env: { ...process.env, CHOPIN_HOME: await mkdtemp(join(tmpdir(), "chopin-home-")), CHOPIN_MODEL: `${model?.provider}/${model?.id}` },
      stdio: ["ignore", "ignore", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      child.stderr.on("data", (chunk: Buffer) => { if (chunk.toString().includes("for the owners named by tokens signed with")) resolve(); });
      child.once("exit", (code) => reject(new Error(`serve exited early with ${code}`)));
    });
    child.kill("SIGTERM");
    expect((await once(child, "exit"))[0]).toBe(0);
  }, 30_000);

  it("refuses a workspace beside it without its root, its credential, a port, or alongside container options", async () => {
    const refusal = async (args: string[], env: Record<string, string>) => {
      const child = spawn(process.execPath, [bin, "serve", ...args], {
        env: { ...process.env, CHOPIN_HOME: await mkdtemp(join(tmpdir(), "chopin-home-")), CHOPIN_TOKEN: "", ...env },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      const [code] = await once(child, "exit");
      return { code, stderr };
    };
    expect(await refusal(["--workspace-port", "7070"], { CHOPIN_TOKEN: "t" })).toMatchObject({ code: 2, stderr: expect.stringContaining("--workspace-port and --root go together") });
    expect(await refusal(["--workspace-port", "/run/w.sock", "--root", "/workspace"], { CHOPIN_TOKEN: "t" })).toMatchObject({ code: 2, stderr: expect.stringContaining("--workspace-port is a port number") });
    expect(await refusal(["--workspace-port", "7070", "--root", "/workspace", "--prefix", "p"], { CHOPIN_TOKEN: "t" }))
      .toMatchObject({ code: 2, stderr: expect.stringContaining("--image and --prefix do not apply") });
    expect(await refusal(["--workspace-port", "7070", "--root", "workspace"], { CHOPIN_TOKEN: "t" })).toMatchObject({ code: 2, stderr: expect.stringContaining("as an absolute path") });
    expect(await refusal(["--workspace-port", "7070", "--root", "/workspace"], {})).toMatchObject({ code: 2, stderr: expect.stringContaining("CHOPIN_TOKEN, which is not set") });
  });

  it.runIf(hasRelay)("serves one owner whose workspace answers on a loopback port, admitting only the credential it was given", async () => {
    const [model] = builtinModels().getModels();
    const root = await realpath(await mkdtemp(join(tmpdir(), "chopin-workspace-")));
    await writeFile(join(root, "AGENTS.md"), "Work carefully.\n");
    const workspacePort = await freePort();
    let relay: ReturnType<typeof spawn> | undefined;
    const home = await mkdtemp(join(tmpdir(), "chopin-home-"));
    const child = spawn(process.execPath, [bin, "serve", "--workspace-port", String(workspacePort), "--root", root], {
      env: { ...process.env, CHOPIN_HOME: home, CHOPIN_MODEL: `${model?.provider}/${model?.id}`, CHOPIN_TOKEN: "given" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      const port = await new Promise<string>((resolve, reject) => {
        child.stderr.on("data", (chunk: Buffer) => {
          const found = /ws:\/\/127\.0\.0\.1:(\d+)\/ for one owner with the credential in CHOPIN_TOKEN/.exec(chunk.toString());
          if (found !== null) resolve(found[1] ?? "");
        });
        child.once("exit", (code) => reject(new Error(`serve exited early with ${code}`)));
      });
      const host = connect(`ws://127.0.0.1:${port}/`, { token: "given" });
      const conversations = await host.get(Conversations, {});
      // The project's instructions come from the workspace, which answers only once its listener is up.
      let answered = false;
      const loaded = host.root((ctx) => conversations.loaded(ctx)).finally(() => (answered = true));
      await sleep(500);
      expect(answered).toBe(false);
      relay = spawn(LISTENER, [String(workspacePort), localDaemon()], { stdio: "ignore" });
      expect((await loaded).projectInstructions).toEqual([join(root, "AGENTS.md")]);
      // A key its client hands over is kept in memory alone.
      const keys = await host.get(Credentials, {});
      await host.root((ctx) => keys.setKey({ provider: "anthropic", key: "sk-handed-over" }, ctx));
      await until(keys.providers.subscribe.bind(keys.providers), (providers) => providers.some(({ provider }) => provider === "anthropic"));
      expect((await readdir(home, { recursive: true })).filter((name) => name.endsWith("auth.json"))).toEqual([]);
      // The owner's loop answers its client, with no budget set yet.
      const loop = await host.get(Loop, {});
      expect(await host.root((ctx) => loop.standing(ctx))).toMatchObject({ inUse: 0, weeklyBudgetUsd: null });
      await host.close();
      // Whoever runs the workspace asks before reclaiming it.
      expect(await (await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: "Bearer given" } })).json()).toEqual({ busy: false });
      // The service closes a link whose credential names nobody, as soon as it has looked.
      const other = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { authorization: "Bearer other" } });
      expect(await new Promise((resolve) => {
        other.addEventListener("close", () => resolve("closed"));
        setTimeout(() => resolve("kept"), 1_000);
      })).toBe("closed");
      child.kill("SIGTERM");
      expect((await once(child, "exit"))[0]).toBe(0);
    } finally {
      child.kill();
      relay?.kill();
    }
  }, 30_000);
});
