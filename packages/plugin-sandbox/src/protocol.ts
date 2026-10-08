import type { CapabilityManifest, CapabilityDispatch, CapabilityDispatchStep, ExecutionContext, JsonObject, JsonValue } from "@chopin/evolution";

export interface SandboxedContextDefinition {
  name: string;
  order: number;
}

export interface SandboxedGuardDefinition {
  name: string;
  tools: string[];
}

export interface SandboxedToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  dispatch?: CapabilityDispatch;
}

export interface SandboxedDefinitions {
  contexts: SandboxedContextDefinition[];
  guards: SandboxedGuardDefinition[];
  tools: SandboxedToolDefinition[];
}

export interface SandboxInspection {
  manifest: CapabilityManifest;
  definitions: SandboxedDefinitions;
}

export type SandboxAction =
  | { kind: "inspect" }
  | { kind: "context"; name: string; input: { workspace: string; prompt: string; environment?: ExecutionContext } }
  | {
      kind: "guard";
      name: string;
      input: { toolName: string; arguments: JsonObject; successfulCalls: Array<{ name: string; arguments: JsonObject }>; environment?: ExecutionContext };
    }
  | { kind: "tool"; name: string; input: { callId: string; arguments: JsonObject; environment?: ExecutionContext; steps?: CapabilityDispatchStep[] } };

export interface SandboxRequest {
  entryPath: string;
  capabilityId: string;
  capabilityVersion: string;
  action: SandboxAction;
}

export type SandboxSuccess =
  | { ok: true; kind: "inspect"; value: SandboxInspection }
  | { ok: true; kind: "context"; value: string }
  | { ok: true; kind: "guard"; value: string | null }
  | { ok: true; kind: "tool"; value: JsonValue };

export type SandboxResponse = SandboxSuccess | { ok: false; error: string };
