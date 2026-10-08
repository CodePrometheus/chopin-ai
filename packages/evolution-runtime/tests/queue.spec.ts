import { describe, expect, it } from "vitest";
import type { EvolutionProjection } from "@chopin/evolution";

import { evolutionQueue, renderEvolutionQueue } from "../src/queue.js";

function candidate(id: string, units: number) {
  return { id, state: "corroborated", lesson: `lesson ${id}`, evidence: [], trustedIndependentUnits: units, proposals: [] };
}

describe("evolution queue order", () => {
  it("within one action, the work backed by more independent sessions comes first", () => {
    const projection = { candidates: [candidate("later", 2), candidate("urgent", 4), candidate("also", 2)], artifacts: [] } as unknown as EvolutionProjection;
    const items = evolutionQueue(projection);
    expect(items.map((item) => [item.id, item.support])).toEqual([["urgent", 4], ["also", 2], ["later", 2]]);
    expect(renderEvolutionQueue(items)).toContain("classify urgent via evolution_candidate_classify");
  });
});
