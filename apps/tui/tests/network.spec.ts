import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConfiguredProxy } from "../src/network.js";

/** A server answering every request with `name` and the address it was asked for, as a proxy sees it. */
async function answering(name: string): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => response.end(`${name} ${request.url}`));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function setUp(env: Record<string, string | undefined>, settings: object = {}) {
  const proxy = await answering("proxy");
  const direct = await answering("direct");
  servers.push(proxy.server, direct.server);
  const home = await mkdtemp(join(tmpdir(), "chopin-network-"));
  await writeFile(join(home, "config.json"), JSON.stringify(settings).replaceAll("PROXY", proxy.url));
  vi.stubEnv("CHOPIN_HOME", home);
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value?.replaceAll("PROXY", proxy.url));
  return { direct };
}

describe("the configured proxy", () => {
  it("carries requests to other hosts, and leaves this machine's own alone", async () => {
    const { direct } = await setUp({ HTTP_PROXY: "PROXY" });
    await useConfiguredProxy();
    expect(await (await fetch("http://provider.example.test/v1/models")).text()).toBe("proxy http://provider.example.test/v1/models");
    expect(await (await fetch(`${direct.url}/own`)).text()).toBe("direct /own");
  });

  it("comes from the settings when no variable names one", async () => {
    await setUp({}, { httpProxy: "PROXY" });
    await useConfiguredProxy();
    expect(await (await fetch("http://provider.example.test/")).text()).toBe("proxy http://provider.example.test/");
  });
});
