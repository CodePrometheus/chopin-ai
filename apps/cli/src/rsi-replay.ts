import { mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import { canonicalJson, improvementDigest } from "@chopin/evolution";
import { latestHumanPrompt } from "@chopin/evolution-runtime/facts";
import { checkProject, loadProjectTasks, projectPath, PROJECT_CHECK_PROTOCOL } from "./rsi-project.js";
import type { ProjectTask, ProjectTaskPack } from "./rsi-project.js";
import { writeTrialRecord } from "./rsi-trial.js";

interface ReplayRecord {
  schemaVersion: 1;
  id: string;
  sourceTaskId: string;
  contractDigest: string;
  observedAt: string;
  source: { sessionId: string; requestId: string };
  task: ProjectTask;
  result: Awaited<ReturnType<typeof checkProject>>;
}

export function replayContract(task: ProjectTask): string {
  return improvementDigest({ verifierProtocol: PROJECT_CHECK_PROTOCOL, id: task.id, family: task.family, objective: task.objective, split: task.split,
    taskKinds: task.taskKinds ?? [], files: Object.keys(task.files).sort(), writable: task.writable, publicChecks: task.publicChecks, checks: task.checks });
}

function failedDeclaredCall(session: Session, requestId: string, workspace: string, task: ProjectTask): boolean {
  const events = session.snapshotEvents();
  const start = events.findIndex(event => event.type === "user/message" && event.data.id === requestId);
  if (start < 0) return false;
  const calls = new Set<string>();
  const files = new Set([...Object.keys(task.files), ...task.writable]);
  for (const event of events.slice(start + 1)) {
    if (event.type === "user/message" && event.data.source.kind === "user") break;
    if (event.type === "tool/call" || event.type === "tool/ptc-dispatch-start") {
      if (!["read", "write", "edit"].includes(event.data.name)) continue;
      let args: { file_path?: unknown };
      try { args = typeof event.data.arguments === "string" ? JSON.parse(event.data.arguments) : event.data.arguments; }
      catch { continue; }
      if (!args || typeof args.file_path !== "string") continue;
      const path = relative(resolve(workspace), resolve(workspace, args.file_path)).split(sep).join("/");
      if (files.has(path)) calls.add(String(event.type === "tool/call" ? event.data.callId : event.data.subCallId));
    }
    if (event.type === "tool/result" && event.data.message.isError && calls.has(String(event.data.message.toolCallId))) return true;
    if (event.type === "tool/ptc-dispatch" && event.data.isError && calls.has(String(event.data.subCallId))) return true;
  }
  return false;
}

/** Acceptance comes from existing declarations; only search tasks that really failed enter the replay library. */
export function failureReplay(task: ProjectTask, files: Record<string, string>, result: ReplayRecord["result"],
  source: ReplayRecord["source"]): ReplayRecord | undefined {
  if (task.split !== "search" || result.total !== task.checks.length || result.passed >= result.total) return undefined;
  if (result.results.length !== result.total || result.results.some((item, index) => item.id !== task.checks[index]!.id)
    || result.passed !== result.results.filter(item => item.passed).length) throw new Error("Failure record differs from its declared checks");
  const contractDigest = replayContract(task);
  const id = improvementDigest({ contractDigest, files, result }).slice(7);
  return { schemaVersion: 1, id, sourceTaskId: task.id, contractDigest, observedAt: new Date().toISOString(), source,
    task: { ...task, id: `${task.id.slice(0, 60)}-${id.slice(0, 16)}`, files, capture: false }, result };
}

async function declaredFiles(workspace: string, task: ProjectTask): Promise<Record<string, string>> {
  const root = await realpath(workspace);
  const files: Record<string, string> = {};
  let remaining = 512_000;
  for (const name of new Set([...Object.keys(task.files), ...task.writable])) {
    projectPath(name);
    let path: string;
    try { path = await realpath(join(root, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !Object.hasOwn(task.files, name)) continue;
      throw error;
    }
    if (relative(root, path).split(sep).includes("..")) throw new Error("Replay input escaped its declared project");
    const file = await open(path, "r");
    try {
      if (!(await file.stat()).isFile()) throw new Error("Replay inputs must be regular files");
      const buffer = Buffer.alloc(remaining + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      remaining -= length;
      if (remaining < 0) throw new Error("Replay snapshot exceeds its byte budget");
      files[name] = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    } finally { await file.close(); }
  }
  return files;
}

export class FailureReplays {
  private readonly pending = new WeakMap<Session, { requestId: string; workspace: string; samples: Array<{ task: ProjectTask; files: Record<string, string> }> }>();

  constructor(readonly root: string) {}

  private directory(workspace: string) { return join(this.root, improvementDigest(workspace).slice(7, 31)); }

  async begin(agent: Agent): Promise<void> {
    const prompt = latestHumanPrompt(agent.session); const workspace = agent.session.header.cwd;
    if (!prompt || !workspace || this.pending.get(agent.session)?.requestId === prompt.requestId) return;
    const capture = { requestId: prompt.requestId, workspace, samples: [] as Array<{ task: ProjectTask; files: Record<string, string> }> };
    this.pending.set(agent.session, capture);
    try { await realpath(join(workspace, ".agents/rsi/tasks.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const pack = await loadProjectTasks(workspace);
    const tasks = pack.tasks.filter(task => task.capture);
    if (tasks.length > 2) throw new Error("At most two declared replay contracts may capture a request");
    for (const task of tasks) capture.samples.push({ task, files: await declaredFiles(workspace, task) });
  }

  async finish(session: Session, signal?: AbortSignal): Promise<number> {
    const capture = this.pending.get(session);
    if (!capture) return 0;
    this.pending.delete(session);
    let saved = 0;
    for (const { task, files } of capture.samples) {
      signal?.throwIfAborted();
      const output = await declaredFiles(capture.workspace, task);
      if (Object.entries(files).some(([path, content]) => !task.writable.includes(path) && output[path] !== content)) continue;
      if (!task.writable.some(path => output[path] !== files[path]) && !failedDeclaredCall(session, capture.requestId, capture.workspace, task)) continue;
      const result = await checkProject(output, task.checks, signal);
      const record = failureReplay(task, files, result, { sessionId: String(session.id), requestId: capture.requestId });
      if (record && await this.save(capture.workspace, record)) saved++;
    }
    return saved;
  }

  async save(workspace: string, record: ReplayRecord): Promise<boolean> {
    const directory = this.directory(workspace); await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${record.id}.json`);
    try { await writeTrialRecord(path, record); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(path, "utf8")) as ReplayRecord;
      if (existing.id !== record.id || canonicalJson(existing.task) !== canonicalJson(record.task)
        || canonicalJson(existing.result) !== canonicalJson(record.result)) throw new Error("Replay identity conflicts with the archived record");
      return false;
    }
  }

  async apply(workspace: string, pack: ProjectTaskPack): Promise<ProjectTaskPack> {
    const directory = this.directory(workspace);
    let files: string[];
    try { files = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return pack; throw error; }
    const newest = new Map<string, ReplayRecord>();
    for (const name of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const record = JSON.parse(await readFile(join(directory, name), "utf8")) as ReplayRecord;
      if (record.schemaVersion !== 1 || !Number.isFinite(Date.parse(record.observedAt))
        || new Date(record.observedAt).toISOString() !== record.observedAt) throw new Error("Invalid replay record metadata");
      const task = pack.tasks.find(task => task.id === record.sourceTaskId && task.split === "search");
      if (!task || record.contractDigest !== replayContract(task)) continue;
      const expected = failureReplay(task, record.task.files, record.result, record.source);
      if (!expected || expected.id !== record.id || `${record.id}.json` !== name
        || canonicalJson(expected.task) !== canonicalJson(record.task)) throw new Error("Archived replay differs from its source contract");
      const previous = newest.get(task.id);
      if (!previous || record.observedAt > previous.observedAt) newest.set(task.id, record);
    }
    return { ...pack, tasks: pack.tasks.map(task => newest.get(task.id)?.task ?? task) };
  }
}
