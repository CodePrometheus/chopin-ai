#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

import { boot, resolveConfigPath } from "@deepseek-ai/dsh-app-boot";
import { runFixtureTurn } from "@deepseek-ai/dsh-loader-smoke";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

import {
  activateEvolutionFixtureV2,
  rollbackEvolutionFixtureToV1,
  seedEvolutionFixture,
} from "./evolution-seed.ts";

const configPath = process.argv[2];
if (configPath === undefined) throw new Error("evolution driver requires a config path");

const calls: Array<{ callId: string; name: string }> = [];
const results: Array<{ callId: string; isError: boolean; text: string }> = [];
const sessionIds: string[] = [];
const contexts: string[] = [];
await seedEvolutionFixture();
const ctx = await boot("chopin-evolution-e2e", resolveConfigPath(configPath, undefined));
ctx.chopinEvolution.registerFactProvider(() => ({ taskKinds: ["fixture-work"] }));
const onEvent = (_sessionId: string, event: SessionEvent) => {
  if (event.type === "user/message" && event.data.source.kind === "runtime-context" && event.data.source.form === "snapshot") {
    contexts.push(...event.data.source.sections.filter((section) => section.name.endsWith(":version_note")).map((section) => section.text));
  }
  if (event.type === "tool/call") {
    calls.push({ callId: String(event.data.callId), name: event.data.name });
    return;
  }
  if (event.type !== "tool/result") return;
  const result = event.data.message;
  results.push({
    callId: String(result.toolCallId),
    isError: result.isError === true,
    text: result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join(""),
  });
};
try {
  const first = await runFixtureTurn(ctx, {
    task: "use the learned capability",
    onEvent,
  });
  sessionIds.push(String(first.sessionId));

  await activateEvolutionFixtureV2();
  const second = await runFixtureTurn(ctx, { task: "use the upgraded learned capability", onEvent });
  sessionIds.push(String(second.sessionId));

  await rollbackEvolutionFixtureToV1();
  const third = await runFixtureTurn(ctx, { task: "use the rolled-back learned capability", onEvent });
  sessionIds.push(String(third.sessionId));
} finally {
  await ctx.fiber.dispose();
}
await writeFile("./tool-trace.json", JSON.stringify({ calls, results, sessionIds, contexts }, null, 2));
