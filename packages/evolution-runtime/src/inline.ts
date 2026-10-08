import type { ArtifactProjection, ArtifactStore } from "@chopin/evolution";

import { readExperienceBody } from "./render.js";
import type { SelectedArtifact } from "./selection.js";

export interface InlineExperience {
  name: string;
  text: string;
  artifact: ArtifactProjection;
  matchedSelectors: string[];
  bodyChars: number;
}

/** Short memories load whole; long bodies and skills stay on-demand, never a truncated summary standing in for the method. */
export async function prepareInlineExperience(artifacts: ArtifactStore, item: SelectedArtifact, maxChars: number, maxBodyChars: number): Promise<InlineExperience | undefined> {
  if (item.artifact.manifest.kind !== "memory") return undefined;
  const body = await readExperienceBody(artifacts, item.artifact, Math.max(maxChars, maxBodyChars) + 1);
  const text = [
    `Full experience: ${item.artifact.manifest.id}.`,
    `When: ${item.artifact.manifest.trigger.when ?? "the matched structured scope"}`, body,
  ].join("\n");
  if (text.length > maxChars) return undefined;
  return { name: `chopin:experience:${item.artifact.id}`, text, artifact: item.artifact,
    matchedSelectors: item.matchedSelectors, bodyChars: body.length };
}
