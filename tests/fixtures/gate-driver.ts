#!/usr/bin/env node
/**
 * e2e driver: boots the fixture composition, runs one turn and writes that turn's tool
 * calls and results to `./tool-trace.json` for the assertions to read.
 *
 * Erasable-syntax TypeScript only: it runs under Node's native type stripping.
 */

import { writeFile } from "node:fs/promises";
import { boot, resolveConfigPath } from "@deepseek-ai/dsh-app-boot";
import { runFixtureTurn } from "@deepseek-ai/dsh-loader-smoke";

const configPath = process.argv[2];
if (configPath === undefined) throw new Error("gate driver requires a config path");

interface TracedCall {
  callId: string;
  name: string;
}

interface TracedResult {
  callId: string;
  isError: boolean;
  text: string;
}

const calls: TracedCall[] = [];
const results: TracedResult[] = [];

const ctx = await boot("chopin-gate-e2e", resolveConfigPath(configPath, undefined));
try {
  await runFixtureTurn(ctx, {
    task: "investigate the reported hang",
    onEvent: (_sessionId, event) => {
      if (event.type === "tool/call") {
        calls.push({ callId: String(event.data.callId), name: event.data.name });
        return;
      }
      if (event.type !== "tool/result") return;
      const result = event.data.message;
      const text = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
      results.push({ callId: String(result.toolCallId), isError: result.isError === true, text });
    },
  });
} finally {
  await ctx.fiber.dispose();
}

await writeFile("./tool-trace.json", JSON.stringify({ calls, results }, null, 2));
