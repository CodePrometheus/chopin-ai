#!/usr/bin/env node
/**
 * Composition check: every `name` row in the bundle patch and in every mission preset
 * must be a package that currently installs (or a file that exists).
 *
 * Without this check such mistakes only surface at startup, and the error then points
 * inside the loader, not at the row that is wrong.
 */

import { access, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// The pure verdicts live in composition-rules.mjs, which tests can import directly; this file
// runs the check at top level and sets the exit code, so importing it reruns the whole check.
import { collectGatedTools, collectRows, duplicateRows, enabledByName, parseComposition, presetDeclarations } from "./composition-rules.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The resolution anchor is the bundle package: its manifest is the authoritative statement
// of which plugins the chopin distribution needs; resolving from the repo root misses the
// ones installed only under the bundle.
const require = createRequire(join(repoRoot, "packages/bundle/package.json"));

/**
 * Rows the base composition already provides: the full tree of `dsh-base` plus the UI
 * bundle, without the user layer.
 *
 * The preset is the last layer on top of that tree. Adding a row for a plugin the base
 * already enables mounts the same plugin twice; if it registers a service, the second
 * registration collides with the first and **the whole preset fails to mount** -- not a
 * degradation, chopin does not start at all. A row that resolves, a package that installs
 * and green tests cannot catch it, because the fault is not in the row itself but in its
 * relation to the base.
 *
 * Rows the UI bundle marks `disabled: true` are the exception: those are exactly what the
 * preset is meant to add.
 *
 * Skipped when the profile is not installed; once the manifest exists, a failed dump is a
 * broken install and must fail.
 */
async function loadBaseComposition(profile) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const dshBin = require.resolve("@deepseek-ai/dsh/lib/bin.js");
  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  try {
    await access(join(dshHome, "profiles", profile, "package.json"));
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [dshBin, "--profile", profile, "--dump-default-config"],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    return { kind: "ok", rows: enabledByName(collectRows(parseComposition(stdout))) };
  } catch (error) {
    return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

function resolvable(name, from) {
  // cordis built-in rows (`cordis:group` etc.) have no package.
  if (name.startsWith("cordis:")) return true;
  try {
    require.resolve(name.startsWith(".") ? resolve(from, name) : name);
    return true;
  } catch {
    try {
      require.resolve(`${name}/package.json`);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Every tool a gate names must have a source, otherwise this mission's submit exit is
 * blocked forever.
 *
 * The runtime guard reports this as a configuration error, but only when the model first
 * submits. This is a best effort before startup: a static scan finds declarative toolset
 * tool names and the names registered in each package's source, but not dynamically
 * generated ones. So an unfound name only warns and does not fail; the authoritative
 * verdict is at runtime.
 */
async function collectToolsetTools(repoRoot) {
  const byToolset = new Map();
  const toolsetsDir = join(repoRoot, "toolsets");
  for (const entry of await readdir(toolsetsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const doc = parseComposition(await readFile(join(toolsetsDir, entry.name), "utf8"));
    const names = new Set();
    for (const tool of doc?.tools ?? []) if (typeof tool?.name === "string") names.add(tool.name);
    byToolset.set(doc?.name ?? entry.name.replace(/\.ya?ml$/, ""), names);
  }
  return byToolset;
}

/** Which toolsets a preset's `@chopin/toolset` rows declare. */
function collectDeclaredToolsets(rows) {
  const declared = new Set();
  for (const row of rows) {
    if (row.name !== "@chopin/toolset") continue;
    for (const name of row.config?.toolsets ?? []) if (typeof name === "string") declared.add(name);
  }
  return declared;
}

async function collectNativeTools(repoRoot) {
  const known = new Set();
  // Native tools: registrations of the form `name: "xxx"` in each package's source.
  const packagesDir = join(repoRoot, "packages");
  for (const pkg of await readdir(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const srcDir = join(packagesDir, pkg.name, "src");
    let files;
    try {
      files = await readdir(srcDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".ts")) continue;
      const text = await readFile(join(srcDir, file), "utf8");
      for (const match of text.matchAll(/^\s+name: "([a-z][a-z0-9_]*)",$/gm)) known.add(match[1]);
    }
  }
  return known;
}

/**
 * For dsh tool plugins referenced by preset rows, the tool names exist only in the package's
 * build output. Resolve the row name to the package and scan the output for `name: "xxx"`
 * literals. This picks up some strings that are not tool names, but the check only warns
 * and never fails: the authoritative verdict is the runtime guard.
 */
async function collectToolsFromRows(rows) {
  const known = new Set();
  for (const row of rows) {
    if (row.name.startsWith("cordis:") || row.name.startsWith(".")) continue;
    let manifestPath;
    try {
      // Same anchor as row resolution: the bundle manifest is the authority on which plugins chopin needs.
      manifestPath = require.resolve(`${row.name}/package.json`);
    } catch {
      continue;
    }
    const libDir = join(dirname(manifestPath), "lib");
    let files;
    try {
      files = await readdir(libDir, { recursive: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".js")) continue;
      const text = await readFile(join(libDir, file), "utf8");
      for (const match of text.matchAll(/\bname:\s*["']([a-z][a-z0-9_]*)["']/g)) known.add(match[1]);
    }
  }
  return known;
}

async function check(label, path) {
  return reportUnresolvable(label, collectRows(parseComposition(await readFile(path, "utf8"))), dirname(path));
}

function reportUnresolvable(label, rows, from) {
  const bad = rows.filter((row) => !resolvable(row.name, from));
  const mark = bad.length === 0 ? "ok  " : "FAIL";
  console.log(`[${mark}] ${label}  ${rows.length} row(s)`);
  for (const row of bad) console.log(`         unresolvable: ${row.id ?? "?"} -> ${row.name}`);
  return bad.length;
}

let failures = 0;
failures += await check("bundle", join(repoRoot, "packages/bundle/cordis.patch.yml"));
failures += await check("evolution reconcile", join(repoRoot, "config/evolution-reconcile.cordis.yml"));

// Profile names match PROFILES in apps/cli. Both surfaces must be checked; looking at the TUI
// alone misses the Web base's enabled state and real loader errors.
const baseCompositions = new Map();
for (const profile of ["chopin-tui", "chopin"]) {
  const loaded = await loadBaseComposition(profile);
  if (loaded.kind === "missing") {
    console.log(`[warn] profile ${profile} is not installed; skipping its base duplicate-mount check`);
  } else if (loaded.kind === "error") {
    console.log(`[FAIL] profile ${profile} cannot dump the base composition: ${loaded.detail}`);
    failures += 1;
  } else {
    console.log(`[ok  ] profile ${profile} base composition loads`);
    baseCompositions.set(profile, loaded.rows);
  }
}

const toolsetTools = await collectToolsetTools(repoRoot);
const nativeTools = await collectNativeTools(repoRoot);
// The union of every declarative tool name in the repo. It separates "this name does not
// exist at all" from "it exists, but this preset does not load that toolset"; the latter is
// a definite configuration error and fails.
const anyToolsetTool = new Set([...toolsetTools.values()].flatMap((names) => [...names]));

// Presets are declared by the patch files in the bundle manifest other than the main patch.
const bundleDir = join(repoRoot, "packages/bundle");
const bundleManifest = JSON.parse(await readFile(join(bundleDir, "package.json"), "utf8"));
const presetPatches = [bundleManifest.dsh.bundle.patch].flat()
  .map((file) => join(bundleDir, file))
  .filter((path) => path !== join(bundleDir, "cordis.patch.yml"));
const presets = [];
for (const path of presetPatches) {
  failures += await check(`bundle ${relative(repoRoot, path)}`, path);
  for (const preset of presetDeclarations(parseComposition(await readFile(path, "utf8")))) presets.push({ ...preset, path });
}

for (const preset of presets) {
  const composition = preset.plugins;
  const rows = collectRows(composition);
  failures += reportUnresolvable(`preset ${preset.id}`, rows, dirname(preset.path));
  const gated = collectGatedTools(composition);
  const fromRows = await collectToolsFromRows(rows);

  for (const [profile, baseComposition] of baseCompositions) {
    const duplicates = duplicateRows(rows, baseComposition);
    if (duplicates.length === 0) continue;
    for (const row of duplicates) {
      console.log(`         FAIL ${profile}: row ${row.id ?? "?"} (${row.name}) is already enabled by the base composition`);
    }
    console.log("         The base already mounts it. A service-registering plugin mounted twice collides, and the whole preset fails to mount.");
    console.log("         Only rows the base marks disabled: true need to be added in the preset.");
    failures += duplicates.length;
  }

  // The declarative tools this preset actually loads, not the union of every toolset in the
  // repo. The union would miss the whole class of "the gated tool is in another toolset this
  // preset never loads".
  const loaded = new Set();
  for (const name of collectDeclaredToolsets(rows)) {
    for (const tool of toolsetTools.get(name) ?? []) loaded.add(tool);
  }

  const missing = [...gated].filter((tool) => !loaded.has(tool) && !nativeTools.has(tool) && !fromRows.has(tool));

  // The name exists in another toolset, this preset just does not load it: a configuration error, fail.
  const notLoaded = missing.filter((tool) => anyToolsetTool.has(tool)).sort();
  if (notLoaded.length > 0) {
    console.log(`         FAIL gates name tools from a toolset this preset does not load: ${notLoaded.join(", ")}`);
    failures += notLoaded.length;
  }

  // The rest that cannot be found fail too. A gate naming a tool that does not exist blocks
  // that submit exit forever: every submission is rejected, with a reason pointing at a tool
  // the model can never call. Reporting that as a warning is the same as not reporting it:
  // a warning blocks nothing, and the composition-checked gate only looks at this script's
  // exit code. If a dynamically registered tool is ever misjudged, widen the scan instead of
  // demoting the verdict back to a warning.
  const unknown = missing.filter((tool) => !anyToolsetTool.has(tool)).sort();
  if (unknown.length > 0) {
    console.log(`         FAIL gates name tools with no statically visible source: ${unknown.join(", ")}`);
    failures += unknown.length;
  }
}
if (failures > 0) {
  console.error(`\n${failures} unresolvable row(s)`);
  process.exit(1);
}
console.log("\ncomposition ok");
