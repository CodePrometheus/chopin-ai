import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-commands";

import { experienceStatuses, readExperienceEvents, renderExperienceStatus } from "./status.js";
import { foldEvolutionEvents } from "@chopin/evolution";
import { readExperienceBody } from "./render.js";
import type {} from "./experiments.js";

export const name = "chopin-experience-commands";
export const inject = ["commands", "chopinEvolution"];

export function apply(ctx: Context): void {
  ctx.commands.register({
    name: "rsi", description: "Show self-evolution status; run explicitly authorizes a budgeted experiment, stop halts it, resume continues it",
    input: { hint: "[tasks|run <limit>|audit/recheck/probe <history> <limit> <fresh-task-file>|assess <history> <limit> [fresh-task-file]|stop|resume <id>]" },
    handler: async ({ agent, rawInput }) => {
      const executor = ctx.get("chopinExperiments");
      const [action, value, extra, taskFile, overflow] = rawInput.trim().split(/\s+/);
      if (action) {
        if (!executor) return { kind: "error", text: "The current runtime profile has no improvement executor." };
        if (action === "tasks" && !value) return { kind: "success", text: await executor.tasks(agent) };
        if (action === "run" && value && !extra && /^\d+$/.test(value)) {
          return { kind: "success", text: await executor.start(agent, Number(value), `/rsi ${rawInput.trim()}`) };
        }
        if (action === "audit" && value && extra && /^\d+$/.test(extra) && taskFile && !overflow) {
          return { kind: "success", text: await executor.audit(agent, value, Number(extra), taskFile, `/rsi ${rawInput.trim()}`) };
        }
        if (action === "recheck" && value && extra && /^\d+$/.test(extra) && taskFile && !overflow) {
          return { kind: "success", text: await executor.recheck(agent, value, Number(extra), taskFile, `/rsi ${rawInput.trim()}`) };
        }
        if (action === "probe" && value && extra && /^\d+$/.test(extra) && taskFile && !overflow) {
          return { kind: "success", text: await executor.probe(agent, value, Number(extra), taskFile, `/rsi ${rawInput.trim()}`) };
        }
        if (action === "assess" && value && extra && /^\d+$/.test(extra) && !overflow) {
          return { kind: "success", text: await executor.assess(agent, value, Number(extra), `/rsi ${rawInput.trim()}`, taskFile) };
        }
        if (action === "stop" && !value) return { kind: "success", text: await executor.stop(agent) };
        if (action === "resume" && value && !extra) return { kind: "success", text: await executor.resume(agent, value) };
        return { kind: "error", text: "Usage: /rsi run <limit>; audit/recheck/probe <history> <limit> <fresh-task-file>; assess <history> <limit> [fresh-task-file]; stop; resume <id>. Experiments consume model quota. Recheck, probe and assess with fresh tasks never deploy archived artifacts." };
      }
      const projection = foldEvolutionEvents(await readExperienceEvents(ctx.chopinEvolution.events.path));
      const strategy = await ctx.chopinEvolution.readImprover(agent);
      const records = projection.improvements ?? [];
      const generated = projection.artifacts.filter((artifact) => artifact.manifest.lineage.improvementId !== undefined);
      return { kind: "success", text: [
        `Current improver: ${strategy.reference.id}`,
        `Content digest: ${strategy.reference.contentDigest}`,
        `Routine plans: ${records.length}; linked artifacts: ${generated.length}; standalone experiments are listed separately. Version progression does not mean benefit has been verified.`,
        ...records.slice(-5).map((record) => `${record.id}: ${record.input.strategy.id} -> ${record.plan.actions.map((action) => action.key).join(", ") || "no actions"}`),
        ...(executor ? [await executor.status(agent)] : []),
      ].join("\n") };
    },
  });
  ctx.commands.register({
    name: "experience",
    description: "Show experience status, actual read records and sources without calling the model",
    input: { hint: "[full experience id|context]" },
    handler: async ({ agent, rawInput }) => {
      const id = rawInput.trim();
      if (id === "context") {
        const inspected = await ctx.chopinEvolution.inspectContext(agent);
        const selection = inspected.selection;
        if (!selection) return { kind: "success", text: "This session has no committed experience selection record yet." };
        return { kind: "success", text: [
          `Selection strategy: ${selection.strategy.id}; step record ${selection.stepSeq}`,
          ...(selection.fallback ? [`Fell back: ${selection.fallback.strategy.id}; ${selection.fallback.reason}`] : []),
          ...selection.applied.slice(0, 20).map((item) => `${item.id}: ${item.index ? "index " : ""}${item.inline ? "body " : ""}${item.chars} chars`),
          `Omitted ${selection.omitted}; loaded ${selection.applied.length} in total.`,
          `Usage reported by the reply: ${inspected.usage ? JSON.stringify(inspected.usage) : "not reported yet or still running"}`,
          ...(inspected.failedAttempts ? [`Plus ${inspected.failedAttempts} failed attempt(s); total consumption cannot be derived from this.`] : []),
          "Character counts are not billed tokens; neither loading nor savings implies better quality.",
        ].join("\n") };
      }
      const events = await readExperienceEvents(ctx.chopinEvolution.events.path);
      const projection = foldEvolutionEvents(events);
      const items = experienceStatuses(events, String(agent.session.id), projection);
      const selected = id === "" ? items : items.filter((item) => item.id === id);
      if (id !== "" && selected.length === 0) return { kind: "error", text: "Experience not found; use the full id from the list." };
      const artifact = id === "" ? undefined : projection.artifacts.find((item) => item.id === id);
      const body = artifact === undefined || !["memory", "skill"].includes(artifact.manifest.kind) ? ""
        : await readExperienceBody(ctx.chopinEvolution.artifacts, artifact, 16_000);
      return { kind: "success", text: [
        "Usage counts cover only the current session and the current deployment.", renderExperienceStatus(selected, id !== ""),
        ...(body ? ["Body (viewing does not count as a model read):", body] : []),
        ...(id === "" ? ["/experience context shows what was actually loaded; /experience <full id> shows the body; /instructions shows personal rules."] : []),
      ].join("\n") };
    },
  });
}
