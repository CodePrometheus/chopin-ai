import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createModels } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { openCloudRuntime, type CloudConfiguration } from "../src/cloud.js";
import { Vault } from "../src/vault.js";

it.each(["wrong-key", "missing-native-store", "custody"])("refuses %s before loading any model or replacing protected data", async (fault) => {
  const root = await mkdtemp(join(tmpdir(), "chopin-cloud-admission-"));
  const volume = join(root, "volume"); const home = join(root, "home");
  await mkdir(volume); await mkdir(home);
  const key = randomBytes(32);
  const vault = await Vault.initialize(volume, home, key, async () => {}); await vault.close();
  const names = await readdir(volume, { recursive: true });
  const marker = await readFile(join(volume, "key-check"));
  const requests: string[] = [];
  const endpoint = createServer((request, response) => {
    requests.push(request.url!); request.resume();
    if (request.url === "/internal/v1/execution/key") { response.end(JSON.stringify({ revision: 1, serviceKey: key.toString("base64url") })); return; }
    response.end(JSON.stringify({ head: { sequence: 1, digest: Buffer.alloc(32).toString("base64url") }, pending: null }));
  });
  endpoint.listen(0, "127.0.0.1"); await once(endpoint, "listening");
  const url = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/`;
  const agentId = randomUUID(); let models = 0;
  const config: CloudConfiguration = {
    version: 1, purpose: "execution", keySource: fault === "custody" ? "custody" : "provided", volume, home, control: { url, agentId, epoch: 1, owner: "owner" },
    jobs: { transport: { url, scopeId: agentId }, domain: randomUUID(), cwd: "/workspace", policyRevision: "fixture", inheritEnv: false,
      policy: { pollAfterMs: 1, outputPageBytes: 1, scanPageSize: 1, output: { maxBytes: 64, maxLines: 2 } } },
    storage: { queueCapacity: 1, nativeModule: join(root, "no-module.node") },
    server: { port: 0 },
    model: { provider: "fixture", modelId: "fixture" }, reviewModel: { provider: "fixture", modelId: "fixture" }, goalRetryAfterMs: 1, vaultSyncMs: 1,
  };
  const given = fault === "custody" ? undefined : fault === "wrong-key" ? randomBytes(32) : Buffer.from(key);
  try {
    await expect(openCloudRuntime(config, { serviceKey: given, launchToken: "synthetic-launch", controlToken: "synthetic-control", jobToken: "synthetic-jobs" }, {
      models: async () => { models++; return createModels(); }, report: () => {},
    })).rejects.toThrow();
    expect(models).toBe(0); if (given !== undefined) expect(given.every((byte) => byte === 0)).toBe(true);
    expect(requests).toEqual(["/internal/v1/anchor/read", ...(fault === "custody" ? ["/internal/v1/execution/key"] : [])]);
    expect(await readdir(volume, { recursive: true })).toEqual(names);
    expect(await readFile(join(volume, "key-check"))).toEqual(marker);
  } finally { key.fill(0); await new Promise<void>((resolve) => endpoint.close(() => resolve())); }
});

it("validates the actual cloud CLI without reading ambient owner settings or printing invalid configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "chopin-cloud-cli-"));
  const home = join(root, "ambient"); await mkdir(home);
  await writeFile(join(home, "config.json"), JSON.stringify({ httpProxy: "synthetic-sensitive-invalid-proxy" }));
  const config = join(root, "runtime.json"); await writeFile(config, "{synthetic-sensitive-invalid-configuration");
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../dist/bin.js", import.meta.url)), "cloud", "--config", config], { env: { ...process.env, CHOPIN_HOME: home } }).catch((error: unknown) => error as { code: number; stdout: string; stderr: string });
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("the cloud configuration must be readable JSON");
  expect(result.stderr).not.toContain("synthetic-sensitive");
  expect(await readdir(home)).toEqual(["config.json"]);
});
