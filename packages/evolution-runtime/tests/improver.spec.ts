import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { assertImprovementPlan, baselineImprover, improvementDigest, foldEvolutionEvents, improvementPlanned } from "@chopin/evolution";
import type { ImprovementInput, ImprovementRecord } from "@chopin/evolution";
import { RequestBudget } from "../src/request-budget.js";
import { ChopinEvolution } from "../src/index.js";
import { renderImprovement, runImprover } from "../src/improver.js";
import { cleanupTemporaryDirectories, fakeAgent, temporaryDirectory, userMessage } from "./support.js";

afterEach(cleanupTemporaryDirectories);

describe("persistent request budget", () => {
  it("concurrent first initialization and contention hand out at most the authorized count; restarts and failures do not return slots", async () => {
    const root = await temporaryDirectory();
    const identity = { runId: "concurrent-run", provider: "subscription", model: "fixed-model", maxRequests: 6 };
    const instances = Array.from({ length: 12 }, () => new RequestBudget(root, identity));
    await Promise.all(instances.map((budget) => budget.initialize()));
    const attempts = await Promise.allSettled(instances.map((budget) => budget.reserve(identity.provider, identity.model)));
    const issued = attempts.flatMap((attempt) => attempt.status === "fulfilled" ? [attempt.value] : []);
    expect(issued).toHaveLength(6);
    expect(new Set(issued.map((item) => item.sequence)).size).toBe(6);
    for (const attempt of attempts) if (attempt.status === "rejected") expect(attempt.reason.code).toBe("REQUEST_BUDGET_EXHAUSTED");
    await instances[0]!.settle(issued[0]!, { requestId: issued[0]!.requestId, endedAt: new Date().toISOString(), outcome: "error" });
    const restored = new RequestBudget(root, identity);
    await restored.initialize();
    expect(await restored.status()).toMatchObject({ used: 6, completed: 1, remaining: 0 });
    await expect(restored.reserve(identity.provider, identity.model)).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXHAUSTED" });
    await expect(new RequestBudget(root, { ...identity, maxRequests: 7 }).initialize()).rejects.toThrow("identity changed");
  });

  it("group caps and model routing constrain independently; a wrong route consumes no quota", async () => {
    const root = await temporaryDirectory();
    const identity = { runId: "paired-run", provider: "subscription", model: "fixed-model", maxRequests: 6 };
    const first = new RequestBudget(root, identity, { id: "first", limit: 2 });
    await first.initialize();
    await expect(first.reserve("other", identity.model)).rejects.toMatchObject({ code: "BUDGET_ROUTE_MISMATCH" });
    await expect(first.reserve(identity.provider, "other-model")).rejects.toMatchObject({ code: "BUDGET_ROUTE_MISMATCH" });
    expect((await first.status()).used).toBe(0);
    await Promise.all([first.reserve(identity.provider, identity.model), first.reserve(identity.provider, identity.model)]);
    await expect(first.reserve(identity.provider, identity.model)).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXHAUSTED" });
    const second = new RequestBudget(root, identity, { id: "second", limit: 2 });
    await second.initialize();
    await second.reserve(identity.provider, identity.model);
    expect(await second.status()).toMatchObject({ used: 3, remaining: 1 });
    await expect(new RequestBudget(root, identity, { id: "first", limit: 3 }).initialize()).rejects.toThrow("phase budget changed");
  });
});

describe("improver contract and provenance", () => {
  const input: ImprovementInput = { schemaVersion: 1, objective: "Improve an assigned capability.", strategy: baselineImprover(),
    budget: { maxActions: 1 }, work: [{ key: "assigned", action: "improve-capability", targetId: "capability", detail: "Inspect actual evidence.", evidenceUnits: 1 }], history: [] };

  it("rejects unknown work, duplicate work, host operations and over-quota plans; long content is read on demand only", async () => {
    const valid = await runImprover(input);
    const action = valid.actions[0]!;
    for (const plan of [
      { ...valid, actions: [{ ...action, key: "unapproved" }] },
      { ...valid, actions: [action, action] },
      { ...valid, policy: { allowShell: true } },
      { ...valid, actions: [{ ...action, instructions: "x".repeat(4_001) }] },
    ]) expect(() => assertImprovementPlan(plan, input)).toThrow();
    const plan = { ...valid, actions: [{ ...action, instructions: "x".repeat(2_000) }] };
    const record: ImprovementRecord = { id: "record", sessionId: "session", requestId: "request", input,
      inputDigest: improvementDigest(input), plan, planDigest: improvementDigest(plan), createdAt: new Date().toISOString() };
    expect(renderImprovement(record).length).toBeLessThanOrEqual(1_600);
    const event = improvementPlanned(record);
    expect(foldEvolutionEvents([event]).improvements?.[0]?.plan).toEqual(plan);
    expect(() => foldEvolutionEvents([{ ...event, data: { record: { ...record, planDigest: improvementDigest(valid) } } } as never])).toThrow();
  });

  it("a user request yields a traceable self-version proposal; the same plan is not booked twice and is not benefit evidence", async () => {
    const root = await temporaryDirectory();
    const ctx = new Context();
    try {
      const service = new ChopinEvolution(ctx, { eventsFile: join(root, "events.jsonl"), artifactsDir: join(root, "artifacts"),
        receiptsDir: join(root, "receipts"), processGeneration: "trial", chopinVersion: "0.1.0", dshVersion: "0.1.3-alpha.1" });
      const agent = fakeAgent("strategy-session", [userMessage("Improve the current improvement algorithm.", Date.now())], root);
      const proposal = await service.proposeImprover(agent, "proposal-call" as never, "Make future improvements evidence-directed.");
      const plan = await service.planImprovement(agent, true);
      expect(plan.id).toBe(proposal.improvementId);
      expect(proposal.manifest.lineage.improvementId).toBe(plan.id);
      expect(proposal.manifest.permissions).toEqual(["tools:register"]);
      const projection = await service.events.fold();
      expect(projection.improvements).toHaveLength(1);
      expect(projection.candidates[0]?.evidence[0]).toMatchObject({ class: "user-request", sourceSessionId: "strategy-session" });
      expect(projection.artifacts).toHaveLength(0);
    } finally { await ctx.fiber.dispose(); }
  });
});
