import { createHash } from "node:crypto";
import { canonicalJson } from "./events.js";
import type { ArtifactProjection, CapabilityManifest, DeploymentMode } from "./types.js";

const permissions = ["system-prompt:context", "tools:guard", "tools:register"];
const definition = {
  id: "managed-capabilities-v1", permissions, toolPrefix: "learned_", maxFixtureCases: 16, guardCounterexamples: true,
  automaticRetriesPerMode: 1,
};
export const MANAGED_POLICY = Object.freeze({
  id: definition.id,
  digest: `sha256:${createHash("sha256").update(canonicalJson(definition)).digest("hex")}`,
});
export const MAX_AUTOMATIC_FIXTURES = definition.maxFixtureCases;

export function automaticRetryAvailable(artifact: Pick<ArtifactProjection, "deploymentRequests">, mode: DeploymentMode): boolean {
  return artifact.deploymentRequests.filter((request) => request.mode === mode && request.retryApproval?.policy !== undefined).length < definition.automaticRetriesPerMode;
}

/** Autonomous capabilities run only through the restricted interface; they cannot override host tools or register persistent services. */
export function automaticCapabilityDenial(manifest: CapabilityManifest): string | undefined {
  if (manifest.kind === "gate") return "gate changes are never activated automatically";
  if (manifest.runtime === "data") return undefined;
  if (manifest.runtime !== "dsh-plugin") return "runtime is not supported for automatic activation";
  if (manifest.permissions.some((permission) => !permissions.includes(permission))) return "permissions exceed the managed capability policy";
  if (manifest.provides.services.length || manifest.provides.workflows.length || manifest.provides.skills.length) {
    return "automatic executable capabilities may only provide contexts, guards and tools";
  }
  if (manifest.provides.tools.some((name) => !name.startsWith(definition.toolPrefix))) {
    return `automatic tools must use the ${definition.toolPrefix} namespace`;
  }
  return undefined;
}
