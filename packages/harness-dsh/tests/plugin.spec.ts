import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { chopinMeta } from "@chopin-ai/core";
import { describe, expect, it } from "vitest";
import { apply } from "../src/index.js";

type Listener = (...args: unknown[]) => unknown;

/** The slice of a harness context the plugin uses, recording what it registers and folding projections per session. */
function fakeContext(tools: string[]) {
  const sections: { text: string }[] = [];
  const providers: { list(): Promise<unknown[]>; get(c: unknown): Promise<{ content: string }> }[] = [];
  const plugins: { config: unknown }[] = [];
  const projections: { init(): unknown; apply(state: unknown, event: unknown): unknown }[] = [];
  const guards: ((execution: unknown) => string | undefined)[] = [];
  const listeners = new Map<string, Listener>();
  const states = new Map<string, unknown>();
  const ctx = {
    systemPrompt: { section: (s: { text: string }) => void sections.push(s) },
    skills: { registerProvider: (create: (c: unknown) => (typeof providers)[number]) => void providers.push(create({})) },
    plugin: (_plugin: unknown, config: unknown) => void plugins.push({ config }),
    sessionProjections: {
      register: (definition: (typeof projections)[number]) => void projections.push(definition),
      stateOf: (session: { id: string }) => states.get(session.id),
    },
    tools: { guard: (g: (typeof guards)[number]) => void guards.push(g), get: (name: string) => (tools.includes(name) ? {} : undefined) },
    on: (name: string, listener: Listener) => void listeners.set(name, listener),
    logger: { warn: () => {} },
  } as unknown as Context;
  let seq = 0;
  const event = (type: string, data: unknown) => ({ type, seq: seq++, time: Date.UTC(2026, 9, 18), data });
  const commit = async (session: string, type: string, data: unknown) => {
    const e = event(type, data);
    for (const projection of projections) states.set(session, projection.apply(states.get(session) ?? projection.init(), e));
    await listeners.get("session/event")?.({ id: session }, e);
  };
  const call = (session: string, name: string) => guards.map((g) => g({ name, agent: { session: { id: session } } })).find(Boolean);
  return { ctx, sections, providers, plugins, listeners, commit, call };
}

async function layer(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chopin-dsh-layer-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const gates = "- tool: deliver\n  requires: [run_tests]\n  reason: Run the tests before delivering.\n";

describe("harness-dsh plugin", () => {
  it("refuses a gated call until the session log shows the required tool succeeded", async () => {
    const fake = fakeContext(["run_tests", "deliver"]);
    await apply(fake.ctx, { layer: await layer({ "gates.yaml": gates }) });

    expect(fake.call("s1", "deliver")).toContain("Run the tests before delivering.");
    await fake.commit("s1", "tool/call", { callId: "c1", name: "run_tests" });
    await fake.commit("s1", "tool/result", { message: { toolCallId: "c1", isError: true, content: [] } });
    expect(fake.call("s1", "deliver")).toContain("Run the tests before delivering.");

    await fake.commit("s1", "tool/call", { callId: "c2", name: "run_tests" });
    await fake.commit("s1", "tool/result", { message: { toolCallId: "c2", content: [] } });
    expect(fake.call("s1", "deliver")).toBeUndefined();
    expect(fake.call("s2", "deliver")).toContain("Run the tests before delivering.");
    expect(fake.ctx.sessionProjections.stateOf({ id: "s1" } as never, "chopin.succeeded")).toEqual({ calls: {}, tools: ["run_tests"] });
  });

  it("names a gate nothing could satisfy as a configuration error", async () => {
    const fake = fakeContext(["deliver"]);
    await apply(fake.ctx, { layer: await layer({ "gates.yaml": gates }) });
    expect(fake.call("s1", "deliver")).toContain("requires run_tests, which no tool provides");
  });

  it("loads instructions, skills and MCP servers from the layer", async () => {
    const fake = fakeContext([]);
    await apply(fake.ctx, {
      layer: await layer({
        "AGENTS.md": "Prefer small diffs.\n",
        "skills/review-diff/SKILL.md": "---\nname: review-diff\ndescription: Review a diff.\n---\nCheck every hunk.\n",
        "mcp.json": JSON.stringify({ mcpServers: { docs: { command: "docs-server", args: ["--stdio"] }, web: { type: "http", url: "https://example.test/mcp" } } }),
      }),
    });
    expect(fake.sections.map((s) => s.text)).toEqual(["Prefer small diffs.\n"]);
    const [provider] = fake.providers;
    const [candidate] = (await provider?.list()) ?? [];
    expect(candidate).toMatchObject({ name: "review-diff", description: "Review a diff.", provider: "chopin-layer" });
    expect((await provider?.get(candidate))?.content).toBe("Check every hunk.\n");
    expect(fake.plugins.map((p) => p.config)).toEqual([
      { transport: "stdio", serverName: "docs", command: "docs-server", args: ["--stdio"], env: {} },
      { transport: "streamable-http", serverName: "web", url: "https://example.test/mcp", headers: {} },
    ]);
  });

  it("refuses a layer that names a transport not every harness speaks", async () => {
    const fake = fakeContext([]);
    const root = await layer({ "mcp.json": JSON.stringify({ mcpServers: { old: { type: "sse", url: "https://example.test/sse" } } }) });
    await expect(apply(fake.ctx, { layer: root })).rejects.toThrow("uses SSE");
  });

  it("records each session as ACP and ends each turn with its usage and model", async () => {
    const fake = fakeContext([]);
    const transcripts = await mkdtemp(join(tmpdir(), "chopin-dsh-transcripts-"));
    await apply(fake.ctx, { layer: await layer({}), transcripts });
    await fake.commit("s1", "user/message", { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Fix it." }] });
    await fake.commit("s1", "user/message", { role: "user", source: { kind: "runtime-context" }, content: [{ type: "text", text: "Current runtime context." }] });
    await fake.commit("s1", "assistant/message", {
      message: { role: "assistant", source: { kind: "model", provider: "provider-a", model: "model-a" },
        content: [{ type: "reasoning", text: "Look." }, { type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"ls"}' }] },
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, reasoningTokens: 2 },
    });
    await fake.commit("s1", "tool/result", { message: { toolCallId: "c1", content: [{ type: "text", text: "a.txt" }] } });
    await fake.commit("s1", "turn/end", { turn: 1, reason: { kind: "completed" } });
    await fake.listeners.get("session/flush")?.({ id: "s1" });

    const lines = (await readFile(join(transcripts, "s1.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.slice(0, -1).map((entry) => entry.notification.update.sessionUpdate))
      .toEqual(["user_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"]);
    expect(lines[2].notification.update).toMatchObject({ kind: "execute", rawInput: { command: "ls" } });
    const end = lines.at(-1);
    // Input counts what the cache served too, as the durable harness reports it.
    expect(end.turnEnd).toMatchObject({
      stopReason: "end_turn",
      usage: { inputTokens: 14, outputTokens: 5, totalTokens: 19, thoughtTokens: 2, cachedReadTokens: 4 },
    });
    expect(chopinMeta(end.turnEnd)).toEqual({ model: { provider: "provider-a", id: "model-a" } });

    await fake.commit("s1", "turn/end", { turn: 2, reason: { kind: "error", error: { message: "rate limited", code: "429" } } });
    await fake.listeners.get("session/flush")?.({ id: "s1" });
    const failed = JSON.parse((await readFile(join(transcripts, "s1.jsonl"), "utf8")).trim().split("\n").at(-1) ?? "");
    expect(chopinMeta(failed.turnEnd)?.error).toBe("rate limited");

    await fake.commit("s1", "turn/end", { turn: 3, reason: { kind: "interrupted" } });
    await fake.listeners.get("session/flush")?.({ id: "s1" });
    const cut = JSON.parse((await readFile(join(transcripts, "s1.jsonl"), "utf8")).trim().split("\n").at(-1) ?? "");
    expect(chopinMeta(cut.turnEnd)?.error).toContain("interrupted");
  });
});
