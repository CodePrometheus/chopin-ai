/**
 * The chopin_smoke probe: creates an agent from the chopin preset inside the real composition,
 * confirms the preset mounts and every gated tool is visible to that agent, then exits. No
 * model requests at any point.
 *
 * The result goes to the file CHOPIN_SMOKE_RESULT points at, which smoke-composition.mjs reads for the verdict.
 *
 * @module scripts/smoke-plugin
 */

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export const name = "chopin-smoke";
export const inject = ["agents", "agentPresets", "tools", "loader"];

const PRESET = "chopin";
const DEADLINE_MS = 60_000;

export function apply(ctx) {
  const expected = JSON.parse(process.env.CHOPIN_SMOKE_EXPECT_TOOLS ?? "[]");
  const finish = async (result) => {
    if (process.env.CHOPIN_SMOKE_RESULT) await writeFile(process.env.CHOPIN_SMOKE_RESULT, `${JSON.stringify(result, null, 2)}\n`);
    ctx.loader.exit();
  };
  void probe(ctx, expected).then(finish, (error) => finish({ ok: false, error: String(error?.stack ?? error) }));
}

async function probe(ctx, expected) {
  const started = Date.now();
  // The preset declaration loads in parallel with the other rows; the probe may be ready first.
  let preset;
  for (;;) {
    try {
      preset = await ctx.agentPresets.resolve(PRESET);
      break;
    } catch (error) {
      if (Date.now() - started > DEADLINE_MS) throw error;
      await delay(200);
    }
  }
  if (preset.broken) return { ok: false, preset: preset.id, broken: preset.broken };
  const scope = await ctx.agentPresets.acquireScope(preset.id);
  try {
    const handle = await ctx.agents.create({
      sessionId: `chopin-smoke-${randomUUID()}`,
      meta: { cwd: process.cwd(), agentPreset: preset.id },
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, preset.id); },
    });
    try {
      let missing = expected;
      while (missing.length > 0 && Date.now() - started <= DEADLINE_MS) {
        missing = expected.filter((tool) => ctx.tools.get(tool, handle.agent) === undefined);
        if (missing.length > 0) await delay(200);
      }
      const after = await ctx.agentPresets.resolve(preset.id);
      return { ok: missing.length === 0 && !after.broken, preset: preset.id, checked: expected.length, missing, ...(after.broken ? { broken: after.broken } : {}) };
    } finally {
      await handle.dispose();
    }
  } finally {
    await scope[Symbol.asyncDispose]();
  }
}
