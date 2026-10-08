import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

const output: ToolDefinition["output"] = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
};

export function improverTools(ctx: Context): ToolDefinition[] {
  return [
    {
      name: "evolution_context_inspect", description: "Inspect this session's latest committed experience selection, source sizes and whole-request usage. Does not call a model.",
      parameters: { type: "object", additionalProperties: false, properties: {} }, output,
      async execute(_args, exec) {
        if (!exec.agent) throw new Error("context inspection requires an owning session");
        return JSON.parse(JSON.stringify(await ctx.chopinEvolution.inspectContext(exec.agent)));
      },
    },
    {
      name: "evolution_context_strategy", description: "Read the active context selector and full contract, or propose its replacement for an authorized task. Stage returned files normally. Only eligible IDs and placement may change; budgets and source text stay fixed.",
      parameters: { type: "object", additionalProperties: false, required: ["action"], properties: {
        action: { type: "string", enum: ["read", "propose"] }, summary: { type: "string", maxLength: 500 },
      } }, output,
      async execute(args, exec) {
        const input = args as { action: "read" | "propose"; summary?: string };
        if (input.action === "read") return JSON.parse(JSON.stringify(await ctx.chopinEvolution.readContextStrategy(exec.agent)));
        if (!exec.agent || !input.summary) throw new Error("context proposal requires an owning request and summary");
        return JSON.parse(JSON.stringify(await ctx.chopinEvolution.proposeContextStrategy(exec.agent, exec.callId, input.summary)));
      },
    },
    {
      name: "evolution_improver_read",
      description: "Read the active improvement strategy's full source and exact version. Host constraints remain fixed.",
      parameters: { type: "object", additionalProperties: false, properties: {} }, output,
      execute: async (_args, execution) => ctx.chopinEvolution.readImprover(execution.agent),
    },
    {
      name: "evolution_improver_plan",
      description: "Run the selected strategy on real evidence within its host-owned action budget. Returns a recorded proposal, not proof of benefit.",
      parameters: { type: "object", additionalProperties: false, properties: {
        includeSelf: { type: "boolean", description: "Include improving the strategy itself when the current task authorizes it." },
      } }, output,
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error("improvement planning requires an owning session");
        const record = await ctx.chopinEvolution.planImprovement(exec.agent, (args as { includeSelf?: boolean }).includeSelf === true, exec.signal);
        return JSON.parse(JSON.stringify({ id: record.id, strategy: record.input.strategy, plan: record.plan,
          targets: record.input.work.filter((item) => record.plan.actions.some((action) => action.key === item.key)) }));
      },
    },
    {
      name: "evolution_improver_propose",
      description: "Propose a new improver version for the authorized task. Read its source first. Returns a bound manifest, starter and contract fixtures; write workspace files, change the algorithm, then call evolution_artifact_stage with these candidate/proposal IDs. Preserve the origin and tool contract.",
      parameters: { type: "object", additionalProperties: false, required: ["summary"], properties: {
        summary: { type: "string", description: "The concrete change to how future improvements are proposed; at most 500 characters." },
      } }, output,
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error("improvement proposal requires an owning session");
        return JSON.parse(JSON.stringify(await ctx.chopinEvolution.proposeImprover(exec.agent, exec.callId, (args as { summary: string }).summary)));
      },
    },
  ];
}
