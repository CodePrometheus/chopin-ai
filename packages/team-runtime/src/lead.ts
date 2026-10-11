/**
 * The lead's side of team mode, mounted in the lead's preset: tools to submit and approve
 * batches, relay decisions, accept landed work and take a team over, plus a brief of the team
 * in every request, so a fresh lead session starts knowing what waits for the person. The
 * first session to use a team leads it; workers run as that session's sub-agents. Submitting
 * a batch can require an interview skill to have been loaded in the same session.
 *
 * @module @chopin/team-runtime/lead
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { findTeamRoot, leadBrief } from "@chopin/team";
import type { LeaseHolder } from "@chopin/team";
import type { ModelRoute, TaskSpec, TeamProjection } from "@chopin/team";
import type {} from "@deepseek-ai/dsh-agent-loop";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-user-approval";

import type { TeamRole } from "./index.js";
import type { LoggedEvent } from "./signals.js";

type JsonValue = Parameters<ToolDefinition["output"]["render"]>[1];

export const name = "chopin-team-lead";
export const inject = ["tools", "systemPrompt", "approval", "chopinTeam"];

export interface Config {
  /** Skills of which one must have been loaded in the session before it may submit a batch. */
  requiredSkills: string[];
}

export const Config: z<Config> = z.object({
  requiredSkills: z.array(z.string()).default([]),
});

type Agent = NonNullable<ToolRunContext["agent"]>;

function textResult(value: JsonValue): { type: "text"; text: string }[] {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}

/** A successful `skill` call for one of `names` in this session's log. */
export function skillLoaded(events: readonly LoggedEvent[], names: readonly string[]): boolean {
  const loads = new Set<string>();
  for (const event of events) {
    const data = event.data as Record<string, unknown>;
    if (event.type === "tool/call" && data.name === "skill" && typeof data.callId === "string" && typeof data.arguments === "string") {
      try {
        if (names.includes((JSON.parse(data.arguments) as { name?: string }).name ?? "")) loads.add(data.callId);
      } catch {
        // Unparsable arguments never loaded a skill.
      }
    }
    const message = data.message as { toolCallId?: string; isError?: boolean } | undefined;
    if (event.type === "tool/result" && message?.isError === false && message.toolCallId !== undefined && loads.has(message.toolCallId)) return true;
  }
  return false;
}

/** The approval id the session recorded for this call's question. */
function approvalId(agent: Agent, callId: string): string | undefined {
  const asked = agent.session.snapshotEvents().findLast((event) => event.type === "approval/asked" && event.data.callId === callId);
  return asked?.type === "approval/asked" ? String(asked.data.id) : undefined;
}

interface TaskInput {
  id: string;
  kind: TaskSpec["kind"];
  objective: string;
  commitMessage?: string;
  writeScope?: string[];
  dependsOn?: string[];
  acceptance: { criteria: string; examples?: string[] };
  manualAcceptance?: boolean;
  maxRequests?: number;
  maxRounds?: number;
  model?: ModelRoute;
}

const TASK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "objective", "acceptance"],
  properties: {
    id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,127}$", description: "Unique across the project's whole team log." },
    kind: { type: "string", enum: ["acceptance", "change", "read-only"],
      description: "acceptance: writes this batch's executable checks before approval. change: lands one commit. read-only: changes nothing; its report is the result." },
    objective: { type: "string", minLength: 1 },
    commitMessage: { type: "string", minLength: 1, maxLength: 200, description: "Change tasks only: the single-line message, following the project's conventions." },
    writeScope: { type: "array", items: { type: "string", minLength: 1 }, description: "Path globs the task may change; empty for read-only. Tasks whose scopes may overlap never run at once." },
    dependsOn: { type: "array", items: { type: "string" } },
    acceptance: {
      type: "object", additionalProperties: false, required: ["criteria"],
      properties: { criteria: { type: "string", minLength: 1 }, examples: { type: "array", items: { type: "string", minLength: 1 } } },
    },
    manualAcceptance: { type: "boolean", description: "Part of the result can only be confirmed by the person after it lands." },
    maxRequests: { type: "integer", minimum: 1 },
    maxRounds: { type: "integer", minimum: 1 },
    model: { type: "object", additionalProperties: false, required: ["provider", "model"], properties: { provider: { type: "string" }, model: { type: "string" } } },
  },
};

const ID = (description: string) => ({ type: "string", minLength: 1, description });

export async function apply(ctx: Context, config: Config): Promise<void> {
  const team = () => ctx.chopinTeam;

  /** The calling session and its project's root; using a team tool makes it the lead when nobody leads. */
  async function rootOf(exec: ToolRunContext): Promise<{ agent: Agent; root: string; role: TeamRole }> {
    const agent = exec.agent;
    const cwd = agent?.session.header.cwd;
    if (agent === undefined || cwd === undefined) throw new Error("Team tools need a session with a working directory");
    const root = await findTeamRoot(cwd);
    if (root === undefined) throw new Error(`No .chopin/team.yaml at or above ${cwd}; team mode needs the project's team configuration`);
    return { agent, root, role: await team().attach(root, agent) };
  }

  function tool(name: string, description: string, properties: Record<string, unknown>, required: string[],
    run: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<JsonValue>): ToolDefinition {
    return {
      name, description,
      parameters: { type: "object", additionalProperties: false, required, properties },
      output: { schema: {}, render: (_args, value) => textResult(value) },
      execute: (args, exec) => run(args as Record<string, unknown>, exec),
    };
  }

  async function ask(agent: Agent, exec: ToolRunContext, reason: string): Promise<string | undefined> {
    const outcome = await ctx.approval.request({ agent, toolName: exec.name, callId: exec.callId, reason, signal: exec.signal });
    return outcome === "allowed-once" ? approvalId(agent, exec.callId) ?? exec.callId : undefined;
  }

  const tools: ToolDefinition[] = [
    tool("team_status", "The team's state for this project: who leads it, what waits for the person, batches awaiting approval, running and landed tasks.", {}, [],
      async (_args, exec) => {
        const { root, role } = await rootOf(exec);
        return [roleLine(role), leadBrief(await team().projection(root)) || "The team log is empty."].join("\n");
      }),

    tool("team_take_over", "Make this session the team's lead because the person asked to, even while another session leads it; that session stops driving and its rounds pause, then resume here.",
      {}, [], async (_args, exec) => {
        const { agent, root } = await rootOf(exec);
        return roleLine(await team().attach(root, agent, true));
      }),

    tool("team_batch_submit", [
      "Submit a batch of structured tasks agreed with the person. Its acceptance tasks start right away and turn the criteria into checks;",
      "everything else waits until the person approves the batch with team_batch_approve. Every change task needs an acceptance task in the batch or manualAcceptance.",
    ].join(" "), { batchId: ID("Optional batch id; generated when omitted."), tasks: { type: "array", minItems: 1, items: TASK_SCHEMA } }, ["tasks"],
    async (args, exec) => {
      const { agent, root } = await rootOf(exec);
      if (!skillLoaded(agent.session.snapshotEvents(), config.requiredSkills)) {
        throw new Error(`Interview the person first: load the ${config.requiredSkills.join(" or ")} skill in this session and settle the plan with them before submitting it.`);
      }
      const project = await team().open(root);
      const header = agent.session.requestHeader();
      const leadModel = header === undefined ? undefined : { provider: header.config.provider, model: header.config.model };
      const inputs = args.tasks as TaskInput[];
      const authoring = inputs.some((input) => input.kind === "acceptance");
      const ungated = inputs.filter((input) => input.kind === "change" && input.manualAcceptance !== true && !authoring).map((input) => input.id);
      if (ungated.length > 0) throw new Error(`Nothing would accept ${ungated.join(", ")}: add an acceptance task to the batch or mark them manualAcceptance`);
      const tasks: TaskSpec[] = inputs.map((input) => ({
        id: input.id, kind: input.kind, objective: input.objective,
        ...(input.commitMessage === undefined ? {} : { commitMessage: input.commitMessage }),
        writeScope: input.writeScope ?? [], dependsOn: input.dependsOn ?? [],
        acceptance: { criteria: input.acceptance.criteria, examples: input.acceptance.examples ?? [] },
        ...(input.model ?? leadModel) === undefined ? {} : { model: input.model ?? leadModel! },
        maxRequests: input.maxRequests ?? project.config.defaults.maxRequests,
        maxRounds: input.maxRounds ?? project.config.defaults.maxRounds,
        stages: input.kind === "change" ? project.config.stages.map((stage) => stage.name) : [],
        manualAcceptance: input.manualAcceptance ?? false,
      }));
      const batchId = typeof args.batchId === "string" ? args.batchId : `b${Date.now().toString(36)}`;
      await team().propose(root, batchId, tasks, String(agent.session.id));
      const batch = (await team().projection(root)).batches[batchId]!;
      return [
        `Batch ${batchId}: ${tasks.length} tasks, at most ${batch.maxRequests} model requests.`,
        authoring ? "Its acceptance tasks are writing the checks now; once team_status shows them done, ask the person to approve with team_batch_approve."
          : "Ask the person to approve it with team_batch_approve.",
      ].join(" ");
    }),

    tool("team_batch_approve", "Ask the person to approve a proposed batch, showing its tasks, written checks and spending cap. Only their answer approves it.",
      { batchId: ID("The proposed batch.") }, ["batchId"], async (args, exec) => {
        const { agent, root } = await rootOf(exec);
        const projection = await team().projection(root);
        const batch = projection.batches[String(args.batchId)];
        if (batch === undefined || batch.status !== "proposed") throw new Error(`Batch ${String(args.batchId)} is not waiting for approval`);
        const pending = batch.taskIds.filter((id) => projection.tasks[id]!.spec.kind === "acceptance"
          && !["done", "cancelled"].includes(projection.tasks[id]!.status));
        if (pending.length > 0) throw new Error(`The acceptance checks are still being written by ${pending.join(", ")}`);
        const audit = await ask(agent, exec, approvalSummary(projection, batch.id));
        if (audit === undefined) return `The person did not approve batch ${batch.id}.`;
        await team().approve(root, batch.id, audit);
        return `Batch ${batch.id} approved; its tasks are queued.`;
      }),

    tool("team_batch_reject", "Drop a proposed batch the person no longer wants; acceptance work is kept on its branches.",
      { batchId: ID("The proposed batch."), reason: ID("Why.") }, ["batchId", "reason"], async (args, exec) => {
        const { root } = await rootOf(exec);
        await team().reject(root, String(args.batchId), String(args.reason));
        return `Batch ${String(args.batchId)} rejected.`;
      }),

    tool("team_task_decide", "Relay the person's decision on a task that waits for one; the task goes back in the queue with the decision in its brief.",
      { taskId: ID("The waiting task."), decision: ID("The decision, in the person's terms.") }, ["taskId", "decision"], async (args, exec) => {
        const { agent, root } = await rootOf(exec);
        await team().decide(root, String(args.taskId), String(args.decision), String(agent.session.id));
        return `Recorded; ${String(args.taskId)} is queued again.`;
      }),

    tool("team_task_cancel", "Cancel a task; a running one is stopped first. Its branch is kept, never deleted.",
      { taskId: ID("The task."), reason: ID("Why.") }, ["taskId", "reason"], async (args, exec) => {
        const { agent, root } = await rootOf(exec);
        await team().cancel(root, String(args.taskId), String(args.reason), String(agent.session.id));
        return `${String(args.taskId)} cancelled.`;
      }),

    tool("team_task_accept", "Ask the person to confirm a landed task's manual stage or acceptance. Only their answer confirms it.",
      { taskId: ID("The landed task."), stage: ID("The stage to confirm; omit to confirm the task's manual acceptance.") }, ["taskId"], async (args, exec) => {
        const { agent, root } = await rootOf(exec);
        const task = (await team().projection(root)).tasks[String(args.taskId)];
        if (task === undefined || task.status !== "landed") throw new Error(`${String(args.taskId)} is not landed`);
        const stage = typeof args.stage === "string" ? args.stage : undefined;
        const audit = await ask(agent, exec, `${task.spec.id} landed as ${task.landedCommit!.slice(0, 12)}. Confirm ${stage === undefined ? "it meets its acceptance" : `stage ${stage}`}: ${task.spec.acceptance.criteria}`);
        if (audit === undefined) return `The person did not confirm ${task.spec.id}.`;
        await team().accept(root, task.spec.id, stage, `confirmed by the person (approval ${audit})`);
        return `${task.spec.id}: ${stage ?? "acceptance"} confirmed.`;
      }),

    tool("team_task_rework", "Send landed work back because the person found it falls short; it waits for a decision on what to change.",
      { taskId: ID("The landed task."), reason: ID("What falls short.") }, ["taskId", "reason"], async (args, exec) => {
        const { root } = await rootOf(exec);
        await team().rework(root, String(args.taskId), String(args.reason));
        return `${String(args.taskId)} is waiting for a decision on the rework.`;
      }),
  ];
  for (const definition of tools) ctx.effect(() => ctx.tools.register(definition));

  ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    const result = await next();
    const agent = context.agent;
    const header = agent?.session.header;
    if (agent === undefined || header?.cwd === undefined || header.origin === "subagent") return result;
    try {
      const root = await team().teamRootFor(header.cwd);
      if (root === undefined) return result;
      const role = await team().attach(root, agent);
      result.contexts.push({ name: "chopin:team", text: [roleLine(role), leadBrief(await team().projection(root))].filter((line) => line !== "").join("\n") });
    } catch (error) {
      ctx.logger.warn("team brief skipped: %s", (error as Error).message);
    }
    return result;
  });
}

function roleLine(role: TeamRole): string {
  if (role.kind === "lead") return "This session leads the team; its workers run as this session's sub-agents.";
  const lead: LeaseHolder | undefined = role.lead;
  return `${lead === undefined ? "Another session" : `Session ${lead.sessionId} (process ${lead.pid})`} leads this team. This session can read it and add to it; call team_take_over only when the person asks to take over.`;
}

function approvalSummary(projection: TeamProjection, batchId: string): string {
  const batch = projection.batches[batchId]!;
  const lines = [`Approve batch ${batch.id}: ${batch.taskIds.length} tasks, at most ${batch.maxRequests} model requests in total.`];
  for (const id of batch.taskIds) {
    const task = projection.tasks[id]!;
    if (task.spec.kind === "acceptance") continue;
    lines.push(`- ${id} (${task.spec.kind}): ${task.spec.objective}`,
      ...(task.checks.length > 0 ? [`  checks: ${task.checks.map((check) => check.path).join(", ")}`] : []),
      ...(task.spec.manualAcceptance ? ["  the person confirms part of it after it lands"] : []));
  }
  return lines.join("\n");
}
