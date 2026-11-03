import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LoopbackWorkspaceProvider } from "../src/index.js";

const LISTENER = fileURLToPath(new URL("../loopback-listener.sh", import.meta.url));
const hasRelay = spawnSync("socat", ["-V"]).status === 0;

/** A loopback port nothing listens on now. */
async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A daemon that greets as the real one does and then echoes, so the stream through the listener can be checked whole. */
async function echoDaemon(dir: string): Promise<string> {
  const path = join(dir, "daemon");
  await writeFile(path, '#!/bin/sh\n[ "$1" = serve ] && [ "$2" = --token ] || exit 3\nprintf "PI-ENV %s\\n" "$3"\nexec cat\n');
  await chmod(path, 0o755);
  return path;
}

/** Everything the daemon, reached through the workspace's launch, writes back for `input`. */
async function through(provider: LoopbackWorkspaceProvider, daemon: string, token: string, input: string): Promise<string> {
  const [binary, ...args] = provider.open("local").command([daemon]).argv;
  const child = spawn(binary ?? "", [...args, "serve", "--token", token], { stdio: ["pipe", "pipe", "inherit"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stdin.end(input);
  await once(child, "close");
  return output;
}

describe("LoopbackWorkspaceProvider", () => {
  const listeners: ChildProcess[] = [];
  afterEach(() => {
    for (const listener of listeners.splice(0)) listener.kill();
  });

  it("runs only its execution daemon and leaves its lifecycle to whoever runs it", async () => {
    const port = await freePort();
    const workspace = new LoopbackWorkspaceProvider({ port, root: "/workspace", daemon: "/bin/pi-env" }).open("local");
    expect(workspace.root).toBe("/workspace");
    expect(workspace.command(["/bin/pi-env"]).argv.at(-1)).toBe(String(port));
    expect(() => workspace.command(["git", "status"])).toThrow("runs only its execution daemon");
    expect(() => workspace.command(["/bin/pi-env"], { TOKEN: "x" })).toThrow("runs only its execution daemon");
    await expect(workspace.stop()).rejects.toThrow("started and stopped by whoever runs it");
    await expect(workspace.destroy()).rejects.toThrow("started and stopped by whoever runs it");
    expect(await workspace.state()).toBe("stopped");
    await expect(new LoopbackWorkspaceProvider({ port, root: "/", daemon: "d", startTimeoutMs: 300 }).open("local").start())
      .rejects.toThrow("no workspace listener answered");
    expect(() => new LoopbackWorkspaceProvider({ port: 70_000, root: "/", daemon: "d" })).toThrow("is no port");
    // The listener says how it is run rather than failing on what is missing.
    const unused = spawnSync(LISTENER, [], { encoding: "utf8" });
    expect(unused.status).toBe(2);
    expect(unused.stderr).toContain("usage: loopback-listener.sh <port> <daemon>");
  });

  describe.runIf(hasRelay)("through the listener", () => {
    it("starts the daemon for each connection under the token its first line carries", async () => {
      const dir = await mkdtemp(join(tmpdir(), "chopin-loopback-"));
      const port = await freePort();
      const daemon = await echoDaemon(dir);
      const provider = new LoopbackWorkspaceProvider({ port, root: dir, daemon });
      const workspace = provider.open("local");
      expect(await workspace.state()).toBe("stopped");

      listeners.push(spawn(LISTENER, [String(port), daemon], { stdio: "inherit" }));
      await workspace.start();
      expect(await workspace.state()).toBe("running");

      expect(await through(provider, daemon, "a1b2", "one\ntwo\n")).toBe("PI-ENV a1b2\none\ntwo\n");
      // Each connection gets a daemon of its own.
      expect(await through(provider, daemon, "c3d4", "three\n")).toBe("PI-ENV c3d4\nthree\n");
      // A token that is not hexadecimal never reaches the daemon's command line.
      expect(await through(provider, daemon, "0a; echo injected", "four\n")).toBe("");
    });
  });
});
