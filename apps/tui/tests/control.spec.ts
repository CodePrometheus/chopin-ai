import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from "undici";
import { expect, it } from "vitest";
import { ControlHost } from "../src/control.js";

async function listen(server: Server, protocol = "http") {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `${protocol}://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
const binding = { agentId: "synthetic-agent", epoch: 1, owner: "synthetic-owner" };

it("rejects a timeout that Node would silently replace with one millisecond", async () => {
  const configuration = { url: "http://127.0.0.1/", ...binding, requestTimeoutMs: 0x8000_0000 };
  await expect(ControlHost.connect(configuration, "synthetic-control-credential")).rejects.toThrow("the control binding does not satisfy its versioned contract");
});

it("checks current dispatch authority and publishes a content-free wake acknowledgement", async () => {
  const received: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    received.push(JSON.parse(body) as unknown);
    if (request.url?.endsWith("/wake")) response.writeHead(204).end();
    else response.end(JSON.stringify({ allowed: false, reason: "current delegation refused" }));
  });
  const target = await listen(server);
  const host = await ControlHost.connect({ url: target.url, ...binding }, "synthetic-control-credential");
  try {
    expect(await host.authorize({ action: "model", goalId: "execution-owned-goal", grant: { id: "original-delegation", version: 2 } })).toEqual({ allowed: false, reason: "current delegation refused" });
    await host.publishWake({ active: true });
    expect(received).toEqual([{ ...binding, action: "model", grant: { id: "original-delegation", version: 2 } }, { ...binding, wake: { active: true } }]);
  } finally { await host.close(); await target.close(); }
});

it("keeps its original identity and control requests outside the ambient proxy", async () => {
  const observed: { path?: string; body: unknown; authorization?: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    observed.push({ path: request.url, body: JSON.parse(body) as unknown, authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ allowed: true }));
  });
  const target = await listen(server);
  let proxied = 0;
  const proxyServer = createServer((_request, response) => { proxied++; response.writeHead(502).end(); });
  proxyServer.on("connect", (_request, socket) => { proxied++; socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); });
  const proxy = await listen(proxyServer);
  const original = getGlobalDispatcher(); const agent = new ProxyAgent(proxy.url);
  const configuration = { url: `${target.url}mount/`, ...binding };
  const host = await ControlHost.connect(configuration, "synthetic-control-credential");
  setGlobalDispatcher(agent);
  try {
    configuration.owner = "changed-owner";
    configuration.epoch = 2;
    await expect(host.initialization("original-operation").verifyCreation()).resolves.toBeUndefined();
    expect(proxied).toBe(0);
    expect(observed).toEqual([{ path: "/mount/internal/v1/initialization/verify", body: { ...binding, operationId: "original-operation" }, authorization: "Bearer synthetic-control-credential" }]);
  } finally { setGlobalDispatcher(original); await host.close(); await agent.close(); await target.close(); await proxy.close(); }
});

it("refuses redirects without forwarding the control credential", async () => {
  let forwarded = 0;
  const destination = await listen(createServer((_request, response) => { forwarded++; response.end(JSON.stringify({ allowed: true })); }));
  const source = await listen(createServer((_request, response) => { response.writeHead(307, { location: destination.url }); response.end(); }));
  const host = await ControlHost.connect({ url: source.url, ...binding }, "synthetic-control-credential");
  try {
    await expect(host.initialization("operation").verifyCreation()).rejects.toThrow("could not be observed");
    expect(forwarded).toBe(0);
  } finally { await host.close(); await source.close(); await destination.close(); }
});

it("obtains only a canonical execution key lease through its private fixed binding", async () => {
  const original = Buffer.alloc(32, 17);
  const bodies: unknown[] = [];
  let serviceKey = original.toString("base64url");
  const target = await listen(createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    bodies.push(JSON.parse(body) as unknown);
    expect(request.url).toBe("/internal/v1/execution/key");
    expect(request.headers.authorization).toBe("Bearer synthetic-control-credential");
    response.end(JSON.stringify({ revision: 2, serviceKey }));
  }));
  const host = await ControlHost.connect({ url: target.url, ...binding }, "synthetic-control-credential");
  try {
    const lease = await host.executionKey(); expect(lease.revision).toBe(2); expect(lease.key).toEqual(original); lease.key.fill(0);
    serviceKey += "=";
    await expect(host.executionKey()).rejects.toThrow("invalid execution key lease");
    serviceKey = Buffer.alloc(31).toString("base64url");
    await expect(host.executionKey()).rejects.toThrow("invalid execution key lease");
    expect(bodies).toEqual([binding, binding, binding]);
  } finally { original.fill(0); await host.close(); await target.close(); }
});

it("distinguishes authoritative absence from unavailable observation without retrying", async () => {
  let status = 404; let calls = 0;
  const target = await listen(createServer((_request, response) => { calls++; response.writeHead(status); response.end("synthetic-sensitive-response-body"); }));
  const host = await ControlHost.connect({ url: target.url, ...binding }, "synthetic-control-credential");
  try {
    expect(await host.anchors().read()).toBeUndefined();
    status = 503;
    const error = await host.anchors().read().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("503");
    expect((error as Error).message).not.toContain("synthetic-sensitive-response-body");
    expect(calls).toBe(2);
  } finally { await host.close(); await target.close(); }
});

it("enforces the configured response budget against an actual HTTP body", async () => {
  const body = JSON.stringify({ head: { sequence: 0, digest: Buffer.alloc(32).toString("base64url") }, pending: null });
  const target = await listen(createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(body); }));
  const host = await ControlHost.connect({ url: target.url, ...binding, maxResponseBytes: Buffer.byteLength(body) - 1 }, "synthetic-control-credential");
  try { await expect(host.anchors().read()).rejects.toThrow(); }
  finally { await host.close(); await target.close(); }
});

it("refuses a personal credential claim before sending anything over HTTP", async () => {
  let calls = 0;
  const target = await listen(createServer((_request, response) => { calls++; response.writeHead(204).end(); }));
  const host = await ControlHost.connect({ url: target.url, ...binding }, "synthetic-control-credential");
  try {
    await expect(host.claimPersonalCredentialChange("00000000-0000-4000-8000-000000000001")).rejects.toThrow("require a trusted HTTPS endpoint");
    expect(calls).toBe(0);
  } finally { await host.close(); await target.close(); }
});

it("uses the host's declared certificate authority and never disables verification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chopin-control-tls-"));
  const key = join(directory, "key.pem"); const cert = join(directory, "certificate.pem"); const config = join(directory, "request.conf");
  await writeFile(config, "[req]\nprompt=no\ndistinguished_name=subject\nx509_extensions=extensions\n[subject]\nCN=localhost\n[extensions]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n");
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-config", config]);
  const server = createSecureServer({ key: await readFile(key), cert: await readFile(cert) }, (_request, response) => response.end(JSON.stringify({ allowed: true })));
  const target = await listen(server, "https");
  const untrusted = await ControlHost.connect({ url: target.url, ...binding }, "synthetic-control-credential");
  const trusted = await ControlHost.connect({ url: target.url, ...binding, caFile: cert }, "synthetic-control-credential");
  try {
    await expect(untrusted.initialization("operation").verifyCreation()).rejects.toThrow("could not be observed");
    await trusted.initialization("operation").verifyCreation();
  } finally { await untrusted.close(); await trusted.close(); await target.close(); }
});
