import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { localDaemon } from "@earendil-works/pi-env";
import { AgentService, launchToken, listen, type Listening } from "@chopin-ai/harness-pi";
import { DirectoryWorkspaceProvider } from "@chopin-ai/workspace";
import { agentSetup, webApp } from "./agent.js";
import { chopinHome, writeWhole } from "./home.js";
import { exclusive } from "./lock.js";
import { chopinModels } from "./credentials.js";
import { resolveModel, type ChooseModel } from "./model.js";
import { errorChain } from "@chopin-ai/harness-pi/protocol";

export interface Project {
  /** The service. */
  readonly url: URL;
  /** Its credential, which a client sends as a header. */
  readonly token: string;
  /** The page a browser opens; it carries the credential once, to trade it for a cookie. */
  readonly page: URL;
}

export interface DaemonOptions {
  /** How long the service stays up with no client connected and nothing left to do. */
  idleMs?: number;
  /** Ends the service early. */
  signal?: AbortSignal;
  /** Ends the service once its agent has nothing left to do, clients or not, so a newer build can take over. */
  retire?: AbortSignal;
  /** The build the service records; this one's by default. */
  build?: string;
}

interface ServiceRecord {
  pid: number;
  url: string;
  token: string;
  /** The build of chopin serving; absent in a record written before builds were recorded. */
  build?: string;
}

/** The signal that asks a project's service to hand over once its agent has nothing left to do. */
export const HAND_OVER = "SIGUSR2";

interface Paths {
  /** The chopin home these paths are under, which the daemon must use too. */
  home: string;
  root: string;
  record: string;
  lock: string;
  log: string;
  data: string;
}

/** The built entry, which runs the daemon; the same file whether this module runs from the sources or the build. */
const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const IDLE_MS = 5 * 60_000;
const LEAVE_GRACE_MS = 10_000;

/**
 * The service of the project in `directory`, started in the background when none runs. It belongs to no terminal:
 * every terminal, browser and editor of the project joins it, and it ends on its own once idle.
 */
export async function openProject(directory: string, choose: ChooseModel): Promise<Project> {
  const paths = await projectPaths(directory);
  const running = await current(paths);
  const ours = await buildId();
  if (running !== undefined && running.build === ours) return joined(running);
  // Only a later build takes over, so two installs used on one project never take turns pushing each other out.
  if (running?.build !== undefined && laterBuild(running.build, ours)) {
    throw new Error(`the service of ${paths.root} runs a later chopin; use that one, or update this one`);
  }
  if (running !== undefined) await handOver(paths, running);
  await resolveModel(await chopinModels(), choose);
  const logged = (await stat(paths.log).catch(() => undefined))?.size ?? 0;
  let daemon = await spawnDaemon(paths);
  for (let wait = 0; wait < 300; wait++) {
    const record = await current(paths);
    if (daemon.failure !== undefined) throw new Error(`the service of ${paths.root} could not be started: ${daemon.failure.message}`);
    const exited = daemon.child.exitCode !== null || daemon.child.signalCode !== null;
    if (exited && daemon.child.exitCode !== 0) {
      const log = (await readFile(paths.log)).subarray(logged).toString("utf8").trim();
      throw new Error(`the service of ${paths.root} failed to start:\n${log}`);
    }
    // Joined once this daemon is the service or has left, so none starts serving later unseen.
    if (record !== undefined && (record.pid === daemon.child.pid || exited)) return joined(record);
    // It left because another held the lock; should that one let go with no service to show, start again.
    if (exited && record === undefined && lockFree(paths)) daemon = await spawnDaemon(paths);
    await sleep(100);
  }
  throw new Error(`the service of ${paths.root} did not start; see ${paths.log}`);
}

/**
 * Finds the project's running service again, for a client to dial. A service that ended is started anew by the next
 * `chopin`, on another port with another credential, and a client still attached follows it there.
 */
export function findProject(directory: string): () => Promise<{ url: URL; token: string }> {
  let paths: Promise<Paths> | undefined;
  return async () => {
    paths ??= projectPaths(directory).catch((error: unknown) => {
      paths = undefined;
      throw error;
    });
    const running = await current(await paths);
    if (running === undefined) throw new Error("no service runs for this project");
    return joined(running);
  };
}

/**
 * Serves the project in `directory` until it is idle: no client connected and no work left. An OS lock, released
 * however its holder ends, admits one service per project; another daemon of the same project returns at once.
 */
export async function runDaemon(directory: string, options: DaemonOptions = {}): Promise<void> {
  const paths = await projectPaths(directory);
  const lock = exclusive(paths.lock);
  if (lock === undefined) return;
  try {
    // Left by a service that died, the record and any draft of it; only the lock holder may write or remove them.
    await rm(paths.record, { force: true });
    const home = dirname(paths.record);
    for (const name of await readdir(home)) if (name.startsWith(`${basename(paths.record)}.`)) await rm(join(home, name), { force: true });
    const service = await agentService(paths);
    try {
      const token = randomBytes(32).toString("base64url");
      const server = await listen(service, { authenticate: launchToken(token), web: webApp() });
      try {
        await writeRecord(paths.record, { pid: process.pid, url: `ws://127.0.0.1:${server.port}/`, token, build: options.build ?? await buildId() });
        for (;;) {
          await untilIdle(server, service, options.idleMs ?? IDLE_MS, options.signal, options.retire);
          if (options.retire?.aborted === true) break;
          // A chopin on its way, a browser slowest of all, still finds the service while it lingers.
          const leaving = Date.now();
          const grace = Math.min(LEAVE_GRACE_MS, options.idleMs ?? IDLE_MS);
          await sleep(grace, undefined, options.signal && { signal: options.signal }).catch(() => {});
          if ((server.clients === 0 && server.reachedAt < leaving) || options.signal?.aborted === true) break;
        }
      } finally {
        await rm(paths.record, { force: true });
        await server.close();
      }
    } finally {
      await service.close(BACKGROUND_CONTEXT);
    }
  } finally {
    lock.close();
  }
}

async function agentService(paths: Paths): Promise<AgentService> {
  return new AgentService({
    ...await agentSetup(),
    dataDir: paths.data,
    workspaces: new DirectoryWorkspaceProvider(paths.root),
    daemon: localDaemon(),
    report: (error) => console.error(`chopin: ${errorChain(error)}`),
  });
}

async function untilIdle(server: Listening, service: AgentService, idleMs: number, signal?: AbortSignal, retire?: AbortSignal): Promise<void> {
  let since = Date.now();
  const woken = signal === undefined ? retire : retire === undefined ? signal : AbortSignal.any([signal, retire]);
  const retiring = () => retire?.aborted === true;
  while (signal?.aborted !== true) {
    // Asked to hand over, the service waits only for its agent's work.
    if (retiring()) {
      if ((await service.working()).length === 0) return;
      await sleep(500, undefined, signal && { signal }).catch(() => {});
      continue;
    }
    await sleep(Math.min(idleMs, 5_000), undefined, woken && { signal: woken }).catch(() => {});
    if (retiring()) continue;
    if (server.clients > 0 || (await service.working()).length > 0) since = Date.now();
    else if (Date.now() - Math.max(since, server.reachedAt) >= idleMs) return;
  }
}

/**
 * Asks a service started by another build to hand over once its agent has finished the work in hand, and waits for
 * it to let go of the project. A service of a build that predates the request ends at it all the same.
 */
async function handOver(paths: Paths, running: ServiceRecord): Promise<void> {
  process.stderr.write("chopin: the project's service was started by another build of chopin; it hands over once its agent has finished the work in hand\n");
  try {
    process.kill(running.pid, HAND_OVER);
  } catch (error) {
    // One already gone has nothing to hand over; one that cannot take the request ends instead.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") process.kill(running.pid, "SIGTERM");
  }
  while ((await current(paths)) !== undefined || !lockFree(paths)) await sleep(100);
}

let build: Promise<string> | undefined;

/**
 * This build of chopin, so a service an earlier build started is told apart: its packages' versions, which tell
 * releases apart, as an install gives every file the same time, and when their code last changed, which tells builds
 * of one version apart.
 */
function buildId(): Promise<string> {
  build ??= (async () => {
    const roots = [dirname(BIN), ...["@chopin-ai/core", "@chopin-ai/workspace", "@chopin-ai/harness-pi"].map((name) => dirname(fileURLToPath(import.meta.resolve(name))))];
    const versions: string[] = [];
    let newest = 0;
    for (const root of roots) {
      versions.push((JSON.parse(await readFile(join(root, "..", "package.json"), "utf8")) as { version: string }).version);
      for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".js")) newest = Math.max(newest, (await stat(join(entry.parentPath, entry.name))).mtimeMs);
      }
    }
    return `${versions.join(",")}:${Math.round(newest)}`;
  })();
  return build;
}

/** Whether build `a` is later than `b`: by its packages' versions, then by when its code last changed. */
export function laterBuild(a: string, b: string): boolean {
  const order = (build: string) => {
    const [versions = "", changed = "0"] = build.split(":");
    return [...versions.split(",").flatMap((version) => (version.split("-")[0] ?? "").split(".").map(Number)), Number(changed)];
  };
  const [left, right] = [order(a), order(b)];
  const at = left.findIndex((part, index) => part !== right[index]);
  return at !== -1 && (left[at] ?? 0) > (right[at] ?? 0);
}

/** A daemon being started, and why it could not be, once that is known. */
interface Daemon {
  readonly child: ChildProcess;
  failure?: Error;
}

/** The daemon outlives this process, which never waits for it: detached from its terminal, appending to the log. */
async function spawnDaemon(paths: Paths): Promise<Daemon> {
  const log = await open(paths.log, "a");
  try {
    const child = spawn(process.execPath, [BIN, "daemon", paths.root], {
      cwd: paths.root,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      // The model is read from this home when each conversation starts, so a model chosen later reaches the service.
      env: { ...process.env, CHOPIN_HOME: paths.home },
    });
    child.unref();
    const daemon: Daemon = { child };
    child.on("error", (error) => void (daemon.failure = error));
    return daemon;
  } finally {
    await log.close();
  }
}

async function projectPaths(directory: string): Promise<Paths> {
  const root = await realpath(directory);
  const chopin = chopinHome();
  const home = join(chopin, "projects", createHash("sha256").update(root).digest("hex").slice(0, 16));
  // The project's store and log hold its conversations; nobody else on the machine reads them.
  await mkdir(home, { recursive: true });
  await chmod(home, 0o700);
  const at = (name: string) => join(home, name);
  return { home: chopin, root, record: at("service.json"), lock: at("service.lock"), log: at("service.log"), data: at("data") };
}

/**
 * The running service's record. The lock is the authority: a record nobody holds the lock for is left over, and one
 * that cannot be read is none.
 */
async function current(paths: Paths): Promise<ServiceRecord | undefined> {
  const record = await readFile(paths.record, "utf8").then((text) => JSON.parse(text) as ServiceRecord | null).catch(() => undefined);
  const whole = Number.isInteger(record?.pid) && (record?.pid ?? 0) > 0 && typeof record?.url === "string"
    && /^wss?:$/.test(URL.parse(record.url)?.protocol ?? "") && typeof record.token === "string" && record.token !== "";
  return whole && alive(record.pid) && !lockFree(paths) ? record : undefined;
}

function lockFree(paths: Paths): boolean {
  const free = exclusive(paths.lock, 0);
  free?.close();
  return free !== undefined;
}

async function writeRecord(file: string, record: ServiceRecord): Promise<void> {
  await writeWhole(file, JSON.stringify(record), 0o600);
}

function joined(record: ServiceRecord): Project {
  const page = new URL(record.url.replace(/^ws/, "http"));
  page.searchParams.set("token", record.token);
  return { url: new URL(record.url), token: record.token, page };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
