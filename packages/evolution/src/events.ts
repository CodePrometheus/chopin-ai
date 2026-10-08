import { randomUUID } from "node:crypto";

import {
  ARTIFACT_EVENT_TYPES,
  CANDIDATE_EVENT_TYPES,
  EVOLUTION_EVENT_SCHEMA_VERSION,
} from "./types.js";
import type {
  EvolutionActor,
  EvolutionEntityKind,
  EvolutionEvent,
  EvolutionEventType,
  JsonObject,
  JsonValue,
} from "./types.js";

const CANDIDATE_TYPES = new Set<string>(CANDIDATE_EVENT_TYPES);
const ARTIFACT_TYPES = new Set<string>(ARTIFACT_EVENT_TYPES);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTOR_KINDS = new Set(["system", "user", "agent", "import"]);
const EVENT_KEYS = new Set(["schemaVersion", "eventId", "occurredAt", "entityKind", "entityId", "type", "data", "actor"]);
const ACTOR_KEYS = new Set(["kind", "id"]);

export class InvalidEvolutionEventError extends Error {
  constructor(message: string) {
    super(`invalid evolution event: ${message}`);
    this.name = "InvalidEvolutionEventError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new InvalidEvolutionEventError(`${path}.${key} is not allowed`);
  }
}

function assertIdentifier(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new InvalidEvolutionEventError(`${path} must match ${IDENTIFIER}`);
  }
}

function assertTimestamp(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new InvalidEvolutionEventError("occurredAt must be an ISO timestamp");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new InvalidEvolutionEventError("occurredAt must be a canonical ISO timestamp");
  }
}

function assertJsonValue(value: unknown, path: string, ancestors: Set<object>): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InvalidEvolutionEventError(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw new InvalidEvolutionEventError(`${path} is not JSON-serializable`);
  if (ancestors.has(value)) throw new InvalidEvolutionEventError(`${path} contains a cycle`);

  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertJsonValue(value[index], `${path}[${index}]`, next);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidEvolutionEventError(`${path} must contain plain objects only`);
  }
  for (const [key, child] of Object.entries(value)) assertJsonValue(child, `${path}.${key}`, next);
}

function assertActor(value: unknown): asserts value is EvolutionActor {
  if (!isRecord(value)) throw new InvalidEvolutionEventError("actor must be an object");
  assertExactKeys(value, ACTOR_KEYS, "actor");
  if (typeof value.kind !== "string" || !ACTOR_KINDS.has(value.kind)) {
    throw new InvalidEvolutionEventError("actor.kind is unknown");
  }
  if (value.id !== undefined) assertIdentifier(value.id, "actor.id");
}

/** Validate the full shape of one log line and the entity/type correspondence. */
export function assertEvolutionEvent(value: unknown): asserts value is EvolutionEvent {
  if (!isRecord(value)) throw new InvalidEvolutionEventError("event must be an object");
  assertExactKeys(value, EVENT_KEYS, "event");
  if (value.schemaVersion !== EVOLUTION_EVENT_SCHEMA_VERSION) {
    throw new InvalidEvolutionEventError(`schemaVersion must be ${EVOLUTION_EVENT_SCHEMA_VERSION}`);
  }
  assertIdentifier(value.eventId, "eventId");
  assertTimestamp(value.occurredAt);
  assertIdentifier(value.entityId, "entityId");

  if (!["candidate", "artifact", "improvement", "context-selection"].includes(String(value.entityKind))) {
    throw new InvalidEvolutionEventError("unknown entityKind");
  }
  if (typeof value.type !== "string") throw new InvalidEvolutionEventError("type must be a string");
  const typeMatches = value.entityKind === "candidate"
    ? CANDIDATE_TYPES.has(value.type)
    : value.entityKind === "artifact" ? ARTIFACT_TYPES.has(value.type)
      : value.entityKind === "improvement" ? value.type === "improvement.planned" : value.type === "context.selection-recorded";
  if (!typeMatches) throw new InvalidEvolutionEventError(`${value.type} does not belong to ${value.entityKind}`);

  if (!isRecord(value.data)) throw new InvalidEvolutionEventError("data must be an object");
  assertJsonValue(value.data, "data", new Set());
  if (value.actor !== undefined) assertActor(value.actor);
}

export interface CreateEvolutionEventInput {
  eventId?: string;
  occurredAt?: string;
  entityKind: EvolutionEntityKind;
  entityId: string;
  type: EvolutionEventType;
  data?: JsonObject;
  actor?: EvolutionActor;
}

/** Create and immediately validate an event, so invalid content does not fail only at the file write stage. */
export function createEvolutionEvent(input: CreateEvolutionEventInput): EvolutionEvent {
  const event: EvolutionEvent = {
    schemaVersion: EVOLUTION_EVENT_SCHEMA_VERSION,
    eventId: input.eventId ?? randomUUID(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    entityKind: input.entityKind,
    entityId: input.entityId,
    type: input.type,
    data: input.data ?? {},
    ...(input.actor === undefined ? {} : { actor: input.actor }),
  };
  assertEvolutionEvent(event);
  return event;
}

/** Stable serialization for idempotent eventId comparison, independent of object key insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InvalidEvolutionEventError("canonical JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new InvalidEvolutionEventError("canonical JSON received a non-JSON value");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const fields = Object.keys(value).sort().map((key) => {
    const record = value as Record<string, unknown>;
    return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
  });
  return `{${fields.join(",")}}`;
}
