import { assertCapabilityManifest } from "@chopin/evolution";
import type { CapabilityManifest, CapabilityDispatch, CapabilityDispatchStep, ExecutionContext, JsonObject, JsonValue } from "@chopin/evolution";

export type Dispose = () => void | Promise<void>;

export interface PluginRequestContext {
  readonly workspace: string;
  readonly prompt: string;
  readonly environment?: ExecutionContext;
  readonly signal: AbortSignal;
}

export interface PluginToolExecution {
  readonly callId: string;
  readonly arguments: JsonObject;
  readonly environment?: ExecutionContext;
  readonly steps?: readonly CapabilityDispatchStep[];
  readonly signal: AbortSignal;
}

export interface PluginToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly dispatch?: CapabilityDispatch;
  execute(execution: PluginToolExecution): Promise<JsonValue>;
}

export interface PluginGuardExecution {
  readonly toolName: string;
  readonly arguments: JsonObject;
  readonly successfulCalls: readonly {
    name: string;
    arguments: JsonObject;
  }[];
  readonly environment?: ExecutionContext;
}

export interface PluginGuardDefinition {
  readonly name: string;
  readonly tools: readonly string[];
  evaluate(execution: PluginGuardExecution): string | undefined;
}

export interface PluginContextDefinition {
  readonly name: string;
  readonly order: number;
  render(context: PluginRequestContext): string;
}

export interface PluginRuntimeContext {
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly signal: AbortSignal;
  registerContext(definition: PluginContextDefinition): Dispose;
  registerGuard(definition: PluginGuardDefinition): Dispose;
  registerTool(definition: PluginToolDefinition): Dispose;
}

export interface ChopinPlugin {
  readonly manifest: CapabilityManifest;
  activate(context: PluginRuntimeContext): void | Promise<void>;
}

/** Generated plugins depend on this layer only; DSH types and lifecycle stay with the host adapter. */
export function defineChopinPlugin(plugin: ChopinPlugin): ChopinPlugin {
  assertCapabilityManifest(plugin.manifest);
  if (plugin.manifest.runtime === "data") throw new Error("executable Chopin plugin cannot use data runtime");
  if (!new Set(["gate", "tool", "plugin"]).has(plugin.manifest.kind)) {
    throw new Error(`executable Chopin plugin cannot have kind ${plugin.manifest.kind}`);
  }
  if (typeof plugin.activate !== "function") throw new Error("Chopin plugin must define activate(context)");
  return Object.freeze(plugin);
}

export type {
  ArtifactEffect,
  ArtifactKind,
  ApplicabilityTrigger,
  ExecutionContext,
  CapabilityManifest,
  CapabilityDispatch,
  CapabilityDispatchStep,
  CapabilityDispatchDecision,
  CapabilityProvides,
  CapabilityRuntime,
  JsonObject,
  JsonValue,
} from "@chopin/evolution";
