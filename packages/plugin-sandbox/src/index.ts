import { spawn, spawnSync } from "node:child_process";
import { accessSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCapabilityFixtureSuite,
  assertCapabilityManifest,
  assertFixtureCoverage,
  canonicalJson,
  capabilityFixtureDigest,
  assertCapabilityDispatch,
} from "@chopin/evolution";
import type { CapabilityFixtureSuite, JsonObject, JsonValue } from "@chopin/evolution";

import type {
  SandboxAction,
  SandboxInspection,
  SandboxRequest,
  SandboxResponse,
  SandboxSuccess,
} from "./protocol.js";

export type {
  SandboxedContextDefinition,
  SandboxedDefinitions,
  SandboxedGuardDefinition,
  SandboxedToolDefinition,
  SandboxInspection,
} from "./protocol.js";

const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DARWIN_PROFILE = "(version 1)(allow default)(deny network*)(deny file-write*)(deny process-fork)";

export class PluginSandboxError extends Error {
  constructor(message: string) {
    super(`plugin sandbox: ${message}`);
    this.name = "PluginSandboxError";
  }
}

/** A candidate code error explicitly returned by the isolated process, distinct from host startup or transport failures. */
export class PluginExecutionError extends PluginSandboxError {
  constructor(message: string) { super(message); this.name = "PluginExecutionError"; }
}

export interface PluginSandboxOptions {
  timeoutMs?: number;
  workerPath?: string;
}

function workerPath(override?: string): string {
  if (override !== undefined) return override;
  const candidates = [
    fileURLToPath(new URL("./worker.js", import.meta.url)),
    fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // Try the source-tree fallback used by tests after `pnpm build`.
    }
  }
  throw new PluginSandboxError(`worker is not built at ${candidates.join(" or ")}`);
}

function command(entryPath: string, worker: string): { file: string; args: string[] } {
  if (process.platform !== "darwin") {
    throw new PluginSandboxError(`no supported OS network sandbox for ${process.platform}; executable capability denied`);
  }
  const nodeArgs = [
    "--experimental-vm-modules",
    "--permission",
    `--allow-fs-read=${dirname(worker)}`,
    `--allow-fs-read=${dirname(entryPath)}`,
    worker,
  ];
  return { file: "/usr/bin/sandbox-exec", args: ["-p", DARWIN_PROFILE, process.execPath, ...nodeArgs] };
}

function request(entryPath: string, inspection: Pick<SandboxInspection, "manifest">, action: SandboxAction): SandboxRequest {
  return {
    entryPath,
    capabilityId: inspection.manifest.id,
    capabilityVersion: inspection.manifest.version,
    action,
  };
}

function parseResponse(stdout: string, stderr: string, exitCode: number | null): SandboxSuccess {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new PluginSandboxError(`worker returned invalid JSON (exit ${String(exitCode)}): ${stderr.trim() || stdout.trim()}`);
  }
  if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) throw new PluginSandboxError("worker response has no verdict");
  const response = parsed as SandboxResponse;
  if (!response.ok) throw new PluginExecutionError(response.error);
  if (exitCode !== 0) throw new PluginSandboxError(`worker exited ${String(exitCode)} after a success response`);
  return response;
}

function runSync(value: SandboxRequest, options: PluginSandboxOptions): SandboxSuccess {
  const worker = workerPath(options.workerPath);
  const launched = command(value.entryPath, worker);
  const result = spawnSync(launched.file, launched.args, {
    input: JSON.stringify(value),
    encoding: "utf8",
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    env: {},
  });
  if (result.error !== undefined) throw new PluginSandboxError(result.error.message);
  return parseResponse(result.stdout, result.stderr, result.status);
}

async function run(value: SandboxRequest, options: PluginSandboxOptions, signal?: AbortSignal): Promise<SandboxSuccess> {
  const worker = workerPath(options.workerPath);
  const launched = command(value.entryPath, worker);
  return new Promise((resolve, reject) => {
    const child = spawn(launched.file, launched.args, { stdio: ["pipe", "pipe", "pipe"], env: {} });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(() => reject(new PluginSandboxError("call aborted")));
    };
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new PluginSandboxError(`call exceeded ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`)));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) abort();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > MAX_OUTPUT_BYTES) abort();
    });
    child.on("error", (error) => finish(() => reject(new PluginSandboxError(error.message))));
    child.on("exit", (code) => finish(() => {
      try {
        resolve(parseResponse(stdout, stderr, code));
      } catch (error) {
        reject(error);
      }
    }));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
    else child.stdin.end(JSON.stringify(value));
  });
}

function inspectionIdentity(capabilityId: string, capabilityVersion: string): Pick<SandboxInspection, "manifest"> {
  return {
    manifest: {
      schemaVersion: 1,
      id: capabilityId,
      version: capabilityVersion,
      kind: "plugin",
      runtime: "dsh-plugin",
      intendedEffect: "preventive",
      summary: "sandbox inspection request",
      entry: "index.mjs",
      trigger: {},
      provides: { contexts: [], skills: [], guards: [], tools: [], services: [], workflows: [] },
      permissions: [],
      dependencies: [],
      conflicts: [],
      requires: { chopinPluginApi: "^1.0.0" },
      lineage: { candidateIds: ["sandbox-inspection"], proposalIds: ["sandbox-inspection"] },
    },
  };
}

export class SandboxedPlugin {
  private constructor(
    readonly entryPath: string,
    readonly inspection: SandboxInspection,
    private readonly options: PluginSandboxOptions,
  ) {}

  static async inspect(
    entryPath: string,
    capabilityId: string,
    capabilityVersion: string,
    options: PluginSandboxOptions = {},
  ): Promise<SandboxedPlugin> {
    const response = await run(request(entryPath, inspectionIdentity(capabilityId, capabilityVersion), { kind: "inspect" }), options);
    if (response.kind !== "inspect") throw new PluginSandboxError(`worker returned ${response.kind} for inspect`);
    try { assertCapabilityManifest(response.value.manifest); }
    catch (error) { throw new PluginExecutionError((error as Error).message); }
    if (response.value.manifest.id !== capabilityId || response.value.manifest.version !== capabilityVersion) {
      throw new PluginExecutionError("runtime manifest identity differs from requested capability");
    }
    for (const tool of response.value.definitions.tools) {
      const dispatch = tool.dispatch;
      if (dispatch === undefined) continue;
      if (!response.value.manifest.permissions.includes("tools:dispatch")) throw new PluginExecutionError("Dispatch requires tools:dispatch permission");
      try { assertCapabilityDispatch(dispatch, tool.name); }
      catch (error) { throw new PluginExecutionError(`${tool.name}: ${String(error)}`); }
    }
    if (response.value.manifest.permissions.includes("tools:dispatch") && !response.value.definitions.tools.some(tool => tool.dispatch)) {
      throw new PluginExecutionError("Dispatch permission requires an executable dispatch definition");
    }
    return new SandboxedPlugin(entryPath, response.value, options);
  }

  renderContext(name: string, input: Extract<SandboxAction, { kind: "context" }>["input"]): string {
    const response = runSync(request(this.entryPath, this.inspection, { kind: "context", name, input }), this.options);
    if (response.kind !== "context") throw new PluginSandboxError(`worker returned ${response.kind} for context`);
    return response.value;
  }

  evaluateGuard(name: string, input: Extract<SandboxAction, { kind: "guard" }>["input"]): string | undefined {
    const response = runSync(request(this.entryPath, this.inspection, { kind: "guard", name, input }), this.options);
    if (response.kind !== "guard") throw new PluginSandboxError(`worker returned ${response.kind} for guard`);
    return response.value ?? undefined;
  }

  async executeTool(name: string, input: Extract<SandboxAction, { kind: "tool" }>["input"], signal?: AbortSignal): Promise<JsonValue> {
    const response = await run(request(this.entryPath, this.inspection, { kind: "tool", name, input }), this.options, signal);
    if (response.kind !== "tool") throw new PluginSandboxError(`worker returned ${response.kind} for tool`);
    return response.value;
  }
}

export interface CapabilityFixtureCheckResult {
  id: string;
  kind: "context" | "guard" | "tool";
  name: string;
  status: "pass" | "fail";
  detail?: string;
}

export interface CapabilityFixtureReport {
  fixtureDigest: string;
  passed: boolean;
  checks: CapabilityFixtureCheckResult[];
}

/** Runs approved synthetic fixtures in an OS sandbox recreated for every call. */
export async function verifyCapabilityFixtures(
  plugin: SandboxedPlugin,
  suite: CapabilityFixtureSuite,
): Promise<CapabilityFixtureReport> {
  assertCapabilityFixtureSuite(suite);
  assertFixtureCoverage(suite, plugin.inspection.manifest);
  const checks: CapabilityFixtureCheckResult[] = [];
  for (const fixture of suite.cases) {
    try {
      if (fixture.kind === "context") {
        const actual = plugin.renderContext(fixture.name, fixture.input);
        const matches = "equals" in fixture.expect
          ? actual === fixture.expect.equals
          : "contains" in fixture.expect ? actual.includes(fixture.expect.contains) : actual.length <= fixture.expect.maxChars;
        if (!matches) throw new Error(`context returned ${JSON.stringify(actual)}`);
      } else if (fixture.kind === "guard") {
        const actual = plugin.evaluateGuard(fixture.name, fixture.input) ?? null;
        if (actual !== fixture.expect.decision) throw new Error(`guard returned ${JSON.stringify(actual)}`);
      } else {
        const actual = await plugin.executeTool(fixture.name, fixture.input);
        if (canonicalJson(actual) !== canonicalJson(fixture.expect.equals)) {
          throw new Error(`tool returned ${canonicalJson(actual)}`);
        }
      }
      checks.push({ id: fixture.id, kind: fixture.kind, name: fixture.name, status: "pass" });
    } catch (error) {
      if (error instanceof PluginSandboxError && !(error instanceof PluginExecutionError)) throw error;
      checks.push({ id: fixture.id, kind: fixture.kind, name: fixture.name, status: "fail", detail: (error as Error).message });
    }
  }
  return {
    fixtureDigest: capabilityFixtureDigest(suite as unknown as JsonValue),
    passed: checks.every((check) => check.status === "pass"),
    checks,
  };
}
