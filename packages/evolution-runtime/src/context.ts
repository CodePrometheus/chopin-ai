import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-system-prompt";
import { createUserMessage, type ContextFormed } from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";
import { CONTEXT_SELECTOR_TOOL, foldEvolutionEvents } from "@chopin/evolution";

import { evolutionQueue, renderEvolutionQueue } from "./queue.js";
import { experienceStatuses, experienceStatusLine } from "./status.js";
import { literalContext } from "./literal-context.js";
import { registerSessionCapability } from "./integrity.js";

export const name = "chopin-evolution-context";
export const inject = ["systemPrompt", "chopinEvolution"];

const NOTICE_SOURCE = "chopin-experience";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "chopin-experience": { kind: "chopin-experience" } & ContextFormed;
  }
}

export async function publishExperienceNotice(ctx: Context, session: Session): Promise<void> {
  await ctx.chopinEvolution.flushExposures(String(session.id));
  const history = await ctx.chopinEvolution.events.readAll();
  const projection = foldEvolutionEvents(history);
  const relevant = new Set(history.filter((event) => event.type === "artifact.exposure-recorded"
    && event.data.sessionId === String(session.id)).map((event) => event.entityId));
  for (const artifact of projection.artifacts) {
    if (artifact.approvalReceipts.some((receipt) => receipt.sessionId === String(session.id))) relevant.add(artifact.id);
  }
  const items = experienceStatuses(history, String(session.id), projection).filter((item) => relevant.has(item.id));
  if (items.length === 0) return;
  const text = ["Experience status (current session):", ...items.slice(-8).map(experienceStatusLine), "/experience shows sources and full status."].join("\n");
  const previous = session.snapshotEvents().findLast((event) => event.type === "user/message"
    && event.data.source.kind === NOTICE_SOURCE);
  if (previous?.type === "user/message" && previous.data.content.some((block) => block.type === "text" && block.text === text)) return;
  const summary = `${new Set(items.map(item => item.familyId)).size} experience(s), ${items.filter((item) => item.enabled).length} enabled; loaded ${items.reduce((sum, item) => sum + item.loaded, 0)} and read ${items.reduce((sum, item) => sum + item.read, 0)} time(s) this session. See /experience`;
  session.append("user/message", createUserMessage({
    source: { kind: NOTICE_SOURCE, form: "notice", summary },
    content: [{ type: "text", text }],
  }), { surfaceOp: "append" });
  const toast = ctx.get("tuiToast") as { show(text: string, options?: { timeoutMs?: number }): boolean } | undefined;
  toast?.show(summary, { timeoutMs: 8_000 });
}

/**
 * Every model step: first let the host advance whatever it can on its own, then put
 * two things into context -- the experience index matching the current task, and the
 * evolution queue of what only the model or a person can do.
 */
export async function apply(ctx: Context): Promise<void> {
  let notices = Promise.resolve();
  ctx.on("session/event", (session, event) => {
    if (event.type !== "turn/end") return;
    notices = notices.then(async () => {
      await publishExperienceNotice(ctx, session);
    }).catch((error) => ctx.logger.warn("experience notice failed: %s", (error as Error).message));
  });
  ctx.on("session/flush", async () => { await notices; });
  await ctx.chopinEvolution.reconcileDataGeneration();
  await ctx.chopinEvolution.advance();
  registerSessionCapability(ctx, "experience-context");
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    const result = await next();
    // The selector is invoked by the host; the full interface is only handed to the model on explicit inspection.
    result.tools = result.tools.filter((tool) => tool.name !== CONTEXT_SELECTOR_TOOL);
    if (context.agent === undefined) return result;
    try {
      await ctx.chopinEvolution.advance();
    } catch (error) {
      ctx.logger.warn("evolution advance skipped: %s", (error as Error).message);
    }
    try {
      const experience = await ctx.chopinEvolution.prepareExperienceContext(context.agent, context.signal);
      if (experience.index.text !== "") result.contexts.push(literalContext(result, "chopin:experience", experience.index.text));
      result.contexts.push(...experience.inline.map(({ name, text }) => literalContext(result, name, text)));
    } catch (error) {
      throw new Error("Experience context could not be prepared; refusing to continue without it", { cause: error });
    }
    try {
      const queue = renderEvolutionQueue(evolutionQueue(await ctx.chopinEvolution.events.fold()));
      if (queue !== "") result.contexts.push(literalContext(result, "chopin:evolution-queue", queue));
      const maintenance = await ctx.chopinEvolution.maintenanceContextFor(context.agent);
      if (maintenance !== "") result.contexts.push(literalContext(result, "chopin:maintenance", maintenance));
      const improvement = await ctx.chopinEvolution.improvementContextFor(context.agent);
      if (improvement !== "") result.contexts.push(literalContext(result, "chopin:improvement", improvement));
    } catch (error) {
      ctx.logger.warn("evolution queue skipped: %s", (error as Error).message);
    }
    return result;
  });
}
