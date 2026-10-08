import { createEvolutionEvent } from "./events.js";
import type {
  EvolutionActor,
  EvolutionEvent,
  FeedbackVerdict,
  FeedbackWindow,
  JsonObject,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export class InvalidFeedbackWindowError extends Error {
  constructor(message: string) {
    super(`invalid feedback window: ${message}`);
    this.name = "InvalidFeedbackWindowError";
  }
}

function canonicalTimestamp(value: string, path: string): void {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) throw new InvalidFeedbackWindowError(`${path} must be canonical ISO`);
}

function count(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new InvalidFeedbackWindowError(`${path} must be a non-negative safe integer`);
}

export function assertFeedbackWindow(value: unknown): asserts value is FeedbackWindow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidFeedbackWindowError("must be an object");
  const item = value as Record<string, unknown>;
  const keys = [
    "windowId", "deploymentReceiptId", "artifactId", "contentDigest", "intendedEffect", "startedAt", "endedAt",
    "eligible", "activated", "recurrence", "prevented", "falseTrigger", "falseBlock", "independentSuccesses",
    "taskPass", "taskFail", "retryDelta", "costDeltaUsd", "latencyDeltaMs", "evidenceRefs",
  ];
  if (Object.keys(item).length !== keys.length || keys.some((key) => !Object.hasOwn(item, key))) {
    throw new InvalidFeedbackWindowError("fields do not match schema");
  }
  for (const key of ["windowId", "deploymentReceiptId", "artifactId"]) {
    if (typeof item[key] !== "string" || !IDENTIFIER.test(item[key])) throw new InvalidFeedbackWindowError(`${key} is not a stable identifier`);
  }
  if (typeof item.contentDigest !== "string" || !DIGEST.test(item.contentDigest)) throw new InvalidFeedbackWindowError("contentDigest must be sha256:<hex>");
  if (item.intendedEffect !== "advisory" && item.intendedEffect !== "preventive") throw new InvalidFeedbackWindowError("intendedEffect is unknown");
  if (typeof item.startedAt !== "string" || typeof item.endedAt !== "string") throw new InvalidFeedbackWindowError("timestamps must be strings");
  canonicalTimestamp(item.startedAt, "startedAt");
  canonicalTimestamp(item.endedAt, "endedAt");
  if (Date.parse(item.endedAt) < Date.parse(item.startedAt)) throw new InvalidFeedbackWindowError("endedAt precedes startedAt");
  for (const key of [
    "eligible", "activated", "recurrence", "prevented", "falseTrigger", "falseBlock", "independentSuccesses", "taskPass", "taskFail",
  ]) count(item[key] as number, key);
  if ((item.activated as number) > (item.eligible as number)) throw new InvalidFeedbackWindowError("activated exceeds eligible");
  if ((item.recurrence as number) + (item.prevented as number) > (item.activated as number)) {
    throw new InvalidFeedbackWindowError("recurrence + prevented exceeds activated");
  }
  for (const key of ["falseTrigger", "falseBlock", "independentSuccesses"]) {
    if ((item[key] as number) > (item.activated as number)) {
      throw new InvalidFeedbackWindowError(`${key} exceeds activated`);
    }
  }
  if ((item.taskPass as number) + (item.taskFail as number) > (item.activated as number)) {
    throw new InvalidFeedbackWindowError("taskPass + taskFail exceeds activated");
  }
  for (const key of ["retryDelta", "costDeltaUsd", "latencyDeltaMs"]) {
    if (typeof item[key] !== "number" || !Number.isFinite(item[key])) throw new InvalidFeedbackWindowError(`${key} must be finite`);
  }
  if (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.some((ref) => typeof ref !== "string" || ref.trim() === "")) {
    throw new InvalidFeedbackWindowError("evidenceRefs must be non-empty strings");
  }
  if (new Set(item.evidenceRefs).size !== item.evidenceRefs.length) {
    throw new InvalidFeedbackWindowError("evidenceRefs must be unique");
  }
}

export function evaluateFeedbackWindow(window: FeedbackWindow): FeedbackVerdict {
  assertFeedbackWindow(window);
  if (window.falseBlock > 0) return "quarantine";
  if (window.eligible === 0 || window.activated === 0) return "inactive";
  // Failing more often than passing is a decline, whatever the capability did at first.
  if (window.taskFail >= 2 && window.taskFail > window.taskPass) return "contradict";
  if (window.intendedEffect === "preventive") {
    if (window.recurrence > 0) return "contradict";
    return window.prevented > 0 ? "confirm" : "inactive";
  }
  if (window.taskFail > 0 && window.taskPass === 0) return "contradict";
  return window.independentSuccesses >= 2 && window.taskPass >= 2 ? "confirm" : "inactive";
}

interface ArtifactFeedbackMeta {
  eventId?: string;
  occurredAt?: string;
  artifactId: string;
  actor?: EvolutionActor;
}

function data(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function artifactFeedbackRecorded(meta: ArtifactFeedbackMeta, window: FeedbackWindow): EvolutionEvent {
  assertFeedbackWindow(window);
  return createEvolutionEvent({
    eventId: meta.eventId,
    occurredAt: meta.occurredAt,
    entityKind: "artifact",
    entityId: meta.artifactId,
    type: "artifact.feedback-recorded",
    actor: meta.actor,
    data: data({ window }),
  });
}

export function artifactTrusted(meta: ArtifactFeedbackMeta, windowId: string): EvolutionEvent {
  if (!IDENTIFIER.test(windowId)) throw new InvalidFeedbackWindowError("windowId is not stable");
  return createEvolutionEvent({
    eventId: meta.eventId,
    occurredAt: meta.occurredAt,
    entityKind: "artifact",
    entityId: meta.artifactId,
    type: "artifact.trusted",
    actor: meta.actor,
    data: { windowId },
  });
}

export function artifactDemoted(meta: ArtifactFeedbackMeta, windowId: string, reason: string): EvolutionEvent {
  if (!IDENTIFIER.test(windowId) || reason.trim() === "") throw new InvalidFeedbackWindowError("demotion needs windowId and reason");
  return createEvolutionEvent({
    eventId: meta.eventId,
    occurredAt: meta.occurredAt,
    entityKind: "artifact",
    entityId: meta.artifactId,
    type: "artifact.demoted",
    actor: meta.actor,
    data: { windowId, reason },
  });
}
