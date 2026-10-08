/**
 * The pure verdicts of the composition check: parse a composition, collect plugin rows,
 * find rows duplicating the base.
 *
 * A separate module so it can be tested: `check-composition.mjs` runs the check at top level
 * and sets the exit code from the result, so importing it reruns the whole check.
 *
 * @module scripts/composition-rules
 */

import { parse } from "yaml";

/** `!!js` is the loader's dialect and ordinary parsers reject it; the check only cares about row structure, not expression values. */
export function parseComposition(text) {
  return parse(text.replaceAll("!!js", ""), { strict: false });
}

/**
 * Collect plugin rows. Does not descend into an ordinary row's `config`: a `name` in there
 * is the plugin's own config field (such as a submit tool's name), not a composition row.
 * Only a group row's config holds nested rows.
 */
export function collectRows(node, rows = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectRows(item, rows);
    return rows;
  }
  if (node === null || typeof node !== "object") return rows;
  if (typeof node.name === "string") {
    rows.push(node);
    if (node.group === true) collectRows(node.config, rows);
    return rows;
  }
  for (const value of Object.values(node)) collectRows(value, rows);
  return rows;
}

/**
 * Fold a composition tree into "package name -> enabled". Later layers override earlier
 * ones, so a name takes the `disabled` of its last occurrence.
 */
export function enabledByName(rows) {
  const enabled = new Map();
  for (const row of rows) {
    if (typeof row.name !== "string") continue;
    enabled.set(row.name, row.disabled !== true);
  }
  return enabled;
}

/**
 * Rows in the preset that mount a plugin the base already enables.
 *
 * A service-registering plugin mounted twice collides with its first registration and
 * **the whole preset fails to mount**: the process does not start, nothing degrades. A row
 * that resolves, a package that installs and green tests cannot catch it: the fault is not
 * in the row itself but in its relation to the base.
 *
 * Rows the base marks `disabled: true` are the exception: those are exactly what the preset
 * is meant to add.
 */
export function duplicateRows(rows, base) {
  if (base === undefined) return [];
  return rows.filter((row) => base.get(row.name) === true);
}

/**
 * Presets declared in a patch: `dsh-agent-preset` rows, with the plugin rows under their
 * `config.plugins`. Ordinary row collection does not descend into a non-group row's config,
 * so they are taken separately.
 */
export function presetDeclarations(patch) {
  return collectRows(patch)
    .filter((row) => row.name === "@deepseek-ai/dsh-agent-preset")
    .map((row) => ({ id: String(row.config?.id ?? row.id ?? "?"), plugins: row.config?.plugins ?? [] }));
}

/** Collect every tool named by a gate in a preset. */
export function collectGatedTools(node, tools = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) collectGatedTools(item, tools);
    return tools;
  }
  if (node === null || typeof node !== "object") return tools;
  for (const [key, value] of Object.entries(node)) {
    if (key === "satisfiedByTools" && Array.isArray(value)) {
      for (const tool of value) if (typeof tool === "string") tools.add(tool);
      continue;
    }
    collectGatedTools(value, tools);
  }
  return tools;
}

/** The submit tool names declared by the preset's `@chopin/report` rows. */
export function submissionTools(rows) {
  return rows.filter((row) => row.name === "@chopin/report" && typeof row.config?.tool?.name === "string")
    .map((row) => row.config.tool.name);
}
