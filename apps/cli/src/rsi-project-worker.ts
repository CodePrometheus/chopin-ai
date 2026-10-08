import vm from "node:vm";
import { posix } from "node:path";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const { files, check } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
try {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  const modules = new Map<string, vm.SourceTextModule>();
  const moduleFor = (path: string): vm.SourceTextModule => {
    if (!Object.hasOwn(files, path)) throw new Error("Module is outside the declared file graph");
    let module = modules.get(path);
    if (!module) {
      try {
        module = new vm.SourceTextModule(files[path], { context, identifier: path,
          importModuleDynamically() { throw new Error("Dynamic imports are not available"); } });
      } catch (error) { throw new Error(`Module ${path}: ${String(error)}`); }
      modules.set(path, module);
    }
    return module;
  };
  const entry = moduleFor(check.path);
  await entry.link((specifier, parent) => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) throw new Error("Only project-relative imports are available");
    const target = posix.normalize(posix.join(posix.dirname(parent.identifier), specifier));
    if (target.startsWith("../") || posix.isAbsolute(target)) throw new Error("Import escapes the project");
    return moduleFor(target);
  });
  await entry.evaluate({ timeout: 500 });
  Object.defineProperty(context, "__exports", { value: entry.namespace });
  const expression = `__exports[${JSON.stringify(check.export)}](...JSON.parse(${JSON.stringify(JSON.stringify(check.arguments))}))`;
  const pending = vm.runInContext(expression, context, { timeout: 500 });
  Object.defineProperty(context, "__result", { value: await pending });
  const serialized = vm.runInContext("JSON.stringify(__result)", context, { timeout: 500 });
  if (typeof serialized !== "string") throw new Error("Export did not return a serializable result");
  process.stdout.write(JSON.stringify({ value: JSON.parse(serialized) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error).slice(0, 1_000) }));
}
