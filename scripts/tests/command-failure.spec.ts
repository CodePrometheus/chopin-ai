import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Context } from "@deepseek-ai/cordis";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";

import { satisfiedTools } from "../../packages/gate/src/index.js";
import { observeToolFailure } from "../../packages/evolution-observer/src/index.js";
import * as toolset from "../../packages/toolset/src/index.js";

const require = createRequire(import.meta.url);
const promptPath = require.resolve("@deepseek-ai/dsh-system-prompt", {
  paths: [dirname(require.resolve("@deepseek-ai/dsh-tools"))],
});
const { default: SystemPrompt } = await import(pathToFileURL(promptPath).href);

describe("command results feed gates and failure capture", () => {
  it.each([0, 7])("real exit code %i keeps its success or failure meaning in the tool log", async (exitCode) => {
    const ctx = new Context();
    try {
      await ctx.plugin(SystemPrompt, {});
      await ctx.plugin(ToolRuntime);
      await ctx.plugin(toolset, {
        dirs: [resolve("toolsets")],
        toolsets: ["engineering"],
        vars: { REPO_PATH: process.cwd(), TEST_COMMAND: `exit ${exitCode}` },
      });
      const result = await ctx.tools.execute({
        name: "run_tests", arguments: {}, callId: "command-result" as never,
        signal: new AbortController().signal,
      });
      expect(result.isError).toBe(exitCode !== 0);
      if (exitCode !== 0) expect(result.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("command failed (exit 7)") }),
      ]));
      const events = [
        { type: "tool/call", seq: 1, time: 1_000, data: { turn: 1, step: 1, name: "run_tests", callId: "command-result", arguments: "{}" } },
        { type: "tool/result", seq: 2, time: 2_000, data: { turn: 1, step: 1, message: {
          role: "tool", toolCallId: "command-result", isError: result.isError, content: result.content,
        } } },
      ] as unknown as SessionEvent[];
      const session = { id: "command-session", snapshotEvents: () => events } as unknown as Session;
      expect(satisfiedTools(session).has("run_tests")).toBe(exitCode === 0);
      const observed = observeToolFailure(session, events[1] as Extract<SessionEvent, { type: "tool/result" }>);
      expect(observed !== undefined).toBe(exitCode !== 0);
      if (observed !== undefined) expect(observed.type).toBe("candidate.observed");
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
