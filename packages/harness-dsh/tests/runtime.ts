import { randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import Agents, { type Agent } from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import Llm, { ToolCallId } from "@deepseek-ai/dsh-llm";
import Session, { SessionId } from "@deepseek-ai/dsh-session";
import Projection from "@deepseek-ai/dsh-session-projection";
import Skills from "@deepseek-ai/dsh-skill";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import * as Native from "@deepseek-ai/dsh-tool-executor-native";
import { onTestFinished } from "vitest";
import * as Harness from "../src/index.js";

/** Real framework services; these checks do not ask a model or establish disk persistence. */
export async function runtime(config: Harness.Config) {
  const root = new Context();
  onTestFinished(() => root.fiber.dispose());
  await Promise.all([
    root.plugin(Session), root.plugin(Projection), root.plugin(SystemPrompt), root.plugin(Skills),
    root.plugin(Tools), root.plugin(Llm), root.plugin(Agents), root.plugin(AgentLoop), root.plugin(Native),
  ]);
  const plugin = root.plugin(Harness, config);
  await plugin;
  const create = async (id = randomUUID()) => (await root.agents.create({ sessionId: SessionId(id), meta: { cwd: config.layer } })).agent;
  let step = 0;
  const call = async (agent: Agent, name: string, args: Record<string, unknown> = {}) => {
    const batch = await root.tools.execute({ calls: [{ type: "tool-call", id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) }], agent,
      signal: new AbortController().signal, log: { turn: 1, step: ++step },
    });
    if (batch.results.length !== 1) throw new Error("the actual executor did not settle its original call");
    return batch.results[0]!.result;
  };
  return { root, plugin, create, call };
}
