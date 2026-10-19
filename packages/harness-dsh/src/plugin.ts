import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gateRefusal, loadLayer, skillBody, unmetGates, withChopinMeta, type GateRule, type McpServer, type Skill, type TranscriptEntry } from "@chopin-ai/core";
import type { Context } from "@deepseek-ai/cordis";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import type { Usage as AcpUsage } from "@agentclientprotocol/sdk";
import type { SessionEvent, TurnEndReason } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-projection";
import type { SkillCandidate, SkillProvider } from "@deepseek-ai/dsh-skill";
import Schema from "@deepseek-ai/schemastery";
import { z } from "zod";
import { eventUpdates, stopReason } from "./acp.js";

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionStateMap {
    "chopin.succeeded": { calls: Record<string, string>; tools: string[] };
  }
}

export const name = "@chopin-ai/harness-dsh";
export const inject = ["tools", "systemPrompt", "skills", "sessionProjections"];

export interface Config {
  /** The mutable layer directory. */
  layer: string;
  /** Where each session's ACP transcript is written, one `<session>.jsonl` per session. */
  transcripts?: string;
}

export const Config: Schema<Config> = Schema.object({
  layer: Schema.string().required().description("The mutable layer directory"),
  transcripts: Schema.string().description("Directory receiving one ACP transcript per session"),
});

/** Loads the portable layer into the harness: instructions, skills, MCP servers and gates, and records transcripts in ACP. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const result = await loadLayer(resolve(config.layer));
  if (!result.ok) throw new Error(`invalid layer ${config.layer}:\n${result.problems.join("\n")}`);
  const { instructions, skills, mcpServers, gates } = result.layer;
  if (instructions !== undefined) {
    ctx.systemPrompt.section({ name: "chopin:guidance", order: 9000, text: instructions, interpolate: false });
  }
  if (skills.length > 0) ctx.skills.registerProvider(() => skillProvider(skills));
  for (const [serverName, server] of Object.entries(mcpServers)) ctx.plugin(McpClient, mcpConfig(serverName, server));
  if (gates.length > 0) enforceGates(ctx, gates);
  if (config.transcripts !== undefined) recordTranscripts(ctx, resolve(config.transcripts));
}

function skillProvider(skills: readonly Skill[]): SkillProvider {
  const candidates: SkillCandidate[] = skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    path: join(skill.directory, "SKILL.md"),
    invocation: { modelInvocable: true, userInvocable: true },
    source: "custom",
    provider: "chopin-layer",
    resourceBase: { kind: "directory", path: skill.directory },
    rank: 0,
    locator: skill.directory,
  }));
  return {
    name: "chopin-layer",
    list: async () => candidates,
    get: async (candidate) => {
      const text = await readFile(join(candidate.locator as string, "SKILL.md"), "utf8");
      return { ...candidate, content: skillBody(text) };
    },
  };
}

function mcpConfig(serverName: string, server: McpServer) {
  if ("command" in server) return { transport: "stdio" as const, serverName, command: server.command, args: server.args ?? [], env: server.env ?? {} };
  return { transport: "streamable-http" as const, serverName, url: server.url, headers: server.headers ?? {} };
}

/**
 * Gates read which tools have succeeded from the session log, through a projection that resume and fork replay,
 * and refuse through the monotonic guard, which no later listener can relax.
 */
function enforceGates(ctx: Context, gates: readonly GateRule[]): void {
  ctx.sessionProjections.register({
    key: "chopin.succeeded",
    stateVersion: 1,
    stateSchema: z.object({ calls: z.record(z.string(), z.string()), tools: z.array(z.string()) }),
    init: () => ({ calls: {}, tools: [] }),
    apply: (state, event) => {
      if (event.type === "tool/call") return { ...state, calls: { ...state.calls, [event.data.callId]: event.data.name } };
      if (event.type !== "tool/result") return state;
      const { [event.data.message.toolCallId]: tool, ...calls } = state.calls;
      const succeeded = tool !== undefined && event.data.message.isError !== true && !state.tools.includes(tool);
      return { calls, tools: succeeded ? [...state.tools, tool] : state.tools };
    },
  });
  ctx.tools.guard((execution) => {
    const session = execution.agent?.session;
    if (session === undefined) return undefined;
    const succeeded = new Set(ctx.sessionProjections.stateOf(session, "chopin.succeeded")?.tools ?? []);
    const unmet = unmetGates(gates, execution.name, succeeded);
    if (unmet.length === 0) return undefined;
    const registered = new Set(unmet.flatMap((rule) => [rule.tool, ...rule.requires]).filter((tool) => ctx.tools.get(tool) !== undefined));
    return gateRefusal(unmet, registered);
  });
}

/** Writes each session as ACP, appended in order as its events commit. */
function recordTranscripts(ctx: Context, directory: string): void {
  const writes = new Map<string, Promise<void>>();
  // The folder is made once, and made again should it fail or go away.
  let made: Promise<void> | undefined;
  const folder = () => (made ??= mkdir(directory, { recursive: true }).then(() => {}, (error: unknown) => {
    made = undefined;
    throw error;
  }));
  const append = async (file: string, text: string) => {
    await folder();
    try {
      await appendFile(file, text);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      made = undefined;
      await folder();
      await appendFile(file, text);
    }
  };
  const turns = new Map<string, { messages: { provider: string; model: string }[]; usage: Usage }>();
  ctx.on("session/event", (session, event: SessionEvent) => {
    const sessionId = String(session.id);
    const at = new Date(event.time).toISOString();
    const entries: TranscriptEntry[] = eventUpdates(event).map((update) => ({ at, notification: { sessionId, update } }));
    if (event.type === "assistant/message") {
      const turn = turns.get(sessionId) ?? { messages: [], usage: emptyUsage() };
      turn.messages.push(event.data.message.source);
      add(turn.usage, event.data.usage);
      turns.set(sessionId, turn);
    }
    if (event.type === "turn/end") {
      const turn = turns.get(sessionId);
      turns.delete(sessionId);
      const last = turn?.messages.at(-1);
      entries.push({
        at, sessionId,
        turnEnd: withChopinMeta({ stopReason: stopReason(event.data.reason), usage: turn?.usage ?? emptyUsage() }, {
          ...(last && { model: { provider: last.provider, id: last.model } }),
          ...(turnError(event.data.reason) !== undefined && { error: turnError(event.data.reason) }),
        }),
      });
    }
    if (entries.length === 0) return;
    const text = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
    const file = join(directory, `${sessionId}.jsonl`);
    const previous = writes.get(sessionId) ?? Promise.resolve();
    const next = previous.then(() => append(file, text)).catch((error) => {
      ctx.logger.warn("transcript %s: %s", sessionId, String(error));
    }).finally(() => {
      if (writes.get(sessionId) === next) writes.delete(sessionId);
    });
    writes.set(sessionId, next);
  });
  // The session's durability checkpoint waits for its transcript too, so a run that exits right after loses nothing.
  ctx.on("session/flush", async (session) => {
    await writes.get(String(session.id));
  });
}

/** Why a turn ended without finishing its work, if it did. */
function turnError(reason: TurnEndReason): string | undefined {
  if (reason.kind === "error") return reason.error.message;
  if (reason.kind === "interrupted") return "interrupted: the harness stopped before the turn ended";
  if (reason.kind === "blocked") return "blocked: the harness rejected the input before any step ran";
  return undefined;
}

/** Every ACP usage counter, as a number to add to. */
type Usage = { [K in keyof Omit<AcpUsage, "_meta">]-?: number };

function emptyUsage(): Usage {
  return { totalTokens: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 };
}

type CallUsage = NonNullable<SessionEvent<"assistant/message">["data"]["usage"]>;

/** Adds one call in ACP's terms, as the durable adapter counts: input includes what the cache read and wrote. */
function add(total: Usage, usage: CallUsage | undefined): void {
  if (usage === undefined) return;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const input = usage.inputTokens + cacheRead + cacheWrite;
  total.inputTokens += input;
  total.outputTokens += usage.outputTokens;
  total.totalTokens += usage.totalTokens ?? input + usage.outputTokens;
  total.thoughtTokens += usage.reasoningTokens ?? 0;
  total.cachedReadTokens += cacheRead;
  total.cachedWriteTokens += cacheWrite;
}
