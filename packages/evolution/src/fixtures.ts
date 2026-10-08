import { createHash } from "node:crypto";

import { canonicalJson } from "./events.js";
import { assertExecutionContext } from "./execution-context.js";
import type {
  CapabilityFixtureCase,
  CapabilityFixtureSuite,
  CapabilityManifest,
  JsonValue,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class InvalidCapabilityFixtureError extends Error {
  constructor(message: string) {
    super(`invalid capability fixture: ${message}`);
    this.name = "InvalidCapabilityFixtureError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidCapabilityFixtureError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new InvalidCapabilityFixtureError(`${path}.${key} is not allowed`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new InvalidCapabilityFixtureError(`${path}.${key} is required`);
}

function id(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new InvalidCapabilityFixtureError(`${path} is not a stable identifier`);
}

function json(value: unknown, path: string): asserts value is JsonValue {
  try {
    canonicalJson(value);
  } catch (error) {
    throw new InvalidCapabilityFixtureError(`${path} is not JSON: ${(error as Error).message}`);
  }
}

function fixtureCase(value: unknown, index: number): asserts value is CapabilityFixtureCase {
  const item = record(value, `cases[${index}]`);
  exact(item, ["id", "kind", "name", "input", "expect"], `cases[${index}]`);
  id(item.id, `cases[${index}].id`);
  id(item.name, `cases[${index}].name`);
  const input = record(item.input, `cases[${index}].input`);
  const expect = record(item.expect, `cases[${index}].expect`);
  const environment = Object.hasOwn(input, "environment") ? ["environment"] : [];
  if (environment.length) {
    try { assertExecutionContext(input.environment); }
    catch (error) { throw new InvalidCapabilityFixtureError(`cases[${index}].input.environment: ${String(error)}`); }
  }
  if (item.kind === "context") {
    exact(input, ["workspace", "prompt", ...environment], `cases[${index}].input`);
    if (typeof input.workspace !== "string" || typeof input.prompt !== "string") throw new InvalidCapabilityFixtureError(`cases[${index}] context input must be strings`);
    const keys = Object.keys(expect);
    if (keys.length === 1 && keys[0] === "maxChars") {
      if (!Number.isSafeInteger(expect.maxChars) || Number(expect.maxChars) < 0 || Number(expect.maxChars) > 1_000_000) throw new InvalidCapabilityFixtureError(`cases[${index}] has an invalid context size limit`);
      return;
    }
    if (keys.length !== 1 || (keys[0] !== "equals" && keys[0] !== "contains") || typeof expect[keys[0]] !== "string") {
      throw new InvalidCapabilityFixtureError(`cases[${index}] context expect needs exactly one string equals/contains`);
    }
    return;
  }
  if (item.kind === "guard") {
    exact(input, ["toolName", "arguments", "successfulCalls", ...environment], `cases[${index}].input`);
    if (typeof input.toolName !== "string" || input.toolName === "") throw new InvalidCapabilityFixtureError(`cases[${index}].input.toolName must be non-empty`);
    record(input.arguments, `cases[${index}].input.arguments`);
    if (!Array.isArray(input.successfulCalls)) throw new InvalidCapabilityFixtureError(`cases[${index}].input.successfulCalls must be an array`);
    for (const [callIndex, call] of input.successfulCalls.entries()) {
      const parsed = record(call, `cases[${index}].input.successfulCalls[${callIndex}]`);
      exact(parsed, ["name", "arguments"], `cases[${index}].input.successfulCalls[${callIndex}]`);
      id(parsed.name, `cases[${index}].input.successfulCalls[${callIndex}].name`);
      record(parsed.arguments, `cases[${index}].input.successfulCalls[${callIndex}].arguments`);
    }
    exact(expect, ["decision"], `cases[${index}].expect`);
    if (expect.decision !== null && typeof expect.decision !== "string") throw new InvalidCapabilityFixtureError(`cases[${index}].expect.decision must be string or null`);
    return;
  }
  if (item.kind === "tool") {
    exact(input, ["callId", "arguments", ...environment, ...(Object.hasOwn(input, "steps") ? ["steps"] : [])], `cases[${index}].input`);
    id(input.callId, `cases[${index}].input.callId`);
    record(input.arguments, `cases[${index}].input.arguments`);
    if (input.steps !== undefined) {
      if (!Array.isArray(input.steps) || input.steps.length > 8) throw new InvalidCapabilityFixtureError("Invalid dispatch fixture steps");
      for (const step of input.steps) {
        record(step, "dispatch step"); exact(step, ["tool", "arguments", "value"], "dispatch step");
        id(step.tool, "dispatch step tool"); record(step.arguments, "dispatch step arguments"); json(step.value, "dispatch step value");
      }
    }
    exact(expect, ["equals"], `cases[${index}].expect`);
    json(expect.equals, `cases[${index}].expect.equals`);
    return;
  }
  throw new InvalidCapabilityFixtureError(`cases[${index}].kind is unknown`);
}

export function assertCapabilityFixtureSuite(value: unknown): asserts value is CapabilityFixtureSuite {
  const suite = record(value, "suite");
  exact(suite, ["schemaVersion", "cases"], "suite");
  if (suite.schemaVersion !== 1) throw new InvalidCapabilityFixtureError("schemaVersion must be 1");
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) throw new InvalidCapabilityFixtureError("cases must be non-empty");
  const ids = new Set<string>();
  for (const [index, value] of suite.cases.entries()) {
    fixtureCase(value, index);
    if (ids.has(value.id)) throw new InvalidCapabilityFixtureError(`duplicate case ${value.id}`);
    ids.add(value.id);
  }
}

/** Every declaration on an executable surface must have at least one approved synthetic fixture. */
export function assertFixtureCoverage(suite: CapabilityFixtureSuite, manifest: CapabilityManifest): void {
  assertCapabilityFixtureSuite(suite);
  const expected = new Map<string, Set<string>>([
    ["context", new Set(manifest.provides.contexts)],
    ["guard", new Set(manifest.provides.guards)],
    ["tool", new Set(manifest.provides.tools)],
  ]);
  const covered = new Map<string, Set<string>>([
    ["context", new Set()],
    ["guard", new Set()],
    ["tool", new Set()],
  ]);
  for (const fixture of suite.cases) {
    if (!expected.get(fixture.kind)?.has(fixture.name)) {
      throw new InvalidCapabilityFixtureError(`${fixture.kind} case ${fixture.id} names undeclared surface ${fixture.name}`);
    }
    covered.get(fixture.kind)?.add(fixture.name);
  }
  for (const [kind, names] of expected) {
    for (const name of names) if (!covered.get(kind)?.has(name)) throw new InvalidCapabilityFixtureError(`${kind} ${name} has no fixture case`);
  }
}

export function capabilityFixtureDigest(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
