/**
 * The composition check's verdict contract: a preset row for a plugin the base already
 * enables must fail, because a second service registration stops the whole preset from
 * mounting and no per-row check can see it. Rows the base marks `disabled: true` are the
 * exception; those are what the preset is meant to add.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error The check script is .mjs without type declarations; only its runtime exports are used here.
import { collectRows, duplicateRows, enabledByName, parseComposition, presetDeclarations } from "../composition-rules.mjs";

/** Base composition: goal and driver enabled, tool-goal disabled by the UI bundle. */
const BASE = enabledByName(
  collectRows(
    parseComposition(`
- id: goal
  name: '@deepseek-ai/dsh-goal'
- id: goal-round-driver
  name: '@deepseek-ai/dsh-goal-round-driver'
- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'
  disabled: true
`),
  ),
);

function rowsOf(yaml: string): { id?: string; name: string }[] {
  return collectRows(parseComposition(yaml)) as { id?: string; name: string }[];
}

describe("duplicateRows", () => {
  it("a row the base enables is a duplicate", () => {
    const rows = rowsOf(`
- id: goal
  name: '@deepseek-ai/dsh-goal'
`);
    expect(duplicateRows(rows, BASE).map((row: { id: string; name: string }) => row.name)).toEqual(["@deepseek-ai/dsh-goal"]);
  });

  it("a row the base disables may be added and is not a duplicate", () => {
    const rows = rowsOf(`
- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'
`);
    expect(duplicateRows(rows, BASE)).toEqual([]);
  });

  it("a row absent from the base is not a duplicate", () => {
    const rows = rowsOf(`
- id: tool-ledger
  name: '@chopin/tool-ledger'
`);
    expect(duplicateRows(rows, BASE)).toEqual([]);
  });

  it("reproduces the incident: two duplicate rows, one legitimate", () => {
    const rows = rowsOf(`
- id: goal
  name: '@deepseek-ai/dsh-goal'
- id: goal-round-driver
  name: '@deepseek-ai/dsh-goal-round-driver'
- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'
`);
    expect(duplicateRows(rows, BASE).map((row: { id: string; name: string }) => row.id)).toEqual(["goal", "goal-round-driver"]);
  });

  it("skips the verdict without false positives when the base tree is unavailable", () => {
    const rows = rowsOf(`
- id: goal
  name: '@deepseek-ai/dsh-goal'
`);
    expect(duplicateRows(rows, undefined)).toEqual([]);
  });
});

describe("enabledByName", () => {
  it("later layers override earlier ones: disabled then enabled is enabled", () => {
    const rows = rowsOf(`
- id: x
  name: pkg-x
  disabled: true
- id: x
  name: pkg-x
`);
    expect(enabledByName(rows).get("pkg-x")).toBe(true);
  });

  it("later layers override earlier ones: enabled then disabled is disabled", () => {
    const rows = rowsOf(`
- id: x
  name: pkg-x
- id: x
  name: pkg-x
  disabled: true
`);
    expect(enabledByName(rows).get("pkg-x")).toBe(false);
  });
});

describe("presetDeclarations", () => {
  it("extracts preset declarations and their plugin rows from the bundle patch, ignoring rows outside the preset", () => {
    const presets = presetDeclarations(parseComposition(`
- id: unrelated
  name: pkg-unrelated
- insert:
    - id: preset-chopin
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: chopin
        plugins:
          - id: goal
            name: '@deepseek-ai/dsh-goal'
`));
    expect(presets).toEqual([{ id: "chopin", plugins: [{ id: "goal", name: "@deepseek-ai/dsh-goal" }] }]);
    expect(duplicateRows(collectRows(presets[0].plugins), BASE).map((row: { id: string }) => row.id)).toEqual(["goal"]);
  });
});
