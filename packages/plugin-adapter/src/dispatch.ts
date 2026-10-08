import type { Context } from "@deepseek-ai/cordis";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { assertDispatchDecision } from "@chopin/evolution";
import type { CapabilityDispatchStep, ExecutionContext, JsonObject, JsonValue } from "@chopin/evolution";
import type { SandboxedPlugin } from "@chopin/plugin-sandbox";
import { PluginExecutionError } from "@chopin/plugin-sandbox";

const activeDispatches = new Set<unknown>();

/** A candidate only returns its next intent; tool calls, stop signals and call records are all produced by the host. */
export async function executeCapabilityTool(ctx: Context, plugin: SandboxedPlugin, name: string, args: JsonObject,
  execution: ToolRunContext, environment: { environment?: ExecutionContext }): Promise<JsonValue> {
  const definition = plugin.inspection.definitions.tools.find(tool => tool.name === name)!;
  const input = { callId: String(execution.callId), arguments: args, ...environment };
  if (!definition.dispatch) return plugin.executeTool(name, input, execution.signal);
  if (execution.parent && activeDispatches.has(execution.parent)) throw new PluginExecutionError("Nested capability dispatch is not permitted");
  const { tools, maxSteps } = definition.dispatch;
  const steps: CapabilityDispatchStep[] = [];
  activeDispatches.add(execution.token);
  try {
    while (true) {
      execution.signal.throwIfAborted();
      if (JSON.stringify(steps).length > 128_000) throw new PluginExecutionError("Dispatch history exceeds its execution budget");
      const raw = await plugin.executeTool(name, { ...input, steps }, execution.signal);
      try { assertDispatchDecision(raw); }
      catch (error) { throw new PluginExecutionError(String(error)); }
      const decision = raw;
      if (decision.kind === "done") return decision.value;
      if (!tools.includes(decision.tool)) throw new PluginExecutionError("Dispatch selected an undeclared operation");
      if (steps.length >= maxSteps) throw new PluginExecutionError("Dispatch exceeded its action budget");
      const native = ctx.tools.get(decision.tool, execution.agent);
      if (!native) throw new PluginExecutionError("Dispatch tool is unavailable in this session");
      const subCallId = ToolCallId(`${execution.callId}:capability:${steps.length + 1}`);
      const event = { rootCallId: execution.rootCallId, parentCallId: execution.callId, subCallId,
        name: decision.tool, arguments: decision.arguments };
      execution.agent?.session.append("tool/ptc-dispatch-start", event);
      const result = await ctx.tools.execute({ callId: subCallId, rootCallId: execution.rootCallId, parent: execution.token,
        name: decision.tool, arguments: decision.arguments, agent: execution.agent, signal: execution.signal });
      execution.agent?.session.append("tool/ptc-dispatch", { ...event, isError: result.isError, content: result.content });
      for (const context of result.additionalContexts ?? []) execution.deferContext(context);
      if (result.isError) throw new PluginExecutionError(result.error.message);
      if (result.concludesTurn) { execution.concludeTurn(); return result.value as JsonValue; }
      steps.push({ tool: decision.tool, arguments: decision.arguments, value: result.value as JsonValue });
    }
  } finally { activeDispatches.delete(execution.token); }
}
