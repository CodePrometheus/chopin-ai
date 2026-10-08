import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

import type {
  SandboxAction,
  SandboxInspection,
  SandboxRequest,
  SandboxResponse,
} from "./protocol.js";

const MAX_INPUT_BYTES = 1024 * 1024;
const VM_TIMEOUT_MS = 1_000;

async function stdin(): Promise<string> {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    value += chunk;
    if (Buffer.byteLength(value, "utf8") > MAX_INPUT_BYTES) throw new Error("sandbox request exceeds input budget");
  }
  return value;
}

function prelude(capabilityId: string, capabilityVersion: string): string {
  return `
(() => {
  const contexts = [];
  const guards = [];
  const tools = [];
  const names = { context: new Set(), guard: new Set(), tool: new Set() };
  const signal = Object.freeze({
    aborted: false,
    reason: undefined,
    addEventListener() {},
    removeEventListener() {},
    throwIfAborted() {},
  });
  const stableName = (value, kind) => {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
      throw new Error(kind + " name is not a stable identifier");
    }
    if (names[kind].has(value)) throw new Error("duplicate " + kind + " " + value);
    names[kind].add(value);
  };
  const jsonObject = (value, path) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(path + " must be an object");
    JSON.stringify(value);
  };
  const runtime = Object.freeze({
    capabilityId: ${JSON.stringify(capabilityId)},
    capabilityVersion: ${JSON.stringify(capabilityVersion)},
    signal,
    registerContext(definition) {
      jsonObject(definition, "context definition");
      stableName(definition.name, "context");
      if (!Number.isSafeInteger(definition.order)) throw new Error("context order must be a safe integer");
      if (typeof definition.render !== "function") throw new Error("context render must be a function");
      contexts.push(definition);
      return () => {};
    },
    registerGuard(definition) {
      jsonObject(definition, "guard definition");
      stableName(definition.name, "guard");
      if (!Array.isArray(definition.tools) || definition.tools.length === 0 || definition.tools.some((item) => typeof item !== "string" || item === "")) {
        throw new Error("guard tools must be non-empty strings");
      }
      if (typeof definition.evaluate !== "function") throw new Error("guard evaluate must be a function");
      guards.push(definition);
      return () => {};
    },
    registerTool(definition) {
      jsonObject(definition, "tool definition");
      stableName(definition.name, "tool");
      if (typeof definition.description !== "string" || definition.description.trim() === "") throw new Error("tool description must be non-empty");
      jsonObject(definition.inputSchema, "tool inputSchema");
      jsonObject(definition.outputSchema, "tool outputSchema");
      if (typeof definition.execute !== "function") throw new Error("tool execute must be a function");
      tools.push(definition);
      return () => {};
    },
  });
  const find = (items, name, kind) => {
    const item = items.find((entry) => entry.name === name);
    if (item === undefined) throw new Error("unknown sandboxed " + kind + " " + name);
    return item;
  };
  globalThis.__chopin = Object.freeze({
    runtime,
    inspection(plugin) {
      return {
        manifest: plugin.manifest,
        definitions: {
          contexts: contexts.map(({ name, order }) => ({ name, order })),
          guards: guards.map(({ name, tools }) => ({ name, tools: [...tools] })),
          tools: tools.map(({ name, description, inputSchema, outputSchema, dispatch }) => ({ name, description, inputSchema, outputSchema,
            ...(dispatch === undefined ? {} : { dispatch }) })),
        },
      };
    },
    renderContext(name, input) {
      return find(contexts, name, "context").render(Object.freeze({ ...input, signal }));
    },
    evaluateGuard(name, input) {
      return find(guards, name, "guard").evaluate(Object.freeze(input));
    },
    executeTool(name, input) {
      return find(tools, name, "tool").execute(Object.freeze({ ...input, signal }));
    },
  });
})();`;
}

function jsonClone<T>(context: vm.Context, expression: string): T {
  const serialized = vm.runInContext(`JSON.stringify(${expression})`, context, { timeout: VM_TIMEOUT_MS }) as unknown;
  if (typeof serialized !== "string") throw new Error("sandbox value is not JSON-serializable");
  return JSON.parse(serialized) as T;
}

async function load(request: SandboxRequest): Promise<{ context: vm.Context; inspection: SandboxInspection }> {
  const source = await readFile(request.entryPath, "utf8");
  const context = vm.createContext(Object.create(null), {
    name: `chopin:${request.capabilityId}:${request.capabilityVersion}`,
    codeGeneration: { strings: false, wasm: false },
  });
  vm.runInContext(prelude(request.capabilityId, request.capabilityVersion), context, { timeout: VM_TIMEOUT_MS });
  const sdk = new vm.SourceTextModule(
    "export function defineChopinPlugin(plugin) { return Object.freeze(plugin); }",
    { context, identifier: "chopin:plugin-sdk" },
  );
  const entryUrl = pathToFileURL(request.entryPath).href;
  const plugin = new vm.SourceTextModule(source, {
    context,
    identifier: entryUrl,
    initializeImportMeta(meta) {
      meta.url = entryUrl;
    },
    importModuleDynamically() {
      throw new Error("dynamic import is not allowed in a Chopin capability");
    },
  });
  await sdk.link(() => {
    throw new Error("@chopin/plugin-sdk cannot import dependencies");
  });
  await sdk.evaluate({ timeout: VM_TIMEOUT_MS });
  await plugin.link((specifier) => {
    if (specifier !== "@chopin/plugin-sdk") throw new Error(`import ${specifier} is not allowed in a Chopin capability`);
    return sdk;
  });
  await plugin.evaluate({ timeout: VM_TIMEOUT_MS });
  const namespace = plugin.namespace as unknown as { default?: unknown };
  if (typeof namespace.default !== "object" || namespace.default === null) throw new Error("capability entry has no default plugin object");
  (context as Record<string, unknown>).__plugin = namespace.default;
  const activation = vm.runInContext("__plugin.activate(__chopin.runtime)", context, { timeout: VM_TIMEOUT_MS }) as unknown;
  await Promise.resolve(activation);
  return { context, inspection: jsonClone<SandboxInspection>(context, "__chopin.inspection(__plugin)") };
}

function actionExpression(action: SandboxAction): string {
  if (action.kind === "inspect") return "__chopin.inspection(__plugin)";
  const name = JSON.stringify(action.name);
  const input = `JSON.parse(${JSON.stringify(JSON.stringify(action.input))})`;
  if (action.kind === "context") return `__chopin.renderContext(${name}, ${input})`;
  if (action.kind === "guard") return `({ value: __chopin.evaluateGuard(${name}, ${input}) ?? null })`;
  return `__chopin.executeTool(${name}, ${input})`;
}

async function execute(request: SandboxRequest): Promise<SandboxResponse> {
  const { context, inspection } = await load(request);
  if (request.action.kind === "inspect") return { ok: true, kind: "inspect", value: inspection };
  const expression = actionExpression(request.action);
  if (request.action.kind === "context") {
    const value = vm.runInContext(expression, context, { timeout: VM_TIMEOUT_MS }) as unknown;
    if (typeof value !== "string") throw new Error("sandboxed context must return a string");
    return { ok: true, kind: "context", value };
  }
  if (request.action.kind === "guard") {
    const value = jsonClone<{ value: string | null }>(context, expression).value;
    if (value !== null && typeof value !== "string") throw new Error("sandboxed guard must return a string or undefined");
    return { ok: true, kind: "guard", value };
  }
  (context as Record<string, unknown>).__toolResult = await Promise.resolve(
    vm.runInContext(expression, context, { timeout: VM_TIMEOUT_MS }),
  );
  return { ok: true, kind: "tool", value: jsonClone(context, "__toolResult") };
}

try {
  const value = JSON.parse(await stdin()) as SandboxRequest;
  const response = await execute(value);
  process.stdout.write(`${JSON.stringify(response)}\n`);
} catch (error) {
  const response: SandboxResponse = { ok: false, error: error instanceof Error ? error.message : String(error) };
  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exitCode = 1;
}
