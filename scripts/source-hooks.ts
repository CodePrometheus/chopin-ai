// Preloaded by `chopin-dev.sh`: resolves the workspace's packages to their TypeScript sources, which Node runs by
// stripping their types, so a checkout runs without a build and never falls back to a stale one.
import { readdir, readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface Manifest {
  name: string;
  exports?: Record<string, { default: string }>;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const packages: string[] = [];
/** Each export of the workspace's packages, by specifier, as the source its build compiles from `src/` to `dist/`. */
const sources = new Map<string, string>();
for (const group of ["apps", "packages"]) {
  for (const entry of await readdir(join(root, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, group, entry.name);
    // As for the package manager, a directory is a package only with a manifest.
    const text = await readFile(join(directory, "package.json"), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const manifest = JSON.parse(text) as Manifest;
    packages.push(manifest.name);
    for (const [path, target] of Object.entries(manifest.exports ?? {})) {
      const source = join(directory, target.default.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts"));
      sources.set(path === "." ? manifest.name : `${manifest.name}${path.slice(1)}`, pathToFileURL(source).href);
    }
  }
}

// Marks this process, and no other, as one running from the sources, so chopin starts its own through these hooks.
Reflect.set(globalThis, Symbol.for("chopin-ai.source-hooks"), import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = sources.get(specifier);
    if (source !== undefined) return { url: source, shortCircuit: true };
    if (packages.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
      throw new Error(`${specifier} is not an export of a workspace package`);
    }
    // A source's relative `.js` import names the file the build compiles from the matching `.ts`.
    if (context.parentURL?.endsWith(".ts") && specifier.startsWith(".") && specifier.endsWith(".js")) {
      return { url: new URL(`${specifier.slice(0, -".js".length)}.ts`, context.parentURL).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
