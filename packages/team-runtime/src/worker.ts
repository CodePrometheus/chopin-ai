/**
 * Worker rounds as one-shot sub-agents of the current lead session. The plugin registers its
 * own sub-agent provider, so each round runs in its slot with the team tools, a hard cap on
 * model steps and timed approvals, while dsh records it in the lead's sub-agent catalog and
 * the terminal shows it under the lead. What a round produced is read back from its log.
 *
 * @module @chopin/team-runtime/worker
 */

import { setTimeout as delay } from "node:timers/promises";

import type { Context } from "@deepseek-ai/cordis";
import type { WorkerOutcome, WorkerRound } from "@chopin/team";
import type {} from "@deepseek-ai/dsh-agent";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import type {} from "@deepseek-ai/dsh-agent-loop";
import type {} from "@deepseek-ai/dsh-agent-preset-registry";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { Session, TurnEndReason } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type { ResolvedSubagentStartRequest, SubagentProvider, SubagentRun } from "@deepseek-ai/dsh-subagent";
import type {} from "@deepseek-ai/dsh-tools";
import { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";

import { runConfined } from "./commands.js";
import { roundSignals } from "./signals.js";
import { checkTool, leadOnlyGuard, reportTool } from "./tools.js";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    /** The brief the team host opens each worker round with. */
    team: {
      readonly kind: "team";
      readonly taskId: string;
      readonly attemptId: string;
      readonly round: number;
      readonly form: "notice";
      readonly summary: string;
    };
  }
}

export interface WorkerOptions {
  /** The sub-agent provider name the plugin registers. */
  provider: string;
  preset: string;
  leadOnlyTools: readonly string[];
  /** How long an approval waits for the person before it counts as refused. */
  approvalTimeoutMs: number;
}

/** A round the host scheduled, waiting for the sub-agent service to call the provider. */
interface Scheduled {
  round: WorkerRound;
  exhausted: boolean;
  ended?: TurnEndReason;
}

/** How long a round waits for its preset to finish loading, as it may right after the host starts. */
const PRESET_WAIT_MS = 60_000;

export class DshWorkerPort {
  private readonly scheduled = new Map<string, Scheduled>();

  constructor(private readonly ctx: Context, private readonly options: WorkerOptions) {}

  /** The provider the sub-agent service calls for each round this port starts. */
  provider(): SubagentProvider {
    return {
      name: this.options.provider,
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: (request) => this.startChild(request),
    };
  }

  /** Run one round as a sub-agent of `lead`; `label` names it in the lead's catalog. */
  async runRound(round: WorkerRound, lead: Agent, label: string): Promise<WorkerOutcome> {
    const entry: Scheduled = { round, exhausted: false };
    this.scheduled.set(label, entry);
    let run: SubagentRun;
    try {
      run = await this.ctx.subagents.start(this.options.provider, { parent: lead, label, signal: round.signal, prompt: [{ type: "text", text: round.prompt }] });
    } finally {
      this.scheduled.delete(label);
    }
    try {
      await run.result;
      const signals = roundSignals(run.localAgent!.session.snapshotEvents());
      const ended = entry.ended;
      return { ...signals, exhausted: entry.exhausted, ...(ended?.kind === "error" ? { failure: `${ended.error.code}: ${ended.error.message}` } : {}) };
    } finally {
      await run.dispose();
    }
  }

  async salvage(sessionId: string): Promise<Pick<WorkerOutcome, "report" | "usage">> {
    const handle = await this.ctx.sessionPersistence.open(SessionId(sessionId), "read");
    try {
      const { report, usage } = roundSignals((await handle.read()).events);
      return { ...(report === undefined ? {} : { report }), usage };
    } finally {
      await handle.close();
    }
  }

  private async resolvePreset(signal: AbortSignal): Promise<{ id: string }> {
    const deadline = Date.now() + PRESET_WAIT_MS;
    for (;;) {
      try {
        const preset = await this.ctx.agentPresets.resolve(this.options.preset);
        if (preset.broken !== undefined) throw new Error(`agent preset ${preset.id} is broken: ${preset.broken}`);
        return preset;
      } catch (error) {
        if ((error as { code?: string }).code !== "agent-preset/not-found" || Date.now() > deadline) throw error;
        await delay(250, undefined, { signal });
      }
    }
  }

  private async startChild(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const entry = request.label === undefined ? undefined : this.scheduled.get(request.label);
    if (entry === undefined) throw new Error("the team provider only runs rounds its host scheduled");
    const { ctx } = this;
    const { round } = entry;
    const preset = await this.resolvePreset(request.signal);
    const lease = await ctx.agentPresets.acquireScope(preset.id);
    let handle: AgentHandle;
    try {
      const parent = request.parent.session.header;
      const route = round.model ?? leadRoute(request.parent.session) ?? ctx.agentDefaultModel.currentSelection();
      let steps = 0;
      handle = await ctx.agents.create({
        sessionId: SessionId(round.sessionId), parentAgent: request.parent, signal: request.signal,
        meta: { cwd: round.cwd, agentPreset: preset.id, parentSession: parent.id, origin: "subagent", delegationDepth: (parent.delegationDepth ?? 0) + 1 },
        agentOptions: { provider: route.provider, model: route.model },
        setup: async (agentCtx, agent) => {
          agent.session.append("subagent/descriptor", request.descriptor);
          await ctx.agentPresets.mount(agentCtx, preset.id);
          agentCtx.on("agent/pre-step", async (_payload, next) => {
            if (steps >= round.requestLimit) {
              entry.exhausted = true;
              return { kind: "reject" };
            }
            steps += 1;
            return next();
          });
          // Ask the person; with no answer in time the request counts as refused and the task waits for a decision.
          agentCtx.on("approval/request", async (_request, next) => Promise.race([next(),
            delay(this.options.approvalTimeoutMs, "rejected" as const, { ref: false })]));
          const tools = {
            cwd: round.cwd, gate: round.gate, events: () => agent.session.snapshotEvents(),
            runCheck: (command: string, signal: AbortSignal) => runConfined(ctx, command, { cwd: round.cwd, writableRoot: round.cwd, signal, sessionId: agent.session.id }),
          };
          agentCtx.effect(() => agentCtx.tools.guard(leadOnlyGuard(this.options.leadOnlyTools)));
          agentCtx.effect(() => agentCtx.tools.register(checkTool(tools)));
          agentCtx.effect(() => agentCtx.tools.register(reportTool(tools)));
        },
      });
    } catch (error) {
      await lease[Symbol.asyncDispose]();
      throw error;
    }
    const { agent } = handle;
    setSandboxMode(agent.session, "workspace-write");
    setApprovalPolicy(agent.session, "ask");
    const ended = new Promise<TurnEndReason>((resolve) => {
      const release = ctx.on("session/event", (session, event) => {
        if (session.id !== agent.session.id || event.type !== "turn/end") return;
        release();
        resolve(event.data.reason);
      });
    });
    const abort = () => agent.cancel({ kind: "parent" });
    request.signal.addEventListener("abort", abort, { once: true });
    agent.followup(createUserMessage({
      source: { kind: "team", taskId: round.taskId, attemptId: round.attemptId, round: round.round, form: "notice",
        summary: boundContextSummary(`team task ${round.taskId}, round ${round.round}`) },
      content: [...request.prompt],
    }));
    const result = ended.then(async (reason) => {
      await agent.whenIdle();
      entry.ended = reason;
      const report = roundSignals(agent.session.snapshotEvents()).report;
      return {
        output: [{ type: "text" as const, text: report === undefined ? "Ended without a report." : `${report.status}: ${report.summary}` }],
        stopReason: reason.kind === "completed" || reason.kind === "blocked" ? "completed" as const : reason.kind === "aborted" ? "aborted" as const : "error" as const,
      };
    });
    return {
      id: agent.session.id, localAgent: agent, result,
      dispose: async () => {
        request.signal.removeEventListener("abort", abort);
        await handle.dispose();
        await lease[Symbol.asyncDispose]();
      },
    };
  }
}

/** The provider and model the lead's latest request used; workers default to them. */
function leadRoute(session: Session): { provider: string; model: string } | undefined {
  const header = session.requestHeader();
  return header === undefined ? undefined : { provider: header.config.provider, model: header.config.model };
}
