/**
 * The team e2e probe: inside the whole chopin composition, a scripted model plays the lead
 * and every worker of one batch in a scratch git project, and the probe records what the
 * team log, the session logs and the remote say happened. No real model is called.
 *
 * The result goes to the file CHOPIN_TEAM_E2E_RESULT points at; team-e2e.mjs judges it.
 *
 * @module scripts/team-e2e-plugin
 */

import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const name = "chopin-team-e2e";
export const inject = ["agents", "agentPresets", "llm", "chopinTeam", "sessionPersistence", "subagents", "loader"];

const run = promisify(execFile);
const PROVIDER = "team-fake";
const LEAD = "team-e2e-lead";
const SECOND = "team-e2e-second";
const DEADLINE_MS = 240_000;

const git = async (cwd, ...args) => (await run("git", args, { cwd })).stdout.trim();

async function project(base) {
  const root = await mkdtemp(join(base, "team-e2e-"));
  const remote = join(root, "remote.git");
  await run("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  const main = join(root, "project");
  await run("git", ["clone", "--quiet", remote, main]);
  await git(main, "config", "user.name", "Team E2E");
  await git(main, "config", "user.email", "team@example.com");
  await mkdir(join(main, ".chopin"));
  await mkdir(join(main, "src"));
  await mkdir(join(main, "tests"));
  await writeFile(join(main, "src/shared.txt"), "base\n");
  // Every *.check file names a path that must exist; the check fails until the work does.
  await writeFile(join(main, "tests/run.sh"), 'for f in tests/*.check; do [ -e "$f" ] || continue; test -f "$(cat "$f")" || exit 1; done\n');
  await writeFile(join(main, ".chopin/team.yaml"), [
    "slots:", "  - { name: slot-1, path: ../slot-1 }", "  - { name: slot-2, path: ../slot-2 }",
    "checks:", "  - paths: ['src/**', 'tests/**']", "    run: sh tests/run.sh",
    "fullCheck: { where: ci }", "defaults: { maxRequests: 12, maxRounds: 2 }", "pollSeconds: 3600", "",
  ].join("\n"));
  await git(main, "add", ".");
  await git(main, "commit", "--quiet", "-m", "base");
  await git(main, "push", "--quiet", "origin", "HEAD:main");
  for (const slot of ["slot-1", "slot-2"]) await git(main, "worktree", "add", "--quiet", "--detach", join(root, slot), "origin/main");
  return { root, main };
}

const TASKS = [
  { id: "author", kind: "acceptance", objective: "Write the acceptance check for alpha", writeScope: ["tests/**"], acceptance: { criteria: "alpha's file must exist" } },
  { id: "alpha", kind: "change", objective: "Add the alpha file", commitMessage: "feat: alpha", writeScope: ["src/alpha/**"], acceptance: { criteria: "src/alpha/impl.txt exists" } },
  { id: "scout", kind: "read-only", objective: "Find where the parser lives", acceptance: { criteria: "names the directory" } },
  { id: "sneak", kind: "change", objective: "Add sneak", commitMessage: "feat: sneak", writeScope: ["src/sneak/**"], acceptance: { criteria: "sneak exists" }, manualAcceptance: true },
  { id: "greedy", kind: "change", objective: "Never finish", commitMessage: "feat: greedy", writeScope: ["src/greedy/**"], acceptance: { criteria: "never" }, manualAcceptance: true, maxRequests: 3 },
];

const bash = (command) => ["bash", { command, description: "Run a step of the scripted task" }];
const report = (fields) => ["team_report", { evidence: [], nextSteps: [], ...fields }];

/** What each scripted participant does at each step; `undefined` ends the turn with text. */
const SCRIPTS = {
  author: [bash("mkdir -p tests && printf 'src/alpha/impl.txt' > tests/alpha.check"),
    report({ status: "complete", summary: "check written", checks: [{ forTaskId: "alpha", path: "tests/alpha.check" }] })],
  alpha: [bash("mkdir -p src/alpha && printf 'alpha\\n' > src/alpha/impl.txt"), ["team_check", {}], report({ status: "complete", summary: "alpha added" })],
  scout: [["team_status", {}], report({ status: "complete", summary: "the parser lives in src/alpha" })],
  sneak: [bash("mkdir -p src/sneak && echo s > src/sneak/a.txt && echo changed > src/shared.txt"), ["team_check", {}],
    report({ status: "complete", summary: "sneak added" }), report({ status: "needs-decision", summary: "stuck", blocker: "sneak needs src/shared.txt" })],
  greedy: Array.from({ length: 10 }, () => bash("echo escape > ../outside.txt; echo again")),
  "lead:submit": [["team_batch_submit", { batchId: "b1", tasks: TASKS }], ["skill", { name: "grilling" }], ["team_batch_submit", { batchId: "b1", tasks: TASKS }]],
  "lead:approve": [["team_batch_approve", { batchId: "b1" }]],
  "lead:status": [["team_status", {}]],
  "lead:look": [["team_status", {}]],
  "lead:takeover": [["team_take_over", {}]],
};

function text(message) {
  return (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

async function adapterClass() {
  const require = createRequire(process.env.CHOPIN_TEAM_E2E_PROFILE);
  return import(pathToFileURL(require.resolve("@deepseek-ai/dsh-llm")).href);
}

export function apply(ctx) {
  const finish = async (result) => {
    if (process.env.CHOPIN_TEAM_E2E_RESULT) await writeFile(process.env.CHOPIN_TEAM_E2E_RESULT, `${JSON.stringify(result, null, 2)}\n`);
    ctx.loader.exit();
  };
  void probe(ctx).then(finish, (error) => finish({ ok: false, error: String(error?.stack ?? error) }));
}

async function probe(ctx) {
  const llm = await adapterClass();
  const OFF = llm.ReasoningEffortId("off");
  const leadContexts = [];
  class ScriptedModel extends llm.LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, reasoning: { efforts: [{ id: OFF, name: "Off" }], defaultEffort: OFF } };
    }
    async *stream(request) {
      const users = request.messages.filter((message) => message.role === "user");
      const brief = users.map(text).find((body) => body.startsWith("# Team task ") || body.startsWith("LEAD "));
      const key = brief?.startsWith("LEAD ") ? `lead:${users.map(text).findLast((body) => body.startsWith("LEAD ")).slice(5)}`
        : brief?.match(/^# Team task ([a-z0-9-]+)/)?.[1];
      if (key?.startsWith("lead:")) leadContexts.push(JSON.stringify(request.messages));
      const since = request.messages.findLastIndex((message) => message.role === "user" && text(message).startsWith(key?.startsWith("lead:") ? "LEAD " : "# Team task"));
      const step = request.messages.slice(since).filter((message) => message.role === "tool").length;
      const action = SCRIPTS[key]?.[step];
      if (action === undefined) {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "Done." } };
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
        yield { type: "finish", reason: { kind: "stop" } };
        return;
      }
      const [tool, args] = action;
      const id = llm.ToolCallId(`${String(request.sessionId ?? key)}-${step}-${request.messages.length}`);
      const encoded = JSON.stringify(args);
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id, name: tool, argumentsDelta: encoded };
      yield { type: "block-end", index: 0, block: { type: "tool-call", id, name: tool, arguments: encoded } };
      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, reasoningTokens: 0 } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new ScriptedModel()));
  ctx.on("approval/request", async (request, next) => String(request.agent.id) === LEAD ? "allowed-once" : next());

  const started = Date.now();
  let preset;
  for (;;) {
    try { preset = await ctx.agentPresets.resolve("chopin"); break; } catch (error) {
      if (Date.now() - started > 60_000) throw error;
      await delay(200);
    }
  }
  if (preset.broken) return { ok: false, error: `preset broken: ${preset.broken}` };
  // The sandbox lets every worker write the temporary directory, so the fixture must live elsewhere to test it.
  await mkdir(process.env.CHOPIN_TEAM_E2E_FIXTURE, { recursive: true });
  const { root, main } = await project(process.env.CHOPIN_TEAM_E2E_FIXTURE);
  const lease = await ctx.agentPresets.acquireScope(preset.id);
  const open = (sessionId) => ctx.agents.create({
    sessionId, meta: { cwd: main, agentPreset: preset.id }, agentOptions: { provider: PROVIDER, model: "fake" },
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, preset.id); },
  });
  const handle = await open(LEAD);
  const lead = handle.agent;
  const turnOf = (agent) => async (phase) => {
    const ended = new Promise((resolve) => {
      const release = ctx.on("session/event", (session, event) => {
        if (session.id !== agent.session.id || event.type !== "turn/end") return;
        release();
        resolve(event.data.reason);
      });
    });
    agent.followup(llm.createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: `LEAD ${phase}` }] }));
    const reason = await ended;
    await agent.whenIdle();
    return reason;
  };
  const turn = turnOf(lead);
  const lastToolText = (agent) => {
    const event = agent.session.snapshotEvents().findLast((entry) => entry.type === "tool/result");
    return event === undefined ? "" : text(event.data.message);
  };
  const projection = () => ctx.chopinTeam.projection(main);
  const until = async (label, predicate) => {
    for (;;) {
      const state = await projection();
      if (predicate(state)) return state;
      if (Date.now() - started > DEADLINE_MS) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(Object.fromEntries(Object.entries(state.tasks).map(([id, task]) => [id, [task.status, task.attention]])))}`);
      await delay(250);
    }
  };
  try {
    const submitEnd = await turn("submit");
    await until("the acceptance check", (state) => ["done", "attention"].includes(state.tasks.author?.status));
    const approveEnd = await turn("approve");
    const settled = await until("the batch to settle", (state) => ["alpha", "scout", "sneak", "greedy"].every((id) =>
      ["delivered", "landed", "done", "attention", "cancelled"].includes(state.tasks[id]?.status)));
    await turn("status");
    const children = await ctx.subagents.listChildren(lead.session.id);

    const second = await open(SECOND);
    await turnOf(second.agent)("look");
    const watched = lastToolText(second.agent);
    await turnOf(second.agent)("takeover");
    const tookOver = lastToolText(second.agent);
    const leadAfterTakeover = (await ctx.chopinTeam.leadOf(main))?.sessionId;
    await second.dispose();
    await delay(500);
    const leadAfterClose = (await ctx.chopinTeam.leadOf(main))?.sessionId;

    const sessions = ctx.agents;
    const leadEvents = lead.session.snapshotEvents();
    const results = Object.fromEntries(leadEvents.filter((event) => event.type === "tool/result")
      .map((event) => [String(event.data.message.toolCallId), { isError: event.data.message.isError, text: text(event.data.message) }]));
    const calls = leadEvents.filter((event) => event.type === "tool/call").map((event) => ({ name: event.data.name, result: results[String(event.data.callId)] }));
    const workerLog = async (taskId) => {
      const task = settled.tasks[taskId];
      const sessionId = `team-${task.attemptIds.at(-1)}-r1`;
      const stored = await ctx.sessionPersistence.open(sessionId, "read");
      try {
        const { events } = await stored.read();
        const out = Object.fromEntries(events.filter((event) => event.type === "tool/result")
          .map((event) => [String(event.data.message.toolCallId), { isError: event.data.message.isError, text: text(event.data.message) }]));
        return {
          calls: events.filter((event) => event.type === "tool/call").map((event) => ({ name: event.data.name, result: out[String(event.data.callId)] })),
          policies: events.filter((event) => event.type === "approval/policy" || event.type === "sandbox/mode").map((event) => [event.type, event.data.policy ?? event.data.mode]),
        };
      } finally { await stored.close(); }
    };
    let outsideExists = true;
    try { await access(join(root, "outside.txt")); } catch { outsideExists = false; }
    const evolution = ctx.get("chopinEvolution");
    const evolutionEvents = evolution === undefined ? [] : await evolution.events.readAll();
    return {
      ok: true,
      submitEnd, approveEnd,
      leadCalls: calls,
      tasks: Object.fromEntries(Object.entries(settled.tasks).map(([id, task]) => [id, { status: task.status, attention: task.attention, usage: task.usage, checks: task.checks, rounds: task.rounds }])),
      batch: settled.batches.b1,
      trunk: { subject: await git(main, "log", "-1", "--format=%s", "origin/main") },
      branch: { subjects: (await git(main, "log", "--format=%s", "origin/main..team/alpha")).split("\n"), files: (await git(main, "show", "--name-only", "--format=", "team/alpha")).split("\n") },
      workers: { scout: await workerLog("scout"), sneak: await workerLog("sneak"), greedy: await workerLog("greedy"), alpha: await workerLog("alpha") },
      outsideExists,
      leadBriefSeen: leadContexts.some((body) => body.includes("Waiting for a decision")),
      observedWorkerSessions: [...new Set(evolutionEvents.map((event) => JSON.stringify(event)).flatMap((line) => line.match(/team-[a-z0-9-]+-r\d+/g) ?? []))],
      activeAgents: sessions.roots().length,
      childLabels: children.map((child) => child.label),
      watched, tookOver, leadAfterTakeover, leadAfterClose: leadAfterClose ?? null,
    };
  } finally {
    await handle.dispose();
    await lease[Symbol.asyncDispose]();
  }
}
