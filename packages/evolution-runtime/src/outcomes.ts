import { createHash } from "node:crypto";

import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ArtifactProjection, DeploymentReceipt, EvolutionEvent, FeedbackWindow } from "@chopin/evolution";

/**
 * Session outcome: after an experience was used in a session, did things work out or
 * break again.
 *
 * Judged entirely from the log, with no model involved: exposure comes from exposure
 * events, recurrence from new observations on lineage candidates, delivery success
 * from one successful call to a gate-guarded submission tool. A snapshot is written at
 * every turn end and folded across sessions into a cumulative window; task success
 * stays an observation and never implies capability gain.
 */

export const SESSION_WINDOW_PREFIX = "session-";
export const CUMULATIVE_WINDOW_PREFIX = "cumulative-";
const SESSION_REF = /^session:(.+):turn:(\d+)$/;
const ACTIVATING_PHASES = new Set(["injected", "tool-called", "gate-evaluated"]);

interface SubmissionOrderBoundary {
  activationSeq?: number;
  inclusiveCallId?: string;
  maxTurn?: number;
}

export interface OutcomeSession {
  readonly id: string;
  readonly events: readonly SessionEvent[];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sessionRef(sessionId: string, turn: number): string {
  return `session:${sessionId}:turn:${turn}`;
}

function parseSessionRef(value: string | undefined): { sessionId: string; turn: number } | undefined {
  if (value === undefined) return undefined;
  const match = SESSION_REF.exec(value);
  if (match === null) return undefined;
  return { sessionId: match[1] as string, turn: Number(match[2]) };
}

/** The first successful call to a gate-guarded submission tool in this session after the activation boundary; a same-millisecond tie needs the session seq to prove order. */
export function acceptedSubmissionRef(
  session: OutcomeSession,
  guardedTools: ReadonlySet<string>,
  sinceMs: number,
  untilMs = Number.POSITIVE_INFINITY,
  boundary: SubmissionOrderBoundary = {},
): string | undefined {
  if (guardedTools.size === 0) return undefined;
  const calls = new Map<string, { name: string; startedAt: number; seq: number; turn: number }>();
  for (const event of session.events) {
    if (event.type === "tool/call") {
      calls.set(String(event.data.callId), { name: event.data.name, startedAt: event.time, seq: event.seq, turn: event.data.turn });
      continue;
    }
    if (event.type !== "tool/result" || event.time < sinceMs || event.time > untilMs) continue;
    if (boundary.maxTurn !== undefined && event.data.turn > boundary.maxTurn) continue;
    const result = event.data.message;
    if (result.isError === true) continue;
    const callId = String(result.toolCallId);
    const call = calls.get(callId);
    if (call === undefined || !guardedTools.has(call.name)) continue;
    if (event.seq <= call.seq) continue;
    if (boundary.maxTurn !== undefined && call.turn > boundary.maxTurn) continue;
    if (call.startedAt < sinceMs || call.startedAt > untilMs) continue;
    if (boundary.activationSeq !== undefined) {
      if (call.seq < boundary.activationSeq) continue;
      if (call.seq === boundary.activationSeq && callId !== boundary.inclusiveCallId) continue;
      if (event.seq <= boundary.activationSeq) continue;
    } else if (call.startedAt === sinceMs || event.time === sinceMs) continue;
    return `session:${String(session.id)}:event:${event.seq}`;
  }
  return undefined;
}

function exposureSessionBoundary(
  session: Pick<OutcomeSession, "events">,
  exposure: EvolutionEvent,
): { seq?: number; inclusiveCallId?: string } {
  if (typeof exposure.data.sourceEventSeq === "number") return { seq: exposure.data.sourceEventSeq };
  const callId = typeof exposure.data.callId === "string" ? exposure.data.callId : undefined;
  if (callId !== undefined) {
    const call = session.events.find((event) => event.type === "tool/call" && String(event.data.callId) === callId);
    if (call !== undefined) {
      const sameCallActivated = exposure.data.phase === "tool-called" || exposure.data.phase === "gate-evaluated";
      return { seq: call.seq, ...(sameCallActivated ? { inclusiveCallId: callId } : {}) };
    }
  }
  const requestId = exposure.data.requestId;
  if (typeof requestId !== "string") return {};
  const step = session.events.find((event) =>
    event.type === "step/start"
    && requestId.endsWith(`:${event.data.turn}:${event.data.step}`));
  return step === undefined ? {} : { seq: step.seq };
}

export interface SessionOutcomeInput {
  artifact: ArtifactProjection;
  /** The currently effective successful deployment; the window covers only what came after it. */
  deployment: DeploymentReceipt;
  events: readonly EvolutionEvent[];
  session: OutcomeSession;
  turn: number;
  /** When the turn ended. */
  endedAt: string;
  guardedTools: ReadonlySet<string>;
}

/** One session's outcome snapshot for an experience up to this turn. No exposure, no outcome. */
export function sessionOutcomeWindow(input: SessionOutcomeInput): FeedbackWindow | undefined {
  const { artifact, deployment } = input;
  const sinceMs = Date.parse(deployment.endedAt);
  const endedMs = Date.parse(input.endedAt);
  if (endedMs < sinceMs) return undefined;
  const sessionId = String(input.session.id);

  let selected = 0;
  let activated = 0;
  let firstActivationMs = Number.POSITIVE_INFINITY;
  let firstActivationIndex = Number.POSITIVE_INFINITY;
  let firstActivationSeq: number | undefined;
  let firstActivationCallId: string | undefined;
  for (const [eventIndex, event] of input.events.entries()) {
    if (event.entityId !== artifact.id || event.type !== "artifact.exposure-recorded") continue;
    if (event.data.sessionId !== sessionId || event.data.contentDigest !== artifact.contentDigest) continue;
    const occurredMs = Date.parse(event.occurredAt);
    if (occurredMs < sinceMs || occurredMs > endedMs) continue;
    if (event.data.phase === "selected") selected += 1;
    else if (ACTIVATING_PHASES.has(String(event.data.phase))) {
      activated += 1;
      if (occurredMs < firstActivationMs || (occurredMs === firstActivationMs && eventIndex < firstActivationIndex)) {
        firstActivationMs = occurredMs;
        firstActivationIndex = eventIndex;
        const boundary = exposureSessionBoundary(input.session, event);
        firstActivationSeq = boundary.seq;
        firstActivationCallId = boundary.inclusiveCallId;
      }
    }
  }
  const eligible = Math.max(selected, activated);
  if (eligible === 0) return undefined;

  const lineage = new Set(artifact.manifest.lineage.candidateIds);
  const recurrences = input.events.filter((event, eventIndex) => {
    if (event.entityKind !== "candidate" || event.type !== "candidate.observed" || !lineage.has(event.entityId)) return false;
    const evidence = event.data.evidence as { sourceSessionId?: unknown } | undefined;
    const occurredMs = Date.parse(event.occurredAt);
    const afterActivation = occurredMs > firstActivationMs
      || (occurredMs === firstActivationMs && eventIndex > firstActivationIndex);
    return evidence?.sourceSessionId === sessionId && afterActivation && occurredMs <= endedMs;
  }).length;
  const recurrence = Math.min(recurrences, activated);
  const passRef = acceptedSubmissionRef(input.session, input.guardedTools, firstActivationMs, endedMs, {
    ...(firstActivationSeq === undefined ? {} : { activationSeq: firstActivationSeq }),
    ...(firstActivationCallId === undefined ? {} : { inclusiveCallId: firstActivationCallId }),
    maxTurn: input.turn,
  });
  const taskPass = activated > 0 && recurrence === 0 && passRef !== undefined ? 1 : 0;
  const taskFail = recurrence > 0 ? 1 : 0;
  const ref = sessionRef(sessionId, input.turn);
  return {
    windowId: `${SESSION_WINDOW_PREFIX}${hash(`${artifact.id}\0${deployment.receiptId}\0${sessionId}\0${input.turn}`)}`,
    deploymentReceiptId: deployment.receiptId,
    artifactId: artifact.id,
    contentDigest: artifact.contentDigest,
    intendedEffect: artifact.manifest.intendedEffect,
    startedAt: deployment.endedAt,
    endedAt: input.endedAt,
    eligible,
    activated,
    recurrence,
    prevented: 0,
    falseTrigger: 0,
    falseBlock: 0,
    independentSuccesses: 0,
    taskPass,
    taskFail,
    retryDelta: 0,
    costDeltaUsd: 0,
    latencyDeltaMs: 0,
    evidenceRefs: passRef === undefined ? [ref] : [ref, passRef],
  };
}

/**
 * Fold the latest snapshot of every session under the same deployment into a
 * cumulative window. The window id is determined by the set of contributing sessions:
 * the same sessions always fold into the same window, one more session is a new window.
 */
export function cumulativeWindow(artifact: ArtifactProjection, deployment: DeploymentReceipt): FeedbackWindow | undefined {
  const latest = new Map<string, { turn: number; window: FeedbackWindow }>();
  for (const window of artifact.feedbackWindows) {
    if (window.deploymentReceiptId !== deployment.receiptId || !window.windowId.startsWith(SESSION_WINDOW_PREFIX)) continue;
    const parsed = parseSessionRef(window.evidenceRefs[0]);
    if (parsed === undefined) continue;
    const previous = latest.get(parsed.sessionId);
    if (previous === undefined || parsed.turn > previous.turn) latest.set(parsed.sessionId, { turn: parsed.turn, window });
  }
  if (latest.size === 0) return undefined;
  const parts = [...latest.entries()].sort(([left], [right]) => left.localeCompare(right));
  const sum = (field: keyof FeedbackWindow): number => parts.reduce((total, [, part]) => total + (part.window[field] as number), 0);
  const refs = parts.map(([sessionId, part]) => sessionRef(sessionId, part.turn));
  return {
    windowId: `${CUMULATIVE_WINDOW_PREFIX}${hash(`${artifact.id}\0${deployment.receiptId}\0${refs.join("\n")}`)}`,
    deploymentReceiptId: deployment.receiptId,
    artifactId: artifact.id,
    contentDigest: artifact.contentDigest,
    intendedEffect: artifact.manifest.intendedEffect,
    startedAt: deployment.endedAt,
    endedAt: parts.map(([, part]) => part.window.endedAt).sort().at(-1) as string,
    eligible: sum("eligible"),
    activated: sum("activated"),
    recurrence: sum("recurrence"),
    prevented: 0,
    falseTrigger: 0,
    falseBlock: 0,
    independentSuccesses: 0,
    taskPass: sum("taskPass"),
    taskFail: sum("taskFail"),
    retryDelta: 0,
    costDeltaUsd: 0,
    latencyDeltaMs: 0,
    evidenceRefs: refs,
  };
}
