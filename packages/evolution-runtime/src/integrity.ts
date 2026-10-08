import { Context, Service } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { isAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

export const name = "chopin-session-integrity";
export const inject = ["agents", "systemPrompt", "tools"];

type RequestCheck = (request: GenerateOptions, agent: Agent) => void;

export interface Config { preset: string; requiredTools: string[] }
export const Config: z<Config> = z.object({
  preset: z.string().default("chopin"),
  requiredTools: z.array(z.string()).default(["experience_read", "evolution_experience_record", "evolution_context_inspect"]),
});

declare module "@deepseek-ai/cordis" {
  interface Context { chopinSessionIntegrity: SessionIntegrity }
}

export class SessionIntegrity extends Service {
  private readonly registrations = new WeakMap<Agent, Map<string, Set<symbol>>>();
  private readonly checks = new WeakMap<Agent, Map<symbol, RequestCheck>>();

  constructor(ctx: Context, readonly config: Config) { super(ctx, "chopinSessionIntegrity"); }

  register(agent: Agent, capability: string, check?: RequestCheck): () => void {
    const roles = this.registrations.get(agent) ?? new Map<string, Set<symbol>>();
    this.registrations.set(agent, roles);
    const instances = roles.get(capability) ?? new Set<symbol>();
    roles.set(capability, instances);
    const instance = Symbol();
    instances.add(instance);
    const checks = this.checks.get(agent) ?? new Map<symbol, RequestCheck>();
    this.checks.set(agent, checks);
    if (check) checks.set(instance, check);
    return () => { instances.delete(instance); checks.delete(instance); };
  }

  checkRequest(agent: Agent, request: GenerateOptions): void {
    const missing = this.missing(agent, request.tools);
    if (missing.length > 0) throw new Error(`Session composition is incomplete: ${missing.join(", ")}.`);
    for (const check of this.checks.get(agent)?.values() ?? []) check(request, agent);
  }

  missing(agent: Agent, tools?: readonly { name: string }[]): string[] {
    const selected = agent.session.snapshotEvents().findLast((event) => String(event.type) === "agent-preset/selected");
    const preset = selected === undefined ? agent.session.header.agentPreset
      : (selected.data as { agentPreset?: string }).agentPreset;
    if (preset !== this.config.preset) return [];
    const roles = this.registrations.get(agent);
    return [
      ...["personal-instructions", "experience-context"].filter((role) => !roles?.get(role)?.size),
      ...(tools === undefined ? [] : this.config.requiredTools.filter((name) => !tools.some((tool) => tool.name === name))),
    ];
  }
}

export function registerSessionCapability(ctx: Context, capability: string, check?: RequestCheck): void {
  const service = ctx.get("chopinSessionIntegrity");
  if (service === undefined) return;
  const releases = new Map<Agent, () => void>();
  ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    if (context.agent !== undefined && !releases.has(context.agent)) {
      releases.set(context.agent, service.register(context.agent, capability, check));
    }
    return next();
  });
  ctx.on("agent/disposed", ({ agent }) => {
    releases.get(agent)?.();
    releases.delete(agent);
  });
  ctx.effect(() => () => {
    for (const release of releases.values()) release();
    releases.clear();
  });
}

export function apply(ctx: Context, config: Config): void {
  const service = new SessionIntegrity(ctx, config);
  ctx.on("llm/stream", async function* (request, next) {
    if (isAgentLoopRequest(request) && request.sessionId !== undefined) {
      const agent = ctx.agents.get(request.sessionId);
      if (agent === undefined) throw new Error("Request has no live owning session");
      service.checkRequest(agent, request);
    }
    yield* next();
  });
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    const result = await next();
    const missing = context.agent === undefined ? [] : service.missing(context.agent, result.tools);
    if (missing.length > 0) throw new Error(`Session composition is incomplete: ${missing.join(", ")}. Restore the configured preset before continuing.`);
    return result;
  });
  ctx.tools.guard((execution) => {
    const missing = execution.agent === undefined ? [] : service.missing(execution.agent);
    return missing.length === 0 ? undefined : `Session composition is incomplete: ${missing.join(", ")}.`;
  });
}
