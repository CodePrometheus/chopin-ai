import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, isSeq, parse, parseDocument } from "yaml";

import { applyConfiguredCatalog, configuredCatalog } from "./model-catalog.js";
import { disableMemosTelemetry, memosConfigPath } from "./memos-config.js";
import { repoRoot, PROFILES, dshHome, dshBin } from "./environment.js";

const require = createRequire(import.meta.url);

export const SHARED_BUNDLES: readonly { name: string; version: string }[] = [
  { name: "@memtensor/memos-local-plugin", version: "2.0.20" },
  // Resume after crashes and break dead loops. dsh has no equivalent: a round cut off by a
  // timeout, 5xx or host crash just stops, and unattended that is a whole night. It resumes
  // only after non-human interruptions, skips permanent errors (auth failure, exhausted balance)
  // and has an idempotency guard (last tool was git push with an unconfirmed result: check first).
  { name: "dsh-client-auto-continue", version: "0.14.2" },
];

/** dsh's prerelease version. The whole monorepo releases in lockstep, all under the `next` dist-tag. */
const DSH_PRERELEASE = "0.2.0-rc.2";
const CORDIS_PINNED = [
  ["@deepseek-ai/cordis", "4.0.4"],
  ["@deepseek-ai/cordis-plugin-include", "1.0.9"],
  ["@deepseek-ai/cordis-plugin-loader", "1.0.5"],
  ["@deepseek-ai/cordis-plugin-logger-console", "1.0.4"],
  ["@deepseek-ai/schemastery", "3.18.4"],
  ["@earendil-works/pi-ai", "0.87.1"],
] as const;

/**
 * The list of dsh packages whose versions are pinned by force.
 *
 * The TUI's peer range accepts rc.2, but its own dependency/optionalDependency tree can
 * still split one DSH ABI across several prerelease versions. A profile must not let
 * agent/session/tools land on different Cordis instances or different rcs; this unifies
 * the DSH packages used by the current DSH base, the Web and the TUI surface to the same
 * release as `@deepseek-ai/dsh`.
 *
 * When switching surfaces, re-check its dependencies / optionalDependencies / peerDependencies;
 * this is a single-ABI-generation constraint, not a semver patch.
 */
const DSH_PINNED = [
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-agent-default-model",
  "@deepseek-ai/dsh-agent-instructions",
  "@deepseek-ai/dsh-agent-preset",
  "@deepseek-ai/dsh-authorization",
  "@deepseek-ai/dsh-atomic-write",
  "@deepseek-ai/dsh-brand",
  "@deepseek-ai/dsh-cmdline",
  "@deepseek-ai/dsh-commands",
  "@deepseek-ai/dsh-cordis-host-runner",
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-goal",
  "@deepseek-ai/dsh-invariants",
  "@deepseek-ai/dsh-jobs",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-llm-pi-ai",
  "@deepseek-ai/dsh-llm-retry",
  "@deepseek-ai/dsh-permission-presets",
  "@deepseek-ai/dsh-plan-mode",
  "@deepseek-ai/dsh-persona",
  "@deepseek-ai/dsh-sandbox-policy",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-session-persistence",
  "@deepseek-ai/dsh-session-title",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-shell",
  "@deepseek-ai/dsh-skill",
  "@deepseek-ai/dsh-storage",
  "@deepseek-ai/dsh-storage-domain",
  "@deepseek-ai/dsh-storage-json",
  "@deepseek-ai/dsh-subagent",
  "@deepseek-ai/dsh-system-prompt",
  "@deepseek-ai/dsh-terminal",
  "@deepseek-ai/dsh-terminal-bash",
  "@deepseek-ai/dsh-token-meter",
  "@deepseek-ai/dsh-tool-ask-user",
  "@deepseek-ai/dsh-tool-bash-persistent",
  "@deepseek-ai/dsh-tool-cordis",
  "@deepseek-ai/dsh-tool-workflow",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-user-approval",
  "@deepseek-ai/dsh-user-questions",
  "@deepseek-ai/dsh-workspace",
] as const;

/** UI bundles used in the past and since replaced; install removes them from the profile. */
const RETIRED_SURFACES = ["@deepseek-harness-tui/dsh-tui"];

/** Plugin packages in the chopin distribution. The profile must import every row by bare package name, so each is linked separately. */
const PLUGIN_PACKAGES = ["bundle", "evolution-runtime", "evolution-observer", "evolution-authoring", "plugin-adapter", "plugin-sandbox", "ultra-mode", "gate", "ledger", "signal", "report", "tool-ledger", "tool-session", "toolset", "evidence", "memos-quiet", "notify", "retry"];

/**
 * The profile manifest: bundle stacking order and plugin dependencies.
 *
 * Both pitfalls hit today live here: dsh's default for a non-template profile is only
 * `dsh-base`, with no UI, no preset mechanism and no cordis runtime, so `dsh-web-app` must
 * be added explicitly; pnpm isolates strictly, so linking only the bundle leaves its
 * dependencies (gate, ledger, ...) inside the link target's own node_modules, where the
 * loader cannot find them when importing by bare name from the profile directory.
 */
async function installedManifest(name: string, anchors: string[]): Promise<string> {
  try { return require.resolve(`${name}/package.json`, { paths: anchors }); }
  catch {
    let directory = dirname(fileURLToPath(import.meta.resolve(name)));
    while (dirname(directory) !== directory) {
      const path = join(directory, "package.json");
      try { if (JSON.parse(await readFile(path, "utf8")).name === name) return path; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      directory = dirname(directory);
    }
    throw new Error(`Cannot locate installed manifest for ${name}`);
  }
}

async function installedRuntimePackages(roots: string[]): Promise<Map<string, { directory: string; bundle: boolean }>> {
  const packages = new Map<string, { directory: string; bundle: boolean }>();
  const pending = [...roots];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const manifest = JSON.parse(await readFile(path, "utf8")) as {
      name: string; version: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>; dsh?: { bundle?: unknown };
    };
    if (manifest.name === "@deepseek-ai/dsh" || manifest.name.startsWith("@deepseek-ai/dsh-")) {
      if (manifest.version !== DSH_PRERELEASE) throw new Error(`runtime version mismatch: ${manifest.name}@${manifest.version}`);
      packages.set(manifest.name, { directory: dirname(path), bundle: manifest.dsh?.bundle !== undefined });
    }
    const local = createRequire(path);
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
      if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
      try { pending.push(local.resolve(`${name}/package.json`)); }
      catch (error) {
        if (manifest.optionalDependencies?.[name] || manifest.peerDependenciesMeta?.[name]?.optional) continue;
        throw error;
      }
    }
  }
  return packages;
}

async function ensureProfile(profileDir: string, profile: (typeof PROFILES)[keyof typeof PROFILES]): Promise<void> {
  const workspace = parse(await readFile(join(repoRoot, "pnpm-workspace.yaml"), "utf8")) as {
    overrides?: Record<string, string>;
  };
  const runtimeOverrides = Object.fromEntries(Object.entries(workspace.overrides ?? {}).filter(([, version]) => !version.startsWith("workspace:")).map(([name, version]) => [
    name,
    version.startsWith("file:") ? `file:${resolve(repoRoot, version.slice("file:".length))}` : version,
  ]));
  const runtimeBundles = new Set<string>();
  const runtimeAnchor = dirname(require.resolve("@deepseek-ai/dsh/package.json"));
  const roots = [join(runtimeAnchor, "package.json"), require.resolve(`${profile.surface}/package.json`, { paths: [repoRoot, runtimeAnchor] })];
  for (const [name, pkg] of await installedRuntimePackages(roots)) {
    runtimeOverrides[name] = `link:${pkg.directory}`;
    if (pkg.bundle) runtimeBundles.add(name);
  }
  if (profile.surfaceVersion !== undefined) {
    runtimeOverrides[profile.surface] = `link:${dirname(require.resolve(`${profile.surface}/package.json`))}`;
  }
  for (const [name] of CORDIS_PINNED) {
    if (runtimeOverrides[name]?.startsWith("link:")) continue;
    const manifestPath = await installedManifest(name, [repoRoot, runtimeAnchor]);
    runtimeOverrides[name] = `link:${dirname(manifestPath)}`;
  }
  const overrides = {
    ...Object.fromEntries(DSH_PINNED.map((name) => [name, DSH_PRERELEASE])),
    ...Object.fromEntries(CORDIS_PINNED),
    ...runtimeOverrides,
  };
  await mkdir(profileDir, { recursive: true });
  // pnpm >= 11 blocks dependencies with install scripts by default, reports
  // ERR_PNPM_IGNORED_BUILDS and exits non-zero, so dsh never appends the bundle to the profile.
  // Each one needs a verdict: the two dsh-TUI transitive deps are unused at runtime, deny;
  // MemOS's local sqlite / vector inference / image processing are really needed, allow.
  // Version pins live here too: since pnpm 11 the `pnpm` field in package.json is no longer
  // read ("The \"pnpm\" field in package.json is no longer read by pnpm"); overrides moved to this file.
  await writeFile(
    join(profileDir, "pnpm-workspace.yaml"),
    [
      "packages:",
      "  - .",
      "nodeLinker: hoisted",
      "autoInstallPeers: false",
      "allowBuilds:",
      "  '@google/genai': false",
      "  protobufjs: false",
      "  '@memtensor/memos-local-plugin': true",
      "  better-sqlite3: true",
      "  onnxruntime-node: true",
      "  sharp: true",
      "  esbuild: true",
      "  node-pty: false",
      "  koffi: false",
      "  node-addon-require-builtin: false",
      "  '@deepseek-ai/dsh-subprocess-local': false",
      "overrides:",
      ...Object.entries(overrides).map(([name, version]) => `  '${name}': ${JSON.stringify(version)}`),
      "",
    ].join("\n"),
    "utf8",
  );
  const manifestPath = join(profileDir, "package.json");
  let manifest: {
    name?: string;
    private?: boolean;
    packageManager?: string;
    dependencies?: Record<string, string>;
    dsh?: { profile?: { bundles?: string[] } };
  } = {};
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  manifest.name ??= `dsh-profile-${profile.name}`;
  manifest.private = true;
  manifest.packageManager = "pnpm@12.4.1";
  manifest.dependencies ??= {};
  const previousRuntime = `link:${join(repoRoot, ".agents", "runtime", "packages")}/`;
  for (const [name, source] of Object.entries(manifest.dependencies)) {
    if (source.startsWith(previousRuntime) && !runtimeOverrides[name]?.startsWith("link:")) delete manifest.dependencies[name];
  }
  const activeBundles = new Set(["@deepseek-ai/dsh-base", profile.surface, ...SHARED_BUNDLES.map((item) => item.name)]);
  for (const [name, source] of Object.entries(runtimeOverrides)) {
    if (runtimeBundles.has(name) && !activeBundles.has(name)) {
      delete manifest.dependencies[name];
      continue;
    }
    if (source.startsWith("link:")) manifest.dependencies[name] = source;
  }
  for (const name of PLUGIN_PACKAGES) {
    manifest.dependencies[`@chopin/${name}`] = `link:${join(repoRoot, "packages", name)}`;
  }
  manifest.dependencies["@chopin/cli"] = `link:${join(repoRoot, "apps", "cli")}`;
  // A UI bundle not shipped with dsh (the community TUI) must be installed as the profile's
  // own dependency. Clear the old one after switching UIs: two stacked UI layers each start an app.
  for (const other of Object.values(PROFILES)) {
    if (other.surface !== profile.surface && other.surfaceVersion !== undefined) delete manifest.dependencies[other.surface];
  }
  for (const legacy of RETIRED_SURFACES) delete manifest.dependencies[legacy];
  if (profile.surfaceVersion !== undefined) manifest.dependencies[profile.surface] = runtimeOverrides[profile.surface] ?? profile.surfaceVersion;
  for (const shared of SHARED_BUNDLES) manifest.dependencies[shared.name] = shared.version;
  manifest.dsh ??= {};
  manifest.dsh.profile ??= {};
  const bundles = manifest.dsh.profile.bundles ?? [];
  // Order matters: later layers override earlier ones by id. chopin must sit on top of the UI bundle.
  const wanted = ["@deepseek-ai/dsh-base", profile.surface, "@chopin/bundle", ...SHARED_BUNDLES.map((b) => b.name)];
  const surfaces = new Set([...Object.values(PROFILES).map((p) => p.surface), ...RETIRED_SURFACES, ...runtimeBundles]);
  manifest.dsh.profile.bundles = [...wanted, ...bundles.filter((b) => !wanted.includes(b) && !surfaces.has(b))];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/**
 * The profile's own patch layer: enable HMR and point the watch roots at chopin's packages.
 *
 * The web-app bundle disables HMR by default, and its watch root is the profile directory,
 * so the chopin repo is out of scope entirely. Once enabled: edit plugin source -> build, HMR
 * sees the dist change and hot-reloads that plugin, no restart -- the precondition for the
 * evolve mission to "rerun" itself.
 *
 * When the file exists, only the Chopin-generated per-package `dist` entries under
 * `hmr.config.root` are maintained; other rows and user-added roots stay as they are. The
 * file is never rewritten whole.
 */
/** Default capabilities come from host configuration; the UI only receives the session id to resume. */
const TERMINAL_PROFILE_ROWS = [
  "- id: agent-preset-registry",
  "  config:",
  "    default: chopin",
  "",
  "- id: tui-app",
  "  config:",
  "    sessionId: !!js process.env.DSH_TUI_RESUME_SESSION ?? ''",
  "",
];

function updateTerminalPatch(source: string): string {
  const options = { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }] };
  const doc = parseDocument(source, options);
  if (doc.errors.length > 0 || !isSeq(doc.contents)) throw new Error("Profile patch must be a valid sequence");
  const desired = parseDocument(TERMINAL_PROFILE_ROWS.join("\n"), options);
  if (!isSeq(desired.contents)) throw new Error("Terminal patch must be a sequence");
  for (const row of desired.contents.items) {
    if (!isMap(row)) throw new Error("Terminal patch row must be a mapping");
    const id = String(row.get("id"));
    const existing = doc.contents.items.findIndex((item) => isMap(item)
      && (String(item.get("id")) === id || (id === "tui-app" && String(item.get("id")) === "dsh-tui")
        || (id === "agent-preset-registry" && String(item.get("id")) === "agent-presets")));
    if (existing < 0) doc.contents.add(row);
    else {
      const target = doc.contents.items[existing];
      const config = row.get("config", true);
      if (isMap(target) && String(target.get("id")) === id && isMap(config)) {
        for (const pair of config.items) target.setIn(["config", String(pair.key)], pair.value);
      } else doc.contents.items[existing] = row;
    }
  }
  const hmr = doc.contents.items.find((item) => isMap(item) && String(item.get("id")) === "hmr");
  if (isMap(hmr)) hmr.setIn(["disabled"], parseDocument("!!js process.env.CHOPIN_HMR !== '1'", options).contents);
  return doc.toString();
}

function updateGeneratedHmrRoots(source: string, distRoots: readonly string[]): string | undefined {
  const lines = source.split("\n");
  const hmr = lines.findIndex((line) => line === "- id: hmr");
  if (hmr < 0) return undefined;
  const end = lines.findIndex((line, index) => index > hmr && /^- (?:id|insert):/.test(line));
  const blockEnd = end < 0 ? lines.length : end;
  const root = lines.findIndex((line, index) => index > hmr && index < blockEnd && line === "    root:");
  if (root < 0) return undefined;
  let listEnd = root + 1;
  while (listEnd < blockEnd && /^      - /.test(lines[listEnd] as string)) listEnd += 1;
  const generatedPrefix = `${join(repoRoot, "packages")}/`;
  const custom = lines.slice(root + 1, listEnd).filter((line) => {
    const value = line.slice("      - ".length);
    return !(value.startsWith(generatedPrefix) && value.endsWith("/dist"));
  });
  const generated = distRoots.map((dir) => `      - ${dir}`);
  lines.splice(root + 1, listEnd - root - 1, ...generated, ...custom.filter((line) => !generated.includes(line)));
  return lines.join("\n");
}

function updateCatalogProviders(
  source: string,
  options: {
    add: readonly string[];
    removeEmpty?: readonly string[];
  },
): string | undefined {
  const lines = source.split("\n");
  const llm = lines.findIndex((line) => line === "- id: llm-pi-ai");
  if (llm < 0) return undefined;
  const nextRow = lines.findIndex((line, index) => index > llm && /^- (?:id|insert):/.test(line));
  const blockEnd = nextRow < 0 ? lines.length : nextRow;
  const mapping = lines.findIndex((line, index) => index > llm && index < blockEnd && line === "    providers:");
  if (mapping < 0) return undefined;

  let mappingEnd = mapping + 1;
  while (mappingEnd < blockEnd) {
    const line = lines[mappingEnd] as string;
    if (line.trim() === "") {
      mappingEnd += 1;
      continue;
    }
    if (line.length - line.trimStart().length <= 4) break;
    mappingEnd += 1;
  }
  const removeEmpty = new Set(options.removeEmpty ?? []);
  for (let index = mappingEnd - 1; index > mapping; index -= 1) {
    const match = /^      ([A-Za-z0-9._-]+): \{\}$/.exec(lines[index] as string);
    if (match?.[1] !== undefined && removeEmpty.has(match[1])) {
      lines.splice(index, 1);
      mappingEnd -= 1;
    }
  }
  const configured = new Set(lines.slice(mapping + 1, mappingEnd).flatMap((line) => {
    const match = /^      ([A-Za-z0-9._-]+):/.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  }));
  let insertAt = mappingEnd;
  while (insertAt > mapping + 1 && lines[insertAt - 1]?.trim() === "") insertAt -= 1;
  const missing = options.add.filter((provider) => !configured.has(provider));
  if (missing.length > 0) lines.splice(insertAt, 0, ...missing.map((provider) => `      ${provider}: {}`));

  return lines.join("\n");
}

async function ensureProfilePatch(profileDir: string, profile: (typeof PROFILES)[keyof typeof PROFILES]): Promise<void> {
  const catalog = await configuredCatalog(join(repoRoot, "config", "model-catalog.json"));
  const patchPath = join(profileDir, "cordis.patch.yml");
  const tui = profile === PROFILES.tui;
  const catalogProviders = ["anthropic"];
  const catalogComments: readonly [string, string] = [
    "# Model routes read the base credential store.",
    "# Terminal and web use the same model catalog and authorization records.",
  ];
  // The loader imports build artifacts; listing each dist keeps the watch out of node_modules.
  const distRoots = (await readdir(join(repoRoot, "packages"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(repoRoot, "packages", entry.name, "dist"))
    .sort();
  let exists = true;
  try {
    await lstat(patchPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }
  if (exists) {
    const current = await readFile(patchPath, "utf8");
    let updated = tui ? updateTerminalPatch(current) : current;
    const withHmrRoots = updateGeneratedHmrRoots(updated, distRoots);
    if (withHmrRoots === undefined) {
      console.warn(`patch   ${patchPath} keeps custom HMR config (no generated root block found)`);
    } else {
      updated = withHmrRoots;
    }
    const withProviders = updateCatalogProviders(updated, {
      add: catalogProviders,
    });
    if (withProviders === undefined) {
      console.warn(`patch   ${patchPath} keeps custom model routes (no llm-pi-ai providers block found)`);
    } else {
      updated = withProviders;
    }
    updated = applyConfiguredCatalog(updated, catalog);
    if (updated !== current) {
      await writeFile(patchPath, updated, "utf8");
      console.log(`patch   ${patchPath} (updated HMR roots and model routes)`);
    }
    return;
  }
  // Watch roots are build artifacts only: watching `.` or `packages` walks every node_modules and
  // exhausts file descriptors, after which every spawn fails. The loader only imports dist anyway.
  const patch = [
    "# Generated by chopin install. Enables HMR and watches the build artifacts of chopin's plugin",
    "# packages: edit source -> build, and the plugin hot-reloads as soon as dist changes, no restart.",
    "#",
    "# Watch roots list dist only; never write `.` or `packages`: that watches node_modules recursively,",
    "# grabs tens of thousands of fds within minutes, and every spawn in the process then fails (Error: spawn EBADF).",
    "#",
    "# Edit as needed; chopin install only maintains the Chopin-generated packages/*/dist entries below.",
    "- id: hmr",
    "  disabled: !!js process.env.CHOPIN_HMR !== '1'",
    "  config:",
    "    root:",
    ...distRoots.map((dir) => `      - ${dir}`),
    "",
    ...catalogComments,
    "- id: llm-pi-ai",
    "  config:",
    "    providers:",
    ...catalogProviders.map((provider) => `      ${provider}: {}`),
    "",
    ...(profile === PROFILES.tui ? TERMINAL_PROFILE_ROWS : []),
  ].join("\n");
  await writeFile(patchPath, applyConfiguredCatalog(patch, catalog), "utf8");
  console.log(`patch   ${patchPath} (hmr enabled, watching ${distRoots.length} dist dir(s))`);
}

export async function install(prepareOnly = false): Promise<void> {
  if (!prepareOnly) {
    const native = spawnSync(process.execPath, [join(repoRoot, "scripts/prepare-native.mjs")], { stdio: "inherit" });
    if (native.status !== 0) throw new Error(`native runtime preparation exited with ${native.status ?? "signal"}`);
  }
  const dsh = prepareOnly ? undefined : await dshBin();
  const memosConfig = memosConfigPath(dshHome());
  if (await disableMemosTelemetry(memosConfig)) console.log(`memos   ${memosConfig} (usage telemetry off; set telemetry.enabled: true to share it)`);
  for (const profile of Object.values(PROFILES)) {
    const profileDir = join(dshHome(), "profiles", profile.name);
    await ensureProfile(profileDir, profile);
    await ensureProfilePatch(profileDir, profile);
    console.log(`profile ${profile.name} -> ${profileDir}`);
    if (dsh === undefined) continue;
    // Let dsh's own plugin subcommand run pnpm: it also maintains the profiles/node_modules fallback chain.
    const result = spawnSync(process.execPath, [dsh, "plugin", "--profile", profile.name, "install"], {
      stdio: "inherit",
      env: { ...process.env, npm_config_ignore_scripts: "true" },
    });
    if (result.status !== 0) throw new Error(`dsh plugin install for ${profile.name} exited with ${result.status ?? "signal"}`);
    const native = spawnSync(process.execPath, [join(repoRoot, "scripts/prepare-native.mjs"), profileDir], { stdio: "inherit" });
    if (native.status !== 0) throw new Error(`native profile preparation exited with ${native.status ?? "signal"}`);
  }


  console.log("");
  console.log("Everything has a default. Optional overrides go in ~/.dsh/.env:");
  console.log("  CHOPIN_LEDGER_DIR      where approved conclusions are kept (default ~/.chopin/ledger; put it under git)");
  console.log("  CHOPIN_ULTRA_STATE_DIR where Ultra effort recovery JSONL is kept (default ~/.chopin/ultra-mode)");
  console.log("  CHOPIN_GITHUB_REPO     owner/repo for the issue-history tools");
  console.log("  CHOPIN_REPO_PATH       which repo to work on (default: where you start chopin)");
  console.log("  CHOPIN_TEST_COMMAND    default: pnpm test  (also BUILD_COMMAND / LINT_COMMAND)");
  console.log("  CHOPIN_LLM_PROXY       proxy for the model endpoint only, e.g. http://127.0.0.1:8080");
  console.log("");
  console.log("Model access: put ANTHROPIC_API_KEY in ~/.dsh/.env, or use dsh's /login inside the UI (then /model)");
  console.log("Then just run: chopin        (terminal UI)");
  console.log("          or: chopin web    (browser UI)");
}
