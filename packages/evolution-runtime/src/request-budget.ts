import { randomUUID } from "node:crypto";
import { access, link, mkdir, open, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { LlmError, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { TokenUsage } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-agent";
import z from "@deepseek-ai/schemastery";
import { canonicalJson } from "@chopin/evolution";

export interface BudgetIdentity {
  runId: string;
  provider: string;
  model?: string;
  maxRequests: number;
  phaseLimits?: Record<string, number>;
}

export interface Config extends BudgetIdentity {
  directory: string;
  phase?: string;
  phaseLimit?: number;
  reasoningEffort?: string;
}

export const name = "chopin-request-budget";
export const inject = ["llm"];
export const Config: z<Config> = z.object({
  directory: z.string().required(), runId: z.string().required(),
  provider: z.string().required(), model: z.string(),
  maxRequests: z.number().required(),
  phase: z.string(), phaseLimit: z.number(),
  reasoningEffort: z.string(),
});

export interface RequestReservation {
  sequence: number;
  requestId: string;
  startedAt: string;
  provider: string;
  model: string;
  sessionId?: string;
  phase?: string;
}

export interface RequestSettlement {
  requestId: string;
  endedAt: string;
  outcome: string;
  usage?: TokenUsage;
}

async function createExclusive(path: string, value: unknown): Promise<boolean> {
  try { await access(path); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const records = join(dirname(path), "records");
  await mkdir(records, { recursive: true, mode: 0o700 });
  const record = join(records, `${randomUUID()}.json`);
  const file = await open(record, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
  } finally { await file.close(); }
  // Publish atomically only after the full record is on disk; the raw record stays for auditing attempts that never published.
  try { await link(record, path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  return true;
}

function slot(sequence: number): string {
  return String(sequence).padStart(6, "0");
}

/** Every request takes one persistent slot exclusively; failures and interruptions never return it, and it cannot be consumed twice across processes. */
export class RequestBudget {
  readonly identity: BudgetIdentity;

  constructor(readonly directory: string, identity: BudgetIdentity, readonly phase?: { id: string; limit: number }) {
    if (!Number.isSafeInteger(identity.maxRequests) || identity.maxRequests < 1 || identity.maxRequests > 120) {
      throw new Error("request limit must be an integer between 1 and 120");
    }
    if (!identity.runId.trim() || !identity.provider.trim() || identity.model?.trim() === "") throw new Error("budget identity is incomplete");
    if (phase !== undefined && (!/^[a-z0-9-]+$/.test(phase.id) || !Number.isSafeInteger(phase.limit) || phase.limit < 1 || phase.limit > identity.maxRequests)) throw new Error("invalid phase budget");
    if (identity.phaseLimits !== undefined) {
      const limits = Object.entries(identity.phaseLimits);
      if (!limits.length || limits.some(([id, limit]) => !/^[a-z0-9-]+$/.test(id) || !Number.isSafeInteger(limit) || limit < 1)
        || limits.reduce((sum, [, limit]) => sum + limit, 0) > identity.maxRequests) throw new Error("invalid reserved phase allocation");
      if (phase && identity.phaseLimits[phase.id] !== phase.limit) throw new Error("phase does not match the sealed allocation");
    }
    this.identity = Object.freeze({ runId: identity.runId, provider: identity.provider, maxRequests: identity.maxRequests,
      ...(identity.model === undefined ? {} : { model: identity.model }),
      ...(identity.phaseLimits === undefined ? {} : { phaseLimits: Object.freeze({ ...identity.phaseLimits }) }) });
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "budget.json");
    await createExclusive(path, this.identity);
    await this.assertIdentity();
    if (this.phase !== undefined) {
      const directory = join(this.directory, this.phase.id);
      await mkdir(directory, { recursive: true });
      const path = join(directory, "phase.json");
      await createExclusive(path, this.phase);
      if (canonicalJson(JSON.parse(await readFile(path, "utf8"))) !== canonicalJson(this.phase)) throw new Error("phase budget changed");
    }
  }

  private async assertIdentity(): Promise<void> {
    const value = JSON.parse(await readFile(join(this.directory, "budget.json"), "utf8"));
    if (canonicalJson(value) !== canonicalJson(this.identity)) throw new Error("request budget identity changed");
  }

  async reserve(provider: string, model: string, sessionId?: string): Promise<RequestReservation> {
    await this.assertIdentity();
    if (this.identity.phaseLimits && !this.phase) throw new Error("A reserved run requires an allocated phase");
    if (provider !== this.identity.provider || (this.identity.model !== undefined && model !== this.identity.model)) {
      throw new LlmError("The requested model does not match this run's fixed route", "BUDGET_ROUTE_MISMATCH");
    }
    const route = join(this.directory, "route.json");
    await createExclusive(route, { provider, model });
    if (canonicalJson(JSON.parse(await readFile(route, "utf8"))) !== canonicalJson({ provider, model })) throw new LlmError("The model route changed during this run", "BUDGET_ROUTE_MISMATCH");
    if (this.phase !== undefined) {
      let reserved = false;
      for (let index = 1; index <= this.phase.limit; index += 1) {
        if (await createExclusive(join(this.directory, this.phase.id, `${slot(index)}.request.json`), { startedAt: new Date().toISOString() })) {
          reserved = true;
          break;
        }
      }
      if (!reserved) throw new LlmError("The fixed phase budget is exhausted", "REQUEST_BUDGET_EXHAUSTED");
    }
    for (let sequence = 1; sequence <= this.identity.maxRequests; sequence += 1) {
      const reservation: RequestReservation = {
        sequence, requestId: randomUUID(), startedAt: new Date().toISOString(), provider, model,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(this.phase === undefined ? {} : { phase: this.phase.id }),
      };
      if (await createExclusive(join(this.directory, `${slot(sequence)}.request.json`), reservation)) return reservation;
    }
    throw new LlmError("The authorized request budget is exhausted; no further model request was sent", "REQUEST_BUDGET_EXHAUSTED");
  }

  async settle(reservation: RequestReservation, settlement: RequestSettlement): Promise<void> {
    if (settlement.requestId !== reservation.requestId) throw new Error("request settlement identity differs");
    if (canonicalJson(JSON.parse(await readFile(join(this.directory, `${slot(reservation.sequence)}.request.json`), "utf8"))) !== canonicalJson(reservation)) throw new Error("request reservation changed");
    if (!(await createExclusive(join(this.directory, `${slot(reservation.sequence)}.result.json`), settlement))) {
      throw new Error("request already settled");
    }
  }

  async status(): Promise<{ limit: number; used: number; completed: number; remaining: number; usage: TokenUsage[];
    phaseUsed?: number; phaseUsage?: TokenUsage[]; phaseReserved?: number }> {
    await this.assertIdentity();
    const entries = await readdir(this.directory);
    const requests = entries.filter((entry) => /^\d{6}\.request\.json$/.test(entry));
    const phaseRequests = this.phase === undefined ? undefined : (await Promise.all(requests.map(async entry =>
      JSON.parse(await readFile(join(this.directory, entry), "utf8")) as RequestReservation))).filter(request => request.phase === this.phase!.id);
    const phaseIds = new Set(phaseRequests?.map(request => request.requestId));
    const results = await Promise.all(entries.filter((entry) => /^\d{6}\.result\.json$/.test(entry))
      .map(async (entry) => JSON.parse(await readFile(join(this.directory, entry), "utf8")) as RequestSettlement));
    const phaseRemaining = this.phase === undefined ? this.identity.maxRequests : this.phase.limit
      - (await readdir(join(this.directory, this.phase.id))).filter((name) => name.endsWith(".request.json")).length;
    return { limit: this.identity.maxRequests, used: requests.length, completed: results.length,
      ...(phaseRequests === undefined ? {} : { phaseUsed: phaseRequests.length, phaseReserved: this.phase!.limit - phaseRemaining,
        phaseUsage: results.filter(result => phaseIds.has(result.requestId)).flatMap(result => result.usage ? [result.usage] : []) }),
      remaining: Math.max(0, Math.min(phaseRemaining, this.identity.maxRequests - requests.length)),
      usage: results.flatMap((result) => result.usage === undefined ? [] : [result.usage]) };
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const budget = new RequestBudget(config.directory, {
    runId: config.runId, provider: config.provider, maxRequests: config.maxRequests,
    ...(config.model === undefined ? {} : { model: config.model }),
  }, config.phase === undefined ? undefined : { id: config.phase, limit: config.phaseLimit ?? config.maxRequests });
  await budget.initialize();
  ctx.on("agent/request", async (_event, next) => ({
    ...await next(), provider: config.provider,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(config.reasoningEffort) }),
  }));
  ctx.on("agent/pre-step", async (_event, next) => {
    if ((await budget.status()).remaining === 0) return { kind: "reject" };
    return next();
  });
  ctx.on("llm/stream", async function* (options, next) {
    const reservation = await budget.reserve(options.provider, options.model,
      options.sessionId === undefined ? undefined : String(options.sessionId));
    let usage: TokenUsage | undefined;
    let outcome = "interrupted";
    try {
      for await (const chunk of next()) {
        if (chunk.type === "usage") usage = chunk.usage;
        if (chunk.type === "finish") outcome = chunk.reason.kind;
        yield chunk;
      }
    } catch (error) {
      outcome = "error";
      throw error;
    } finally {
      await budget.settle(reservation, { requestId: reservation.requestId, endedAt: new Date().toISOString(), outcome,
        ...(usage === undefined ? {} : { usage }) });
    }
  });
}
