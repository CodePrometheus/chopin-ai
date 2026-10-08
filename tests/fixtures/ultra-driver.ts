#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { boot, resolveConfigPath } from "@deepseek-ai/dsh-app-boot";
import { runFixtureTurn } from "@deepseek-ai/dsh-loader-smoke";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

import { resetUltraTrace, ultraTrace } from "./ultra-mock-llm.ts";

const configPath = process.argv[2];
if (configPath === undefined) throw new Error("ultra driver requires a config path");

const ctx = await boot("chopin-ultra-e2e", resolveConfigPath(configPath, undefined));
let trace: Record<string, unknown> = {};
let persistedSessionId: SessionId | undefined;
try {
  // Configured agents start in the background; wait for the first one instead of reading an empty registry.
  if (ctx.agents.roots().length === 0) await new Promise<void>((resolve) => {
    const dispose = ctx.on("agent/created", () => { dispose(); resolve(); });
  });
  const agent = ctx.agents.roots()[0];
  if (agent === undefined) throw new Error("ultra fixture requires one root agent");
  const signal = new AbortController().signal;
  let selectedRoute = { provider: "chopin-ultra-current", model: "current-model" };
  agent.ctx.on("agent/request", async (_payload, next) => ({
    ...await next(),
    ...selectedRoute,
  }));
  agent.ctx.on("session/event", (session, event) => {
    if (
      session === agent.session
      && event.type === "tool/result"
      && String(event.data.message.toolCallId) === "ultra-e2e-delegate"
    ) selectedRoute = { provider: "chopin-ultra-active-next", model: "active-next-model" };
  });
  await runFixtureTurn(ctx, { task: "seed the effective current route" });
  resetUltraTrace();

  const createDirectChild = () => agent.ctx.agents.create({
    sessionId: SessionId(randomUUID()),
    meta: {
      ...(agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd }),
      parentSession: agent.session.id,
      origin: "subagent",
      delegationDepth: 1,
    },
    agentOptions: { provider: "chopin-ultra-initial", model: "initial-model" },
  });
  const ordinaryHandle = await createDirectChild();

  const enabled = await ctx.commands.execute(agent, "/mode ultra", [], signal);
  const toolWhileEnabled = ctx.tools.get("ultra_delegate", agent) !== undefined;
  const subagentWhileEnabled = ctx.tools.get("subagent", agent) !== undefined;

  let ordinaryOutput = "";
  try {
    ordinaryHandle.agent.followup(createUserMessage({
      content: [{ type: "text", text: "Complete one ordinary child turn." }],
      source: { kind: "user" },
    }));
    await ordinaryHandle.agent.whenIdle();
    const ordinary = ordinaryHandle.agent.session.snapshotEvents().findLast((event) => event.type === "assistant/message");
    ordinaryOutput = ordinary?.type === "assistant/message"
      ? ordinary.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("")
      : "";
  } finally {
    await ordinaryHandle.dispose();
  }

  const blockedHandle = await createDirectChild();
  const blockedSessionId = String(blockedHandle.agent.session.id);
  let blockedChildReason = "missing";
  try {
    blockedHandle.agent.followup(createUserMessage({
      content: [{ type: "text", text: "This post-activation direct child must not run." }],
      source: { kind: "user" },
    }));
    await blockedHandle.agent.whenIdle();
    const blockedEnd = blockedHandle.agent.session.snapshotEvents().findLast((event) => event.type === "turn/end");
    blockedChildReason = blockedEnd?.type === "turn/end" ? blockedEnd.data.reason.kind : "missing";
  } finally {
    await blockedHandle.dispose();
  }

  const turn = await runFixtureTurn(ctx, { task: "analyze alpha and beta in parallel" });
  const result = agent.session.snapshotEvents().findLast((event) =>
    event.type === "tool/result" && String(event.data.message.toolCallId) === "ultra-e2e-delegate");
  const resultBlock = result?.type === "tool/result" ? result.data.message : undefined;
  const resultText = resultBlock?.content.filter((block) => block.type === "text").map((block) => block.text).join("") ?? "";
  const ultraEntry = [...ctx.loader.entries()].find((entry) => entry.options.id === "ultra-mode");
  if (ultraEntry === undefined) throw new Error("ultra fixture could not find its loader entry");
  await ultraEntry.update({ disabled: true });
  await ultraEntry.update({ disabled: false });
  const modeAfterReload = await ctx.commands.execute(agent, "/mode", [], signal);
  const toolAfterReload = ctx.tools.get("ultra_delegate", agent) !== undefined;
  const disabled = await ctx.commands.execute(agent, "/mode standard", [], signal);
  const toolAfterDisable = ctx.tools.get("ultra_delegate", agent) !== undefined;
  const subagentAfterDisable = ctx.tools.get("subagent", agent) !== undefined;
  selectedRoute = { provider: "chopin-ultra-next", model: "next-model" };
  const standardTurn = await runFixtureTurn(ctx, { task: "continue in standard mode" });
  const standardFollowup = await runFixtureTurn(ctx, { task: "confirm standard mode remains restored" });
  await ctx.sessions.flush(agent.session);
  persistedSessionId = agent.session.id;
  const stateDirs = await readdir(".ultra-state");
  if (stateDirs.length !== 1) throw new Error(`ultra fixture expected one session state directory, got ${stateDirs.length}`);
  const stateDir = join(".ultra-state", stateDirs[0] as string);
  const stateFiles = (await readdir(stateDir)).filter((file) => file.endsWith(".jsonl")).sort();
  if (stateFiles.length < 3) throw new Error(`ultra fixture expected an append-only state history, got ${stateFiles.length} event(s)`);
  const stateLines = (await readFile(join(stateDir, stateFiles.at(-1) as string), "utf8")).trim().split("\n");
  const ultraEffortState = (JSON.parse(stateLines.at(-1) as string) as { state: string }).state;
  trace = {
    rootSessionId: String(agent.session.id),
    enabled: enabled?.result,
    disabled: disabled?.result,
    toolWhileEnabled,
    toolAfterDisable,
    subagentWhileEnabled,
    subagentAfterDisable,
    modeAfterReload: modeAfterReload?.result,
    toolAfterReload,
    output: turn.output,
    ordinaryOutput,
    blockedChildReason,
    blockedSessionId,
    standardOutput: standardTurn.output,
    standardFollowupOutput: standardFollowup.output,
    ultraEffortState,
    resultText,
    requests: ultraTrace.requests,
    maxConcurrentWorkers: ultraTrace.maxConcurrentWorkers,
  };
} finally {
  await ctx.fiber.dispose();
}

if (persistedSessionId === undefined) throw new Error("ultra fixture did not retain its persisted session id");
const coldCtx = await boot("chopin-ultra-cold-read", resolveConfigPath(configPath, undefined));
try {
  const cold = await coldCtx.sessionPersistence.open(persistedSessionId, "read");
  try {
    trace.coldReadEventCount = (await cold.read()).events.length;
  } finally {
    await cold.close();
  }
} finally {
  await coldCtx.fiber.dispose();
}

await writeFile("./ultra-trace.json", JSON.stringify(trace, null, 2));
