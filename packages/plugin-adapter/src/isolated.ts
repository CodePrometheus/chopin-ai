import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { assertExecutionContext, CONTEXT_SELECTOR_TOOL, IMPROVER_TOOL } from "@chopin/evolution";
import type { ExecutionContext, JsonObject, JsonValue } from "@chopin/evolution";
import { PluginExecutionError } from "@chopin/plugin-sandbox";
import type { SandboxedPlugin } from "@chopin/plugin-sandbox";
import { successfulCalls } from "./tool-history.js";
import { executeCapabilityTool } from "./dispatch.js";

export const MAX_PLUGIN_CONTEXT_CHARS = 2_000;

export function boundedPluginContext(value: string): string {
  if (value.length > MAX_PLUGIN_CONTEXT_CHARS) throw new PluginExecutionError("Executable context exceeds its host budget");
  return value;
}

/** Mounts a candidate for isolated tasks only; produces no approval, deployment or production-use receipt. */
export function mountIsolatedCapability(scope: Context, agent: Agent, plugin: SandboxedPlugin, workspace: string, prompt: string,
  environment?: () => ExecutionContext): () => void {
  const disposers: Array<() => void> = [];
  const dispose = () => { for (const release of disposers.splice(0).reverse()) release(); };
  const executionContext = () => {
    if (!environment) return {};
    const value = { ...environment(), tools: scope.tools.schemas(agent).map(tool => tool.name) };
    assertExecutionContext(value); return { environment: value };
  };
  try {
    for (const definition of plugin.inspection.definitions.contexts) {
      disposers.push(scope.systemPrompt.context({ name: `chopin:trial:${definition.name}`, order: definition.order,
        text: () => boundedPluginContext(plugin.renderContext(definition.name, { workspace, prompt, ...executionContext() })) }));
    }
    for (const definition of plugin.inspection.definitions.guards) {
      disposers.push(scope.tools.guard(execution => definition.tools.includes(execution.name)
        ? plugin.evaluateGuard(definition.name, { toolName: execution.name, arguments: execution.arguments as JsonObject,
          successfulCalls: successfulCalls(execution.agent?.session), ...executionContext() }) : undefined));
    }
    for (const definition of plugin.inspection.definitions.tools) {
      if ([IMPROVER_TOOL, CONTEXT_SELECTOR_TOOL].includes(definition.name)) continue;
      if (!definition.name.startsWith("learned_")) throw new Error("An experimental tool cannot replace host tools");
      disposers.push(scope.tools.register({ name: definition.name, description: definition.description,
        parameters: definition.inputSchema as ToolDefinition["parameters"],
        output: { schema: definition.outputSchema as ToolDefinition["output"]["schema"],
          render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
        async execute(args, execution) {
          return executeCapabilityTool(scope, plugin, definition.name, args as JsonObject, execution, executionContext()) as Promise<JsonValue>;
        },
      }));
    }
  } catch (error) { dispose(); throw error; }
  return dispose;
}
