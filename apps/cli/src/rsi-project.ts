import { access, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { canonicalJson, improvementDigest } from "@chopin/evolution";
import type { JsonValue } from "@chopin/evolution";
import { writeTrialRecord } from "./rsi-trial.js";

export type ProjectCheck = { id: string; path: string; expected: JsonValue } & (
  { kind: "text" | "json" | "yaml" } | { kind: "module"; export: string; arguments: JsonValue[] }
);
export interface ProjectTask {
  id: string;
  family: string;
  taskKinds?: string[];
  split: "search" | "holdout";
  objective: string;
  files: Record<string, string>;
  writable: string[];
  publicChecks: ProjectCheck[];
  checks: ProjectCheck[];
  capture?: boolean;
}
export interface ProjectTaskPack { schemaVersion: 1; tasks: ProjectTask[] }
export const PROJECT_TASK_FILE = ".agents/rsi/tasks.json";
export const PROJECT_CHECK_PROTOCOL = 2;
const MAX_BYTES = 512_000;

export function projectPath(path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Task paths must be normalized relative file paths");
  }
  return path;
}

function checks(value: unknown): asserts value is ProjectCheck[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error("Invalid project checks");
  const ids = new Set();
  for (const check of value) {
    if (!check || typeof check.id !== "string" || !check.id || ids.has(check.id) || !["text", "json", "yaml", "module"].includes(check.kind)
      || typeof check.path !== "string" || !Object.hasOwn(check, "expected")) throw new Error("Invalid or duplicate project check");
    ids.add(check.id); projectPath(check.path);
    if (check.kind === "text" && typeof check.expected !== "string") throw new Error("Text checks require a string result");
    if (check.kind === "module" && (typeof check.export !== "string" || !check.export || !Array.isArray(check.arguments))) throw new Error("Module checks require an export and arguments");
  }
}

export function assertProjectTaskPack(value: unknown): asserts value is ProjectTaskPack {
  const pack = value as ProjectTaskPack;
  if (!pack || pack.schemaVersion !== 1 || !Array.isArray(pack.tasks) || pack.tasks.length < 2 || pack.tasks.length > 12) throw new Error("A project task pack needs 2-12 tasks");
  const ids = new Set(); const splits = new Map<string, string>(); const inputs = new Set();
  for (const task of pack.tasks) {
    if (!task || typeof task.id !== "string" || !/^[a-z0-9-]{1,80}$/.test(task.id) || ids.has(task.id)
      || typeof task.family !== "string" || !task.family.trim() || !["search", "holdout"].includes(task.split)
      || typeof task.objective !== "string" || !task.objective.trim() || task.objective.length > 8_000
      || !task.files || Array.isArray(task.files) || typeof task.files !== "object" || !Object.keys(task.files).length
      || !Array.isArray(task.writable) || !task.writable.length) throw new Error("Incomplete or duplicate project task");
    ids.add(task.id);
    if (task.taskKinds !== undefined && (!Array.isArray(task.taskKinds) || task.taskKinds.length > 32
      || new Set(task.taskKinds).size !== task.taskKinds.length
      || task.taskKinds.some(kind => typeof kind !== "string" || !kind.trim() || kind.length > 128))) throw new Error("Invalid declared task kinds");
    if (task.capture !== undefined && typeof task.capture !== "boolean") throw new Error("Task capture must be boolean");
    if (task.capture && task.split !== "search") throw new Error("Independent holdout tasks cannot be captured for search");
    if (splits.has(task.family) && splits.get(task.family) !== task.split) throw new Error("A task family cannot cross the search/holdout boundary");
    splits.set(task.family, task.split);
    for (const [path, content] of Object.entries(task.files)) {
      projectPath(path);
      if (typeof content !== "string") throw new Error("Task snapshots must contain text files");
    }
    for (const path of task.writable) {
      if (typeof path !== "string") throw new Error("Writable paths must be file names");
      projectPath(path);
      if (["AGENTS.md", "CLAUDE.md"].includes(path.split("/").at(-1)!)) throw new Error("Task instructions are immutable");
    }
    checks(task.publicChecks); checks(task.checks);
    if (!task.checks.length) throw new Error("A task must have an independent outcome check");
    const digest = improvementDigest({ objective: task.objective, files: task.files });
    if (inputs.has(digest)) throw new Error("Repeated task inputs are not independent tasks");
    inputs.add(digest);
  }
  if (![...splits.values()].includes("search") || ![...splits.values()].includes("holdout")) throw new Error("Both search and independent holdout tasks are required");
  if (Buffer.byteLength(JSON.stringify(pack)) > MAX_BYTES) throw new Error("Project task pack exceeds its input budget");
}

export async function loadProjectTasks(workspace: string, taskFile = PROJECT_TASK_FILE): Promise<ProjectTaskPack> {
  projectPath(taskFile);
  const root = await realpath(workspace);
  let path: string;
  try { path = await realpath(join(root, taskFile)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`No project tasks: provide ${taskFile} before authorizing an experiment`);
    throw error;
  }
  if (relative(root, path).split(sep).includes("..")) throw new Error("Task pack must be inside its project");
  const source = await readFile(path, "utf8");
  if (Buffer.byteLength(source) > MAX_BYTES) throw new Error("Project task pack exceeds its input budget");
  const pack: unknown = JSON.parse(source); assertProjectTaskPack(pack); return pack;
}

export async function snapshotWorkspace(directory: string, task: ProjectTask): Promise<Record<string, string>> {
  const files: Record<string, string> = Object.create(null);
  const allowed = new Set([...Object.keys(task.files), ...task.writable]);
  let bytes = 0;
  const visit = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name); const name = relative(directory, path).split(sep).join("/");
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile() || !allowed.has(name)) throw new Error("Workspace contains an undeclared file or symbolic link");
      const content = await readFile(path, "utf8"); bytes += Buffer.byteLength(content);
      if (bytes > MAX_BYTES) throw new Error("Workspace output exceeds its budget");
      files[name] = content;
    }
  };
  await visit(directory);
  for (const [path, content] of Object.entries(task.files)) {
    if (!task.writable.includes(path) && files[path] !== content) throw new Error("An immutable task input changed");
  }
  return files;
}

/** Candidates run only in an in-memory module graph inside a restricted child process; acceptance data never reaches the model workspace. */
async function executeModule(files: Record<string, string>, check: ProjectCheck, signal?: AbortSignal): Promise<{ value?: JsonValue; error?: string }> {
  if (process.platform !== "darwin") throw new Error("No supported project execution sandbox on this platform");
  let worker = fileURLToPath(new URL("./rsi-project-worker.js", import.meta.url));
  try { await access(worker); } catch { worker = fileURLToPath(new URL("../dist/rsi-project-worker.js", import.meta.url)); }
  await access(worker);
  const profile = "(version 1)(allow default)(deny network*)(deny file-write*)(deny process-fork)";
  return new Promise((resolveResult, reject) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "--experimental-vm-modules", "--permission", `--allow-fs-read=${dirname(worker)}`, worker], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; let stderr = ""; let ended = false;
    const finish = (error?: Error, value?: { value?: JsonValue; error?: string }) => {
      if (ended) return; ended = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolveResult(value!);
    };
    const abort = () => { child.kill("SIGKILL"); finish(new Error("Project check cancelled")); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(undefined, { error: "Project check exceeded its execution limit" }); }, 3_000);
    child.on("error", error => finish(error));
    child.stdin.on("error", error => finish(error));
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => { output += data; if (output.length > MAX_BYTES) { child.kill("SIGKILL"); finish(undefined, { error: "Project check output exceeded its limit" }); } });
    child.stderr.on("data", (data: string) => { stderr = (stderr + data).slice(-2_000); });
    child.on("close", code => {
      if (ended) return;
      if (code !== 0) { finish(new Error(`Project verifier process failed: ${stderr}`)); return; }
      try { finish(undefined, JSON.parse(output)); } catch { finish(new Error("Project verifier returned an invalid result")); }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.stdin.end(JSON.stringify({ files, check: { path: check.path, ...(check.kind === "module" ? { export: check.export, arguments: check.arguments } : {}) } }));
  });
}

export async function checkProject(files: Record<string, string>, suite: readonly ProjectCheck[], signal?: AbortSignal) {
  const results: Array<{ id: string; passed: boolean; error?: string }> = [];
  for (const check of suite) {
    signal?.throwIfAborted();
    let value: JsonValue | undefined; let error: string | undefined;
    if (check.kind === "module") ({ value, error } = await executeModule(files, check, signal));
    else {
      try { value = check.kind === "text" ? files[check.path] : check.kind === "yaml" ? parse(files[check.path]!) : JSON.parse(files[check.path]!); }
      catch { error = "Output is missing or invalid"; }
    }
    results.push({ id: check.id, passed: !error && value !== undefined && canonicalJson(value) === canonicalJson(check.expected), ...(error ? { error } : {}) });
  }
  return { sourceDigest: improvementDigest(files), passed: results.filter(result => result.passed).length, total: results.length, results };
}

export async function assertProjectExecutionAvailable(): Promise<void> {
  const result = await checkProject({ "probe.mjs": "export function check() { return true; }" },
    [{ id: "runtime", kind: "module", path: "probe.mjs", export: "check", arguments: [], expected: true }]);
  if (result.passed !== 1) throw new Error("Project execution sandbox failed its readiness check");
}

export async function recordProjectOutput(directory: string, files: Record<string, string>, result: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeTrialRecord(join(directory, "output.json"), { files, result });
}
