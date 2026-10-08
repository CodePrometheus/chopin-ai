import { createHash } from "node:crypto";
import { isAbsolute, posix } from "node:path";

import { assertApplicabilityTrigger, InvalidCandidateEventError } from "./candidate.js";
import { canonicalJson } from "./events.js";
import { ARTIFACT_KINDS } from "./types.js";
import type {
  ArtifactKind,
  ArtifactReference,
  CapabilityDependency,
  CapabilityLineage,
  CapabilityManifest,
  CapabilityProvides,
  JsonValue,
} from "./types.js";

export const CAPABILITY_MANIFEST_SCHEMA_VERSION = 1 as const;
export const ARTIFACT_KIND_AUTHORITY_ORDER = ["memory", "skill", "gate", "tool", "plugin"] as const;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PERMISSION = /^[a-z][a-z0-9:-]{0,127}$/;
const API_RANGE = /^(?:\^|~|>=|<=|>|<|=)?[0-9A-Za-z.*+-]+(?:\.[0-9A-Za-z.*+-]+)*$/;
const KIND_SET = new Set<string>(ARTIFACT_KINDS);
const RUNTIMES = new Set(["data", "dsh-plugin", "mcp"]);
const PROVIDE_KEYS = ["contexts", "skills", "guards", "tools", "services", "workflows"] as const;
const MANIFEST_KEYS = [
  "schemaVersion", "id", "version", "kind", "runtime", "intendedEffect", "summary", "entry", "trigger",
  "provides", "permissions", "dependencies", "conflicts", "requires", "lineage",
] as const;

export class InvalidCapabilityManifestError extends Error {
  constructor(message: string) {
    super(`invalid capability manifest: ${message}`);
    this.name = "InvalidCapabilityManifestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new InvalidCapabilityManifestError(`${path}.${key} is not allowed`);
  for (const key of allowed) if (!Object.hasOwn(value, key)) throw new InvalidCapabilityManifestError(`${path}.${key} is required`);
}

function nonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new InvalidCapabilityManifestError(`${path} must be non-empty`);
}

function stableId(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new InvalidCapabilityManifestError(`${path} is not a stable identifier`);
}

function stringList(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new InvalidCapabilityManifestError(`${path} must be an array`);
  const seen = new Set<string>();
  for (const item of value) {
    nonEmpty(item, `${path}[]`);
    if (seen.has(item)) throw new InvalidCapabilityManifestError(`${path} contains duplicate ${item}`);
    seen.add(item);
  }
}

function artifactReference(value: unknown, path: string): asserts value is ArtifactReference {
  if (!isRecord(value)) throw new InvalidCapabilityManifestError(`${path} must be an object`);
  exactKeys(value, ["artifactId", "contentDigest", "surfaceDigest"], path);
  stableId(value.artifactId, `${path}.artifactId`);
  if (typeof value.contentDigest !== "string" || !DIGEST.test(value.contentDigest)) {
    throw new InvalidCapabilityManifestError(`${path}.contentDigest must be sha256:<hex>`);
  }
  if (typeof value.surfaceDigest !== "string" || !DIGEST.test(value.surfaceDigest)) {
    throw new InvalidCapabilityManifestError(`${path}.surfaceDigest must be sha256:<hex>`);
  }
}

function lineage(value: unknown): asserts value is CapabilityLineage {
  if (!isRecord(value)) throw new InvalidCapabilityManifestError("lineage must be an object");
  const allowed = ["candidateIds", "proposalIds", "supersedes", "rollbackTo", "improvementId"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new InvalidCapabilityManifestError(`lineage.${key} is not allowed`);
  stringList(value.candidateIds, "lineage.candidateIds");
  stringList(value.proposalIds, "lineage.proposalIds");
  if (value.candidateIds.length === 0 || value.proposalIds.length === 0) {
    throw new InvalidCapabilityManifestError("lineage must name at least one candidate and proposal");
  }
  for (const id of [...value.candidateIds, ...value.proposalIds]) stableId(id, "lineage id");
  if (value.supersedes !== undefined) artifactReference(value.supersedes, "lineage.supersedes");
  if (value.rollbackTo !== undefined) artifactReference(value.rollbackTo, "lineage.rollbackTo");
  if (value.improvementId !== undefined) stableId(value.improvementId, "lineage.improvementId");
}

function provides(value: unknown): asserts value is CapabilityProvides {
  if (!isRecord(value)) throw new InvalidCapabilityManifestError("provides must be an object");
  exactKeys(value, PROVIDE_KEYS, "provides");
  for (const key of PROVIDE_KEYS) {
    stringList(value[key], `provides.${key}`);
    for (const item of value[key]) stableId(item, `provides.${key}[]`);
  }
}

function dependencies(value: unknown): asserts value is CapabilityDependency[] {
  if (!Array.isArray(value)) throw new InvalidCapabilityManifestError("dependencies must be an array");
  const ids = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) throw new InvalidCapabilityManifestError("dependency must be an object");
    exactKeys(item, ["id", "version"], "dependency");
    stableId(item.id, "dependency.id");
    if (typeof item.version !== "string" || !VERSION.test(item.version)) throw new InvalidCapabilityManifestError("dependency.version must be semver");
    if (ids.has(item.id)) throw new InvalidCapabilityManifestError(`duplicate dependency ${item.id}`);
    ids.add(item.id);
  }
}

function nonEmptyProvideKeys(value: CapabilityProvides): Array<keyof CapabilityProvides> {
  return PROVIDE_KEYS.filter((key) => value[key].length > 0);
}

function assertExclusiveSurface(manifest: CapabilityManifest, expected: keyof CapabilityProvides): void {
  const actual = nonEmptyProvideKeys(manifest.provides);
  if (manifest.provides[expected].length === 0) {
    throw new InvalidCapabilityManifestError(`${manifest.kind} must declare provides.${expected}`);
  }
  const unexpected = actual.filter((key) => key !== expected);
  if (unexpected.length > 0) {
    throw new InvalidCapabilityManifestError(`${manifest.kind} cannot declare provides.${unexpected.join(",provides.")}`);
  }
}

function assertEntry(value: unknown): asserts value is string {
  nonEmpty(value, "entry");
  const normalized = value.replaceAll("\\", "/");
  if (value !== normalized || isAbsolute(value) || normalized.startsWith("../") || normalized.includes("/../") || normalized === "..") {
    throw new InvalidCapabilityManifestError("entry must stay inside the artifact directory");
  }
  if (posix.normalize(normalized) !== normalized || normalized.startsWith("./")) {
    throw new InvalidCapabilityManifestError("entry must be a normalized relative path");
  }
}

export function assertCapabilityManifest(value: unknown): asserts value is CapabilityManifest {
  if (!isRecord(value)) throw new InvalidCapabilityManifestError("manifest must be an object");
  exactKeys(value, MANIFEST_KEYS, "manifest");
  if (value.schemaVersion !== CAPABILITY_MANIFEST_SCHEMA_VERSION) throw new InvalidCapabilityManifestError("schemaVersion must be 1");
  stableId(value.id, "id");
  if (typeof value.version !== "string" || !VERSION.test(value.version)) throw new InvalidCapabilityManifestError("version must be semver");
  if (typeof value.kind !== "string" || !KIND_SET.has(value.kind)) throw new InvalidCapabilityManifestError("kind is unknown");
  if (typeof value.runtime !== "string" || !RUNTIMES.has(value.runtime)) throw new InvalidCapabilityManifestError("runtime is unknown");
  if (value.intendedEffect !== "advisory" && value.intendedEffect !== "preventive") throw new InvalidCapabilityManifestError("intendedEffect is unknown");
  nonEmpty(value.summary, "summary");
  assertEntry(value.entry);
  try {
    assertApplicabilityTrigger(value.trigger);
  } catch (error) {
    if (error instanceof InvalidCandidateEventError) throw new InvalidCapabilityManifestError(error.message);
    throw error;
  }
  provides(value.provides);
  stringList(value.permissions, "permissions");
  for (const permission of value.permissions) if (!PERMISSION.test(permission)) throw new InvalidCapabilityManifestError(`invalid permission ${permission}`);
  dependencies(value.dependencies);
  stringList(value.conflicts, "conflicts");
  for (const conflict of value.conflicts) {
    stableId(conflict, "conflicts[]");
    if (conflict === value.id) throw new InvalidCapabilityManifestError("a capability cannot conflict with itself");
  }

  if (!isRecord(value.requires)) throw new InvalidCapabilityManifestError("requires must be an object");
  const requireKeys = new Set(["chopinPluginApi", "dsh"]);
  for (const key of Object.keys(value.requires)) if (!requireKeys.has(key)) throw new InvalidCapabilityManifestError(`requires.${key} is not allowed`);
  nonEmpty(value.requires.chopinPluginApi, "requires.chopinPluginApi");
  if (!API_RANGE.test(value.requires.chopinPluginApi)) throw new InvalidCapabilityManifestError("requires.chopinPluginApi is not a supported range");
  if (value.requires.dsh !== undefined) {
    nonEmpty(value.requires.dsh, "requires.dsh");
    if (!API_RANGE.test(value.requires.dsh)) throw new InvalidCapabilityManifestError("requires.dsh is not a supported range");
  }
  lineage(value.lineage);

  const kind = value.kind as ArtifactKind;
  const manifest = value as unknown as CapabilityManifest;
  if (kind === "memory" || kind === "skill") {
    if (value.runtime !== "data" || value.intendedEffect !== "advisory") {
      throw new InvalidCapabilityManifestError(`${kind} must be advisory data`);
    }
    if (value.permissions.length > 0) throw new InvalidCapabilityManifestError(`${kind} cannot request executable permissions`);
    if (value.requires.dsh !== undefined) throw new InvalidCapabilityManifestError(`${kind} data must not require DSH runtime`);
    assertExclusiveSurface(manifest, kind === "memory" ? "contexts" : "skills");
    return;
  }

  if (value.runtime !== "dsh-plugin") throw new InvalidCapabilityManifestError(`${kind} must use dsh-plugin runtime`);
  if (value.requires.dsh === undefined) throw new InvalidCapabilityManifestError(`${kind} must declare requires.dsh`);
  if (kind === "gate") {
    if (value.intendedEffect !== "preventive") throw new InvalidCapabilityManifestError("gate must be preventive");
    assertExclusiveSurface(manifest, "guards");
    return;
  }
  if (kind === "tool") {
    assertExclusiveSurface(manifest, "tools");
    return;
  }
  if (nonEmptyProvideKeys(manifest.provides).length === 0) {
    throw new InvalidCapabilityManifestError("plugin must declare at least one capability surface");
  }
}

export function artifactVersionId(manifest: Pick<CapabilityManifest, "id" | "version">): string {
  return `${manifest.id}:${manifest.version}`;
}

function digest(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function capabilityManifestDigest(manifest: CapabilityManifest): string {
  assertCapabilityManifest(manifest);
  return digest(manifest as unknown as JsonValue);
}

export function capabilitySurfaceDigest(manifest: CapabilityManifest): string {
  assertCapabilityManifest(manifest);
  return digest({
    id: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    runtime: manifest.runtime,
    intendedEffect: manifest.intendedEffect,
    trigger: manifest.trigger as unknown as JsonValue,
    provides: manifest.provides as unknown as JsonValue,
    permissions: manifest.permissions,
    dependencies: manifest.dependencies as unknown as JsonValue,
    conflicts: manifest.conflicts,
    requires: manifest.requires as unknown as JsonValue,
  });
}

export function capabilityPermissionDigest(manifest: CapabilityManifest): string {
  assertCapabilityManifest(manifest);
  return digest(manifest.permissions);
}

export function capabilityProvidesDigest(manifest: CapabilityManifest): string {
  assertCapabilityManifest(manifest);
  return digest(manifest.provides as unknown as JsonValue);
}

export function compareArtifactAuthority(left: ArtifactKind, right: ArtifactKind): number {
  return ARTIFACT_KIND_AUTHORITY_ORDER.indexOf(left) - ARTIFACT_KIND_AUTHORITY_ORDER.indexOf(right);
}

export function leastPowerfulArtifactKind(kinds: readonly ArtifactKind[]): ArtifactKind | undefined {
  return [...kinds].sort(compareArtifactAuthority)[0];
}
