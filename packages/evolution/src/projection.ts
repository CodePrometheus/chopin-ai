import { ARTIFACT_KINDS } from "./types.js";
import type { ArtifactKind, EvolutionProjection } from "./types.js";

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** How many of each capability kind are running and how many ever existed. Evolution collapsing entirely into memory is degeneration, and it shows here at a glance. */
export function artifactKindDistribution(projection: EvolutionProjection): Record<ArtifactKind, { active: number; total: number }> {
  const counts = Object.fromEntries(ARTIFACT_KINDS.map((kind) => [kind, { active: 0, total: 0 }])) as Record<ArtifactKind, { active: number; total: number }>;
  for (const artifact of projection.artifacts) {
    const bucket = counts[artifact.manifest.kind];
    bucket.total += 1;
    if (artifact.enabled) bucket.active += 1;
  }
  return counts;
}

/** Human-readable view; can be rebuilt from JSONL at any time. */
export function renderEvolutionProjection(projection: EvolutionProjection): string {
  const lines = [
    "# Chopin Evolution State",
    "",
    `Events: ${projection.eventCount}`,
    `Last event: ${projection.lastEventId ?? "none"}`,
    "",
    "## Candidates",
    "",
    "| ID | State | Events | Updated |",
    "|---|---|---:|---|",
  ];
  for (const candidate of projection.candidates) {
    lines.push(`| ${cell(candidate.id)} | ${candidate.state} | ${candidate.eventCount} | ${candidate.updatedAt} |`);
  }
  if (projection.candidates.length === 0) lines.push("| — | — | 0 | — |");

  lines.push("", "## Artifacts", "", "| ID | State | Events | Updated |", "|---|---|---:|---|");
  for (const artifact of projection.artifacts) {
    lines.push(`| ${cell(artifact.id)} | ${artifact.state} | ${artifact.eventCount} | ${artifact.updatedAt} |`);
  }
  if (projection.artifacts.length === 0) lines.push("| — | — | 0 | — |");

  lines.push("", "## Capability kinds", "", "| Kind | Active | Total |", "|---|---:|---:|");
  const distribution = artifactKindDistribution(projection);
  for (const kind of ARTIFACT_KINDS) {
    lines.push(`| ${kind} | ${distribution[kind].active} | ${distribution[kind].total} |`);
  }
  return `${lines.join("\n")}\n`;
}
