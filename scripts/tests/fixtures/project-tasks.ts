import type { ProjectTaskPack, ProjectTask } from "../../../apps/cli/src/rsi-project.js";

/** Control experiments only verify host mechanics; scripted answers are not evidence of model improvement. */
export function projectTasks(): ProjectTaskPack {
  const task = (id: string, split: ProjectTask["split"]): ProjectTask => ({
    id, family: id, split, objective: `Repair ${id}: the exported result must be one, preserving the public module interface.`,
    files: { "src/value.mjs": "export const value = 0;", "src/index.mjs": "import { value } from './value.mjs'; export function result() { return value; }" },
    writable: ["src/value.mjs"], publicChecks: [{ id: "public-result", kind: "module", path: "src/index.mjs", export: "result", arguments: [], expected: 1 }],
    checks: [0, 1, 2].map(index => ({ id: `result-${index}`, kind: "module" as const, path: "src/index.mjs", export: "result", arguments: [index], expected: 1 })),
  });
  return { schemaVersion: 1, tasks: [task("search-output", "search"), task("holdout-output", "holdout")] };
}
