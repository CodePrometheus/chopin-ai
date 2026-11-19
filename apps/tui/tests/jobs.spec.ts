import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import type { JobOutput, JobRequest, JobSnapshot } from "@chopin-ai/harness-pi";
import { JobClient } from "../src/jobs.js";

const wire: { requests: JobRequest[]; snapshots: JobSnapshot[]; output: JobOutput[] } = JSON.parse(await readFile(new URL("../../../crates/job-broker/contracts.json", import.meta.url), "utf8"));
const snapshot = wire.snapshots[0]!;
const operation = snapshot.operationId;
const credential = "synthetic-command-credential";
async function serve(answer: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => { void Promise.resolve(answer(request, response)).catch(() => response.destroy()); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const configuration = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/commands/`, scopeId: snapshot.scopeId };
  return { server, configuration, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

it("uses the exact original command, fixed scope and operation routes", async () => {
  const calls: { method?: string; path?: string; authorization?: string; body: unknown }[] = [];
  const target = await serve(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body: body === "" ? null : JSON.parse(body) as unknown });
    response.end(JSON.stringify(request.url?.includes("/output?") ? wire.output[0] : snapshot));
  });
  const client = await JobClient.connect(target.configuration, credential);
  const original = structuredClone(wire.requests[0]!);
  try {
    target.configuration.scopeId = wire.requests[0]!.domain;
    const submission = client.submit(operation, original);
    original.argv.push("changed-after-submission");
    expect(await submission).toEqual(snapshot);
    expect(await client.get(operation)).toEqual(snapshot);
    await client.cancel(operation, wire.requests[0]!);
    await client.reconcile(operation);
    await client.stop(operation);
    const page = await client.output(operation, 3, "opaque+/=cursor");
    expect(Buffer.from(page.data, "base64url")).toEqual(Buffer.from([0, 255, 10]));
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["PUT", `/commands/${operation}`], ["GET", `/commands/${operation}`], ["POST", `/commands/${operation}/cancel`],
      ["POST", `/commands/${operation}/reconcile`], ["DELETE", `/commands/${operation}`],
      ["GET", `/commands/${operation}/output?limit=3&cursor=opaque%2B%2F%3Dcursor`],
    ]);
    expect(calls.every((call) => call.authorization === `Bearer ${credential}`)).toBe(true);
    expect(calls[0]!.body).toEqual(wire.requests[0]);
    expect(calls[2]!.body).toEqual(wire.requests[0]);
  } finally { await client.close(); await target.close(); }
});

it("does not replay an accepted command after losing its actual HTTP response", async () => {
  let submitted = 0; let observed = 0;
  const target = await serve((request, response) => {
    if (request.method === "PUT") { submitted++; request.resume(); response.destroy(); }
    else { observed++; response.end(JSON.stringify(snapshot)); }
  });
  const client = await JobClient.connect(target.configuration, credential);
  try {
    await expect(client.submit(operation, wire.requests[0]!)).rejects.toThrow("could not be observed");
    expect(submitted).toBe(1); expect(observed).toBe(0);
    await client.close();
    const reopened = await JobClient.connect(target.configuration, credential);
    try { expect(await reopened.get(operation)).toEqual(snapshot); }
    finally { await reopened.close(); }
    expect(submitted).toBe(1); expect(observed).toBe(1);
  } finally { await client.close(); await target.close(); }
});

it("cancels an interrupted response wait without stopping or resubmitting the original command", async () => {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const methods: string[] = [];
  const target = await serve(async (request, response) => {
    request.resume(); methods.push(request.method!);
    if (request.method === "PUT") {
      response.writeHead(200, { "content-type": "application/json" }); response.flushHeaders();
      entered.resolve(); await release.promise;
    }
    response.end(JSON.stringify(snapshot));
  });
  const client = await JobClient.connect(target.configuration, credential);
  const stop = new AbortController();
  try {
    const waiting = client.submit(operation, wire.requests[0]!, stop.signal);
    const observed = expect(waiting).rejects.toThrow();
    await entered.promise; stop.abort(); await observed; release.resolve();
    expect(await client.get(operation)).toEqual(snapshot);
    expect(methods).toEqual(["PUT", "GET"]);
  } finally { release.resolve(); await client.close(); await target.close(); }
});

it("rejects snapshots for a different scope or operation", async () => {
  let current = snapshot;
  const target = await serve((_request, response) => { response.end(JSON.stringify(current)); });
  const client = await JobClient.connect(target.configuration, credential);
  try {
    expect(await client.get(operation)).toEqual(snapshot);
    current = { ...snapshot, operationId: wire.requests[0]!.domain };
    await expect(client.get(operation)).rejects.toThrow("another operation");
    current = { ...snapshot, scopeId: wire.requests[0]!.domain };
    await expect(client.get(operation)).rejects.toThrow("another operation");
  } finally { await client.close(); await target.close(); }
});

it("distinguishes missing originals from unknown outcomes without exposing response content", async () => {
  let status = 404; let body = "synthetic-sensitive-response"; let calls = 0;
  const target = await serve((_request, response) => { calls++; response.writeHead(status); response.end(body); });
  const client = await JobClient.connect(target.configuration, credential);
  try {
    expect(await client.get(operation)).toBeUndefined();
    await expect(client.stop(operation)).rejects.toMatchObject({ status: 404 });
    status = 503;
    const error = await client.get(operation).catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 503 });
    expect(String(error)).not.toContain(body);
    status = 200; body = "{synthetic-sensitive-invalid-json";
    await expect(client.get(operation)).rejects.toThrow("unreadable response");
    expect(calls).toBe(4);
  } finally { await client.close(); await target.close(); }
});

it("validates command and byte representations before returning or dispatching them", async () => {
  let output: unknown = wire.output[0]; let calls = 0;
  const target = await serve((_request, response) => { calls++; response.end(JSON.stringify(output)); });
  const client = await JobClient.connect(target.configuration, credential);
  try {
    await expect(client.output(operation, 3)).resolves.toEqual(wire.output[0]);
    output = { ...wire.output[0], data: "AB" };
    await expect(client.output(operation, 3)).rejects.toThrow("invalid byte encoding");
    output = { ...wire.output[0], stream: null };
    await expect(client.output(operation, 3)).rejects.toThrow("invalid byte encoding");
    await expect(client.submit(operation, { ...wire.requests[0]!, env: { "INVALID=NAME": "value" } })).rejects.toThrow("command intent");
    expect(calls).toBe(3);
    await expect(client.submit(operation, { ...wire.requests[0]!, argv: ["with\0nul"] })).rejects.toThrow("command intent");
    await expect(client.get("../another-operation")).rejects.toThrow("canonical UUID");
    await expect(client.get(`${operation}\n`)).rejects.toThrow("canonical UUID");
    await expect(client.output(operation, 0)).rejects.toThrow("positive byte count");
    expect(calls).toBe(3);
  } finally { await client.close(); await target.close(); }
});

it("does not follow redirects or leak the purpose-bound command credential", async () => {
  let forwarded = 0;
  const destination = await serve((_request, response) => { forwarded++; response.end(JSON.stringify(snapshot)); });
  const target = await serve((_request, response) => { response.writeHead(307, { location: destination.configuration.url }); response.end(); });
  const client = await JobClient.connect(target.configuration, credential);
  try {
    await expect(client.submit(operation, wire.requests[0]!)).rejects.toThrow("could not be observed");
    expect(forwarded).toBe(0);
  } finally { await client.close(); await target.close(); await destination.close(); }
});

it("enforces the configured response budget on the command transport", async () => {
  const body = JSON.stringify(snapshot);
  const target = await serve((_request, response) => { response.end(body); });
  const client = await JobClient.connect({ ...target.configuration, maxResponseBytes: Buffer.byteLength(body) - 1 }, credential);
  try { await expect(client.get(operation)).rejects.toThrow(); }
  finally { await client.close(); await target.close(); }
});
