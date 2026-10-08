import { createHash } from "node:crypto";

import { canonicalJson, compareArtifactAuthority } from "@chopin/evolution";
import type { ApplicabilityTrigger, ArtifactProjection, EvolutionProjection, JsonValue } from "@chopin/evolution";

export interface TriggerFacts {
  repos: string[];
  taskKinds: string[];
  paths: string[];
  tools: string[];
  errorKeys: string[];
  languages: string[];
  environments: string[];
}

export interface TriggerMatch {
  matches: boolean;
  matchedSelectors: string[];
}

export interface SelectedArtifact {
  artifact: ArtifactProjection;
  matchedSelectors: string[];
}

const FACT_FIELDS: Array<keyof TriggerFacts> = ["repos", "taskKinds", "paths", "tools", "errorKeys", "languages", "environments"];

function normalized(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function normalizeTriggerFacts(input: Partial<TriggerFacts>): TriggerFacts {
  return {
    repos: normalized(input.repos ?? []),
    taskKinds: normalized(input.taskKinds ?? []),
    paths: normalized((input.paths ?? []).map((path) => path.replaceAll("\\", "/"))),
    tools: normalized(input.tools ?? []),
    errorKeys: normalized(input.errorKeys ?? []),
    languages: normalized(input.languages ?? []),
    environments: normalized(input.environments ?? []),
  };
}

function globExpression(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function matchField(field: keyof TriggerFacts, selectors: readonly string[], facts: TriggerFacts): boolean {
  if (selectors.length === 0) return true;
  if (field === "paths") {
    return selectors.some((selector) => {
      const expression = globExpression(selector.replaceAll("\\", "/"));
      return facts.paths.some((path) => expression.test(path));
    });
  }
  const available = new Set(facts[field]);
  return selectors.some((selector) => available.has(selector));
}

function hasExactApproval(artifact: ArtifactProjection): boolean {
  return artifact.approvalReceipts.some((receipt) =>
    receipt.decision === "allowed-once"
    && receipt.artifactId === artifact.id
    && receipt.contentDigest === artifact.contentDigest
    && receipt.manifestDigest === artifact.manifestDigest
    && receipt.surfaceDigest === artifact.surfaceDigest);
}

function hasSuccessfulDeployment(artifact: ArtifactProjection, mode: "canary" | "active"): boolean {
  return artifact.deploymentReceipts.some((receipt) =>
    receipt.health === "pass"
    && receipt.mode === mode
    && artifact.deploymentRequests.some((request) =>
      request.requestId === receipt.operationId
      && request.mode === mode
      && request.targetGeneration === receipt.processGeneration));
}

/** Effective state is decided by the authoritative event order; reads re-check the exact approval and deployment. */
export function selectEffectiveDataArtifacts(projection: EvolutionProjection): ArtifactProjection[] {
  return projection.artifacts.filter((artifact) =>
    artifact.manifest.runtime === "data"
    && artifact.enabled
    && hasExactApproval(artifact)
    && ((artifact.state === "canary-active" && hasSuccessfulDeployment(artifact, "canary"))
      || ((artifact.state === "active" || artifact.state === "retired") && hasSuccessfulDeployment(artifact, "active"))));
}

/**
 * AND across structured fields, OR among the selectors within a field -- they are hard
 * filters. `when` is not judged here: it goes into the index, and the model decides
 * against the current task whether to read the body.
 */
export function matchApplicabilityTrigger(trigger: ApplicabilityTrigger, inputFacts: TriggerFacts): TriggerMatch {
  const facts = normalizeTriggerFacts(inputFacts);
  const matchedSelectors: string[] = [];
  for (const field of FACT_FIELDS) {
    const triggerKey = field === "paths" ? "pathGlobs" : field;
    const selectors = (trigger as Record<string, string[] | undefined>)[triggerKey] ?? [];
    if (selectors.length === 0) continue;
    if (!matchField(field, selectors, facts)) return { matches: false, matchedSelectors: [] };
    matchedSelectors.push(triggerKey);
  }
  if (typeof trigger.when === "string" && trigger.when.trim() !== "") matchedSelectors.push("when");
  return { matches: matchedSelectors.length > 0, matchedSelectors };
}

export function triggerFactsDigest(facts: TriggerFacts): string {
  const normalizedFacts = normalizeTriggerFacts(facts);
  return `sha256:${createHash("sha256").update(canonicalJson(normalizedFacts as unknown as JsonValue)).digest("hex")}`;
}

export function selectContextArtifacts(
  projection: EvolutionProjection,
  facts: TriggerFacts,
  maxItems: number,
): SelectedArtifact[] {
  return selectEffectiveDataArtifacts(projection)
    .filter((artifact) => artifact.manifest.kind === "memory" || artifact.manifest.kind === "skill")
    .map((artifact) => ({ artifact, match: matchApplicabilityTrigger(artifact.manifest.trigger, facts) }))
    .filter((item) => item.match.matches)
    .sort((left, right) => {
      const leftCanary = left.artifact.state === "canary-active" ? 1 : 0;
      const rightCanary = right.artifact.state === "canary-active" ? 1 : 0;
      if (leftCanary !== rightCanary) return leftCanary - rightCanary;
      return compareArtifactAuthority(left.artifact.manifest.kind, right.artifact.manifest.kind)
        || left.artifact.id.localeCompare(right.artifact.id);
    })
    .slice(0, maxItems)
    .map(({ artifact, match }) => ({ artifact, matchedSelectors: match.matchedSelectors }));
}
