import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { Conversations, connect } from "@chopin-ai/harness-pi/protocol";
import { describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

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
});
