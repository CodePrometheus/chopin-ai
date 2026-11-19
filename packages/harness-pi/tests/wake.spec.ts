import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setImmediate } from "node:timers/promises";
import type { Wake } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { WakePublisher } from "../src/wake.js";

it("serializes host updates and observes the latest state after an outstanding response", async () => {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); const second = Promise.withResolvers<void>();
  const received: Wake[] = [];
  let concurrent = 0; let maximum = 0;
  const server = createServer(async (request, response) => {
    concurrent++; maximum = Math.max(maximum, concurrent);
    let body = ""; for await (const chunk of request) body += chunk;
    received.push(JSON.parse(body) as Wake);
    if (received.length === 1) { entered.resolve(); await release.promise; }
    concurrent--;
    response.end();
    if (received.length === 2) second.resolve();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  let current: Wake = { active: true };
  const errors: unknown[] = [];
  const publisher = new WakePublisher(async () => ({ ...current }), async (wake) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/wake`, { method: "POST", body: JSON.stringify(wake) });
    await response.arrayBuffer();
  }, (error) => errors.push(error));
  try {
    publisher.offer(); await entered.promise;
    current = { active: false, at: Date.now() }; publisher.offer();
    current = { active: false }; publisher.offer();
    await setImmediate();
    expect(received).toEqual([{ active: true }]);
    release.resolve(); await second.promise; await publisher.close();
    expect(received).toEqual([{ active: true }, { active: false }]);
    expect(maximum).toBe(1);
    expect(errors).toEqual([]);
  } finally { release.resolve(); await publisher.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("never turns an unavailable activity observation into an idle publication", async () => {
  const reported = Promise.withResolvers<void>(); const published = Promise.withResolvers<void>();
  let available = false;
  const sent: Wake[] = [];
  const publisher = new WakePublisher(async () => { if (!available) throw new Error("activity unavailable"); return { active: false }; }, (wake) => { sent.push(wake); published.resolve(); }, () => reported.resolve());
  try {
    publisher.offer(); await reported.promise; await setImmediate();
    expect(sent).toEqual([]);
    available = true; publisher.offer(); await published.promise;
    expect(sent).toEqual([{ active: false }]);
  } finally { await publisher.close(); }
});

it("does not suppress the same wake after a failed host acknowledgement", async () => {
  const reported = Promise.withResolvers<void>();
  let reachable = false; let calls = 0;
  const publisher = new WakePublisher(async () => ({ active: true }), async () => {
    calls++;
    if (!reachable) throw new Error("host acknowledgement unavailable");
  }, () => reported.resolve());
  try {
    publisher.offer(); await reported.promise; await setImmediate();
    expect(calls).toBe(1);
    reachable = true; publisher.offer(); await setImmediate(); await publisher.close();
    expect(calls).toBe(2);
  } finally { await publisher.close(); }
});
