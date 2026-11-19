import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import { defineExtension, defineTask, ROOT_CONVERSATION_ID, type Wake } from "@earendil-works/pi-durable";
import { AgentService, type AgentServiceOptions } from "../src/service.js";
import { openSealedStore } from "../src/sealed-store.js";
import { CALL_TIMEOUT_MS, type EngineCommand } from "../src/protocol.js";
import { GoalDoc } from "../src/goals/store.js";
import { localWorkspace } from "./local-workspace.js";

it.each(["wrong-key", "missing-adapter", "healthy"])("verifies storage before MCP processes or model catalog requests: %s", async (failure) => {
  const root = await mkdtemp(join(tmpdir(), "chopin-service-admission-"));
  const dir = join(root, "sealed");
  const key = randomBytes(32);
  const stored = await openSealedStore({ dir, key });
  await stored.close(context);
  const marker = join(root, "mcp-started");
  const fixture = new URL("./fixtures/echo-mcp.mjs", import.meta.url).href;
  const program = `await (await import("node:fs/promises")).writeFile(${JSON.stringify(marker)}, "started"); await import(${JSON.stringify(fixture)});`;
  let received = 0;
  const server = createServer((_request, response) => { received++; response.end("{}"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/catalog`;
  const requests: Promise<unknown>[] = [];
  const extensions: string[] = [];
  const models = createModels();
  const dataDir = join(root, "data");
  const absent = (() => undefined) as unknown as NonNullable<AgentServiceOptions["store"]>;
  const service = new AgentService({
    dataDir, workspaces: localWorkspace(root),
    models: () => { requests.push(fetch(url).then((response) => response.arrayBuffer())); return models; },
    extensions: (owner) => { extensions.push(owner); return []; },
    store: failure === "missing-adapter" ? absent : () => openSealedStore({ dir, key: failure === "wrong-key" ? randomBytes(32) : key }),
    layer: { instructions: undefined, skills: [], gates: [], mcpServers: { marker: { command: process.execPath, args: ["--input-type=module", "--eval", program] } } },
  });
  try {
    if (failure === "healthy") await service.harness("owner");
    else await expect(service.harness("owner")).rejects.toThrow();
    await Promise.all(requests);
    if (failure === "healthy") {
      expect(received).toBeGreaterThan(0);
      expect((await stat(marker)).isFile()).toBe(true);
      expect(extensions).toEqual(["owner"]);
    } else {
      expect(received).toBe(0);
      expect(extensions).toEqual([]);
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readdir(dataDir)).toEqual([]);
  } finally {
    await service.close(context);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it("keeps restored work paused until an admitted explicit resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "chopin-paused-service-"));
  const models = createModels(); const provider = fauxProvider(); models.setProvider(provider.provider); const model = provider.getModel();
  const agent = { model: { provider: model.provider, modelId: model.id } };
  const errors: unknown[] = [];
  let admitted = false;
  const options: AgentServiceOptions = {
    dataDir: join(root, "data"), workspaces: localWorkspace(root), models: () => models, startPaused: true,
    agent,
    goals: () => ({ authorize: async (request) => ({ allowed: request.action === "owner" && admitted }),
      review: async () => { throw new Error("review must not run before model authorization"); },
      settled: async () => {}, retryAfterMs: CALL_TIMEOUT_MS, report: (error) => errors.push(error),
    }),
  };
  const request = { version: 1, requestId: randomUUID(), command: { kind: "goal.submit", objective: "Keep the original pending goal", completionCriteria: ["A checked result"], grant: { id: "delegation", version: 1 } } } satisfies EngineCommand;
  const first = new AgentService(options);
  const original = await first.goals("owner");
  const receipt = await original.store.execute(request, agent, context);
  await first.close(context);
  const service = new AgentService(options);
  const goals = await service.goals("owner");
  try {
    await setImmediate();
    expect((await goals.store.snapshot(receipt.goalId, context)).status).toBe("accepted");
    await expect(goals.resume(context)).rejects.toThrow("current goal authority");
    expect((await goals.store.snapshot(receipt.goalId, context)).status).toBe("accepted");
    const watch = await goals.store.harness.watchDoc(GoalDoc, receipt.goalId, context);
    if (watch === undefined) throw new Error("the original persisted goal is missing");
    const waiting = new Promise<void>((resolve, reject) => {
      watch.start(async (change) => {
        if (change.kind === "failed") reject(change.error);
        else if (change.value.snapshot?.status === "waiting_authorization") resolve();
      });
    });
    admitted = true;
    try { await goals.resume(context); await waiting; }
    finally { await watch.stop(); }
    expect(await goals.store.request(request.requestId, context)).toEqual(receipt);
    expect((await goals.store.snapshot(receipt.goalId, context)).objective).toBe(request.command.objective);
    expect(provider.state.callCount).toBe(0);
    expect(errors).toEqual([]);
  } finally { await service.close(context); }
});

it("publishes the actual durable deadline and resumes original work when the host wakes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "chopin-service-wake-"));
  const marker = join(root, "completed"); const initial = Date.now(); const deadline = initial + CALL_TIMEOUT_MS;
  const clock = vi.spyOn(Date, "now").mockReturnValue(initial);
  const scheduled = Promise.withResolvers<void>();
  const observations: Wake[] = [];
  const task = defineTask<{ marker: string; deadline: number }, { phase: "arm" } | { phase: "write" }, null>({
    name: "fixture.host-wake", version: 1, initial: () => ({ phase: "arm" }), phases: {
      arm: async (task, runtime, ctx) => runtime.commit(() => ({ status: "sleeping", until: task.input.deadline, checkpoint: { phase: "write" } }), ctx),
      write: async (task, runtime, ctx) => { await writeFile(task.input.marker, "original task completed"); await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx); },
    },
    abort: async (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  const service = new AgentService({ dataDir: join(root, "data"), workspaces: localWorkspace(root), models: () => createModels(), extensions: [defineExtension({ name: "fixture.host-wake", tasks: [task] })],
    onWake: async (owner, wake) => { expect(owner).toBe("owner"); observations.push(wake); if (wake.at === deadline) scheduled.resolve(); },
  });
  try {
    const harness = await service.harness("owner"); await harness.root(context);
    const id = await harness.commit((tx) => tx.createTask(task, { marker, deadline }, { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID }), context);
    await scheduled.promise;
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    clock.mockReturnValue(deadline + 1);
    harness.resume();
    expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("completed");
    expect(await readFile(marker, "utf8")).toBe("original task completed");
    expect(observations.some((wake) => wake.at === deadline)).toBe(true);
  } finally { await service.close(context); clock.mockRestore(); }
});
