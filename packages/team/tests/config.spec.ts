import { describe, expect, it } from "vitest";

import { affectedChecks, parseTeamConfig, scopeViolations, TEAM_CONFIG_PATH } from "../src/config.js";

const ROOT = "/work/project";

function config(overrides: Record<string, unknown> = {}) {
  return parseTeamConfig({
    slots: [{ name: "api", path: "../project-api" }, { name: "web", path: "/abs/project-web" }],
    checks: [
      { paths: ["packages/api/**"], run: "pnpm --filter api test" },
      { paths: ["packages/web/**", "packages/ui/**"], run: "pnpm --filter web test" },
      { paths: ["packages/api/src/schema.ts"], run: "pnpm --filter api test" },
    ],
    fullCheck: { run: "pnpm test" },
    ...overrides,
  }, ROOT);
}

describe("team configuration", () => {
  it("fills defaults and resolves slot paths against the project root", () => {
    expect(config()).toMatchObject({
      remote: "origin", trunk: "main", delivery: "local", fullCheck: { where: "local", run: "pnpm test" },
      stages: [], defaults: { maxRequests: 60, maxRounds: 6 },
      slots: [{ name: "api", path: "/work/project-api" }, { name: "web", path: "/abs/project-web" }],
    });
  });

  it("rejects what would make the orchestrator guess", () => {
    expect(() => config({ slots: [] })).toThrow("at least one worktree");
    expect(() => config({ slots: [{ name: "api", path: "a" }, { name: "api", path: "b" }] })).toThrow("slot api appears twice");
    expect(() => config({ delivery: "merge" })).toThrow("delivery must be local, push or pull-request");
    expect(() => config({ fullCheck: {} })).toThrow("fullCheck.run must be a non-empty string");
    expect(config({ fullCheck: { where: "ci" } }).fullCheck).toEqual({ where: "ci" });
    expect(() => config({ stages: [{ name: "Deployed" }] })).toThrow("must be a lowercase slug");
  });

  it("selects only the checks the changed files touch, once each", () => {
    expect(affectedChecks(config(), ["packages/api/src/schema.ts", "README.md"])).toEqual(["pnpm --filter api test"]);
    expect(affectedChecks(config(), ["packages/ui/button.tsx"])).toEqual(["pnpm --filter web test"]);
    expect(affectedChecks(config(), ["docs/guide.md"])).toEqual([]);
  });

  it("lets a task carry its own checks but never the configuration or another task's checks", () => {
    const own = ["tests/acceptance/api.spec.ts"];
    const other = ["packages/api/tests/web-acceptance.spec.ts"];
    expect(scopeViolations(["packages/api/src/a.ts", "packages/web/b.ts", ...own], ["packages/api/**"], own, other)).toEqual(["packages/web/b.ts"]);
    expect(scopeViolations([...other, TEAM_CONFIG_PATH], ["packages/api/**", ".chopin/**"], own, other)).toEqual([...other, TEAM_CONFIG_PATH]);
  });
});
