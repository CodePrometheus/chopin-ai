#!/usr/bin/env node
/**
 * Type-check every test and fixture against package sources.
 *
 * Tests sit outside the package projects, so `tsc -b` never sees them. They import `../src`
 * while other packages' declarations import the same package by name, which would declare its
 * context augmentation twice; mapping every `@chopin/*` export to its source keeps one copy.
 * The mapping is derived from each package's exports, so it cannot drift from them.
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const paths = {};
for (const base of ["packages", "apps"]) {
  for (const entry of await readdir(join(root, base), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, base, entry.name);
    let manifest;
    try { manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")); } catch { continue; }
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const file = typeof target === "string" ? target : target.import ?? target.default;
      const source = file.replace(/^\.\/dist\//, "./src/").replace(/\.js$/, ".ts");
      paths[join(manifest.name, subpath)] = [join(dir, source)];
    }
  }
}

const config = {
  extends: join(root, "tsconfig.base.json"),
  compilerOptions: {
    noEmit: true, composite: false, incremental: false, declaration: false,
    rootDir: root, paths, allowImportingTsExtensions: true,
  },
  include: ["packages/*/tests/**/*.ts", "scripts/tests/**/*.ts", "tests/**/*.ts"].map((glob) => join(root, glob)),
};
const cache = join(root, "node_modules", ".cache", "chopin");
await mkdir(cache, { recursive: true });
const configPath = join(cache, "tsconfig.tests.json");
await writeFile(configPath, JSON.stringify(config, null, 2));
const result = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", configPath], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
