import { createHash } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import { candidateIdFor, candidateObserved, evaluateFeedbackWindow, foldEvolutionEvents } from "@chopin/evolution";
import type { ArtifactProjection, EvolutionEvent, FeedbackWindow } from "@chopin/evolution";
import { parseGateDenial } from "@chopin/gate";
import type {} from "@chopin/gate";
import type {} from "@chopin/evolution-runtime";
import { cumulativeWindow, latestFeedbackDeployment, selectFeedbackArtifacts, sessionOutcomeWindow } from "@chopin/evolution-runtime";
import { buildSignalKey, scrub } from "@chopin/ledger";

export const name = "chopin-evolution-observer";
export const inject = ["chopinEvolution"];

const OBSERVER_ACTOR = "chopin-session-observer";

type ToolResultEvent = Extract<SessionEvent, { type: "tool/result" }>;
type TurnEndEvent = Extract<SessionEvent, { type: "turn/end" }>;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resultText(event: ToolResultEvent): { callId: string; isError: boolean; text: string } {
  const result = event.data.message;
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
  return { callId: String(result.toolCallId), isError: result.isError === true, text };
}

function toolName(session: Pick<Session, "snapshotEvents">, callId: string): string {
  const events = session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "tool/call" && String(event.data.callId) === callId) return event.data.name;
  }
  return "unknown";
}

/** Turn a committed failure result into observed evidence; no root cause is inferred. */
export function observeToolFailure(
  session: Pick<Session, "id" | "snapshotEvents">,
  event: ToolResultEvent,
): EvolutionEvent | undefined {
  const result = resultText(event);
  if (result === undefined || !result.isError) return undefined;
  const sample = scrub(result.text).replace(/\s+/g, " ").trim().slice(0, 400);
  if (sample === "") return undefined;
  const tool = toolName(session, result.callId);
  const denial = parseGateDenial(result.text);
  const kind = denial === undefined ? "tool-failure" : "gate-rejection";
  const signalKey = buildSignalKey({ kind, tool, gate: denial?.unmet.join("+"), error: sample });
  const candidateId = candidateIdFor(signalKey);
  const sessionId = String(session.id);
  const evidenceId = `evidence-${hash(`${sessionId}\0${result.callId}\0${signalKey}`)}`;
  const occurredAt = new Date(event.time).toISOString();
  return candidateObserved({
    candidateId,
    eventId: `observed-${hash(evidenceId)}`,
    occurredAt,
    actor: { kind: "system", id: OBSERVER_ACTOR },
  }, {
    signalKey,
    lesson: `Repeated ${kind} observed for ${tool}; root cause is not classified. Sample: ${sample}`,
    evidence: {
      evidenceId,
      class: "session-signal",
      independenceKey: sessionId,
      independentUnits: 1,
      observedAt: occurredAt,
      contentHash: `sha256:${hash(sample)}`,
      summary: sample,
      sourceSessionId: sessionId,
      sourceAttemptId: result.callId,
      sourceRef: `session:${sessionId}:event:${event.seq}`,
    },
  });
}

function argumentKeys(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).sort() : [];
}

/**
 * The most recent successful call of the same tool in this session, before the failure:
 * what differed in the arguments and which tools ran just before. A contrast is context
 * for classification, never an independent unit of evidence.
 */
export function observeToolContrast(
  session: Pick<Session, "id" | "snapshotEvents">,
  event: ToolResultEvent,
  observed: EvolutionEvent,
): EvolutionEvent | undefined {
  const events = session.snapshotEvents();
  const failedCallId = String(event.data.message.toolCallId);
  const tool = toolName(session, failedCallId);
  const failedCall = events.find((item) => item.type === "tool/call" && String(item.data.callId) === failedCallId);
  if (failedCall?.type !== "tool/call") return undefined;
  const calls = new Map<string, Extract<SessionEvent, { type: "tool/call" }>>();
  let success: { call: Extract<SessionEvent, { type: "tool/call" }>; result: ToolResultEvent } | undefined;
  for (const item of events) {
    if (item.seq >= event.seq) break;
    if (item.type === "tool/call") calls.set(String(item.data.callId), item);
    if (item.type !== "tool/result" || item.data.message.isError === true) continue;
    const call = calls.get(String(item.data.message.toolCallId));
    if (call !== undefined && call.data.name === tool && call.seq < failedCall.seq) success = { call, result: item };
  }
  if (success === undefined) return undefined;
  const succeeded = argumentKeys(success.call.data.arguments);
  const failed = argumentKeys(failedCall.data.arguments);
  const preceding = events
    .filter((item): item is Extract<SessionEvent, { type: "tool/call" }> => item.type === "tool/call" && item.seq < success.call.seq)
    .slice(-3).map((item) => item.data.name);
  const summary = scrub([
    `Earlier ${tool} call succeeded in this session.`,
    `Successful argument keys: [${succeeded.join(", ")}]; failing keys: [${failed.join(", ")}].`,
    `Tools before the success: [${preceding.join(", ")}].`,
  ].join(" ")).slice(0, 400);
  const sessionId = String(session.id);
  const data = observed.data as { signalKey: string; lesson: string };
  const evidenceId = `evidence-${hash(`${sessionId}\0${success.call.data.callId}\0${data.signalKey}\0contrast`)}`;
  return candidateObserved({
    candidateId: observed.entityId,
    eventId: `observed-${hash(evidenceId)}`,
    occurredAt: observed.occurredAt,
    actor: { kind: "system", id: OBSERVER_ACTOR },
  }, {
    signalKey: data.signalKey,
    lesson: data.lesson,
    evidence: {
      evidenceId,
      class: "contrast",
      independenceKey: sessionId,
      independentUnits: 1,
      observedAt: observed.occurredAt,
      contentHash: `sha256:${hash(summary)}`,
      summary,
      sourceSessionId: sessionId,
      sourceAttemptId: String(success.call.data.callId),
      sourceRef: `session:${sessionId}:event:${success.result.seq}`,
    },
  });
}

/**
 * A preventive capability was activated in this session and the signal it should have
 * blocked showed up anyway: record one contradiction immediately. Advisory blocks
 * nothing, so one recurrence cannot convict it; it is judged by delivery outcomes in
 * the cumulative window only.
 */
export function recurrenceWindow(
  artifact: ArtifactProjection,
  events: readonly EvolutionEvent[],
  sessionId: string,
  observed: EvolutionEvent,
): FeedbackWindow | undefined {
  if (artifact.state !== "active" && artifact.state !== "canary-active" && artifact.state !== "retired") return undefined;
  if (artifact.manifest.intendedEffect !== "preventive") return undefined;
  if (!artifact.manifest.lineage.candidateIds.includes(observed.entityId)) return undefined;
  const deployment = latestFeedbackDeployment(artifact);
  if (deployment === undefined) return undefined;
  const observedMs = Date.parse(observed.occurredAt);
  const observedIndex = events.findIndex((event) => event.eventId === observed.eventId);
  const exposures = events.filter((event, eventIndex) => {
    const occurredMs = Date.parse(event.occurredAt);
    const beforeObserved = occurredMs < observedMs
      || (occurredMs === observedMs && observedIndex >= 0 && eventIndex < observedIndex);
    return event.entityId === artifact.id
      && event.type === "artifact.exposure-recorded"
      && event.data.sessionId === sessionId
      && event.data.contentDigest === artifact.contentDigest
      && occurredMs >= Date.parse(deployment.endedAt)
      && beforeObserved;
  });
  const activated = exposures.filter((event) =>
    event.data.phase === "injected" || event.data.phase === "tool-called" || event.data.phase === "gate-evaluated").length;
  const selected = exposures.filter((event) => event.data.phase === "selected").length;
  const eligible = Math.max(selected, activated);
  const sourceRef = (observed.data.evidence as { sourceRef?: unknown }).sourceRef;
  if (typeof sourceRef !== "string") return undefined;
  return {
    windowId: `window-${hash(`${artifact.id}\0${sessionId}\0${observed.eventId}`)}`,
    deploymentReceiptId: deployment.receiptId,
    artifactId: artifact.id,
    contentDigest: artifact.contentDigest,
    intendedEffect: artifact.manifest.intendedEffect,
    startedAt: deployment.endedAt,
    endedAt: observed.occurredAt,
    eligible,
    activated,
    recurrence: activated > 0 ? 1 : 0,
    prevented: 0,
    falseTrigger: 0,
    falseBlock: 0,
    independentSuccesses: 0,
    taskPass: 0,
    taskFail: activated > 0 ? 1 : 0,
    retryDelta: 0,
    costDeltaUsd: 0,
    latencyDeltaMs: 0,
    evidenceRefs: [sourceRef],
  };
}

async function recordRecurrence(ctx: Context, sessionId: string, observed: EvolutionEvent): Promise<void> {
  await ctx.chopinEvolution.flushExposures(sessionId);
  const events = await ctx.chopinEvolution.events.readAll();
  const projection = foldEvolutionEvents(events);
  for (const artifact of selectFeedbackArtifacts(projection)) {
    const window = recurrenceWindow(artifact, events, sessionId, observed);
    if (window === undefined) continue;
    await ctx.chopinEvolution.recordFeedback(window, {
      actorId: OBSERVER_ACTOR,
      observedAt: observed.occurredAt,
    });
  }
}

/** Names of gate-guarded submission tools; a composition without chopinGates has no such thing as "delivery success". */
function guardedTools(ctx: Context): ReadonlySet<string> {
  return new Set(ctx.get("chopinGates")?.guardedTools() ?? []);
}

/**
 * Turn end: write an outcome snapshot for every experience used in this session, then
 * fold the snapshots of all sessions under the same deployment into a cumulative
 * window. Natural execution provides only observations and negative feedback; it does
 * not prove the capability brought any gain.
 */
export async function recordSessionOutcomes(
  ctx: Context,
  session: Pick<Session, "id" | "snapshotEvents">,
  event: TurnEndEvent,
): Promise<void> {
  const endedAt = new Date(event.time).toISOString();
  const sessionSnapshot = { id: String(session.id), events: session.snapshotEvents() };
  await ctx.chopinEvolution.flushExposures(sessionSnapshot.id);
  const tools = guardedTools(ctx);
  const events = await ctx.chopinEvolution.events.readAll();
  const projection = foldEvolutionEvents(events);
  for (const artifact of selectFeedbackArtifacts(projection)) {
    const deployment = latestFeedbackDeployment(artifact);
    if (deployment === undefined) continue;
    const snapshot = sessionOutcomeWindow({
      artifact,
      deployment,
      events,
      session: sessionSnapshot,
      turn: event.data.turn,
      endedAt,
      guardedTools: tools,
    });
    if (snapshot === undefined || artifact.feedbackWindows.some((window) => window.windowId === snapshot.windowId)) continue;
    const observedAt = new Date(Math.max(Date.now(), Date.parse(endedAt))).toISOString();
    await ctx.chopinEvolution.recordFeedback(snapshot, { actorId: OBSERVER_ACTOR, observedAt }, { applyVerdict: false });

    const current = (await ctx.chopinEvolution.events.fold()).artifacts.find((item) => item.id === artifact.id);
    if (current === undefined) continue;
    const cumulative = cumulativeWindow(current, deployment);
    if (cumulative === undefined || current.feedbackWindows.some((window) => window.windowId === cumulative.windowId)) continue;
    await ctx.chopinEvolution.recordFeedback(cumulative, {
      actorId: OBSERVER_ACTOR,
      observedAt: new Date(Math.max(Date.now(), Date.parse(cumulative.endedAt))).toISOString(),
    }, { applyVerdict: evaluateFeedbackWindow(cumulative) !== "confirm" });
  }
}

export function apply(ctx: Context): void {
  const pending = new Set<Promise<void>>();
  const track = (work: Promise<void>, label: string): void => {
    const tracked = work
      .catch((error) => ctx.logger.warn("%s failed: %s", label, (error as Error).message))
      .finally(() => pending.delete(tracked));
    pending.add(tracked);
  };
  ctx.on("session/event", (session, event) => {
    if (event.type === "turn/end") {
      track(recordSessionOutcomes(ctx, session, event), "evolution session outcome");
      return;
    }
    if (event.type !== "tool/result") return;
    const observed = observeToolFailure(session, event);
    if (observed === undefined) return;
    const contrast = observeToolContrast(session, event, observed);
    track(
      ctx.chopinEvolution.events.appendMany(contrast === undefined ? [observed] : [observed, contrast])
        .then(() => recordRecurrence(ctx, String(session.id), observed)),
      "evolution observation",
    );
  });
  ctx.on("session/flush", async () => {
    await Promise.all([...pending]);
  });
}
