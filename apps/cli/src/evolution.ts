import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { EvolutionEventStore } from "@chopin/evolution";
import type { EvolutionProjection } from "@chopin/evolution";
import type {} from "@chopin/evolution-runtime";
import type { boot } from "@deepseek-ai/dsh-app-boot";

export interface ReconcileResult {
  generation: string;
  completedRequestIds: string[];
  failedRequestIds: string[];
}

export interface SupervisionResult {
  generation: string;
  exitCode: number;
}

export interface EvolutionSupervisorInput {
  eventsFile: string;
  mainScript: string;
  configPath: string;
  pollIntervalMs?: number;
  debounceMs?: number;
  retryDelayMs?: number;
  claimStaleMs?: number;
  runGeneration?: (generation: string, signal: AbortSignal) => Promise<number>;
  onError?: (error: Error) => void;
}

export interface EvolutionSupervisorHandle {
  scanNow(): Promise<SupervisionResult[]>;
  stop(): Promise<void>;
}

interface ClaimOwner {
  pid: number;
  generation: string;
  nonce: string;
  createdAt: string;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const DEFAULT_CLAIM_STALE_MS = 5 * 60_000;

function stableGeneration(value: string): string {
  const generation = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(generation)) throw new Error(`invalid process generation ${value}`);
  return generation;
}

function positiveInterval(value: number | undefined, fallback: number, name: string, allowZero = false): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
  return resolved;
}

function eventsPath(): string {
  return process.env.CHOPIN_EVOLUTION_EVENTS
    ?? join(homedir(), ".chopin", "evolution", "events.jsonl");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function restoreEnvironment(key: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

async function withEvolutionRuntime<T>(
  configPath: string,
  generation: string,
  loadCode: boolean,
  operation: (ctx: Awaited<ReturnType<typeof boot>>) => Promise<T>,
): Promise<T> {
  const { boot, resolveConfigPath } = await import("@deepseek-ai/dsh-app-boot");
  const previousGeneration = process.env.CHOPIN_PROCESS_GENERATION;
  const previousLoadCode = process.env.CHOPIN_EVOLUTION_LOAD_CODE;
  process.env.CHOPIN_PROCESS_GENERATION = generation;
  process.env.CHOPIN_EVOLUTION_LOAD_CODE = loadCode ? "1" : "0";
  let ctx: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    ctx = await boot(
      `chopin-evolution-reconcile-${loadCode ? "code" : "controller"}-${randomUUID()}`,
      resolveConfigPath(configPath, undefined),
    );
    return await operation(ctx);
  } finally {
    try {
      if (ctx !== undefined) await ctx.fiber.dispose();
    } finally {
      restoreEnvironment("CHOPIN_PROCESS_GENERATION", previousGeneration);
      restoreEnvironment("CHOPIN_EVOLUTION_LOAD_CODE", previousLoadCode);
    }
  }
}

async function reconcileControllerGeneration(
  ctx: Awaited<ReturnType<typeof boot>>,
  generation: string,
): Promise<void> {
  const projection = await ctx.chopinEvolution.events.fold();
  for (const artifact of projection.artifacts) {
    for (const request of artifact.deploymentRequests) {
      if (request.targetGeneration !== generation) continue;
      if (artifact.deploymentReceipts.some((receipt) => receipt.operationId === request.requestId)) continue;
      if (request.mode !== "disabled") {
        const targetId = request.mode === "rollback" ? request.rollbackTarget?.artifactId : artifact.id;
        const target = projection.artifacts.find((candidate) => candidate.id === targetId);
        if (target !== undefined && target.manifest.runtime !== "mcp") continue;
        await ctx.chopinEvolution.completeDeploymentRequest(
          request.requestId,
          "fail",
          request.rollbackTarget?.surfaceDigest ?? artifact.surfaceDigest,
          target === undefined ? `deployment target ${targetId ?? "missing"} not found` : "MCP capability loading is not implemented",
        );
        continue;
      }
      try {
        const staged = await ctx.chopinEvolution.artifacts.inspect(artifact.contentDigest);
        await ctx.chopinEvolution.completeDeploymentRequest(
          request.requestId,
          "pass",
          staged.surfaceDigest,
          "content-addressed artifact recovered as installed-disabled without loading candidate code",
        );
      } catch (error) {
        await ctx.chopinEvolution.completeDeploymentRequest(
          request.requestId,
          "fail",
          artifact.surfaceDigest,
          (error as Error).message,
        );
      }
    }
  }
  await ctx.chopinEvolution.reconcileDataGeneration();
}

function pendingCodeGeneration(eventsFile: string, generation: string): Promise<boolean> {
  return new EvolutionEventStore(eventsFile).fold().then((projection) => projection.artifacts.some((artifact) =>
    artifact.deploymentRequests.some((request) => {
      if (request.targetGeneration !== generation) return false;
      if (artifact.deploymentReceipts.some((receipt) => receipt.operationId === request.requestId)) return false;
      const targetId = request.mode === "rollback" ? request.rollbackTarget?.artifactId : artifact.id;
      return projection.artifacts.find((candidate) => candidate.id === targetId)?.manifest.runtime === "dsh-plugin";
    })));
}

export async function reconcileEvolutionGeneration(configPath: string, generationInput: string): Promise<ReconcileResult> {
  const generation = stableGeneration(generationInput);
  const file = eventsPath();
  const before = await new EvolutionEventStore(file).fold();
  const requests = before.artifacts.flatMap((artifact) => artifact.deploymentRequests
    .filter((request) => request.targetGeneration === generation)
    .map((request) => ({ artifactId: artifact.id, requestId: request.requestId })));
  if (requests.length === 0) throw new Error(`generation ${generation} has no deployment request`);

  // The first phase never mounts the adapter: disabled only checks content addresses, and
  // data capabilities are folded by the controller alone.
  await withEvolutionRuntime(configPath, generation, false, async (ctx) => reconcileControllerGeneration(ctx, generation));

  // Only requests still pending and explicitly declaring the dsh-plugin runtime enter the new-process code loading phase.
  if (await pendingCodeGeneration(file, generation)) {
    await withEvolutionRuntime(configPath, generation, true, async () => undefined);
  }

  // Request active as soon as the canary is written: the supervisor keeps scanning for the
  // next generation itself instead of waiting for a session to pass by.
  await withEvolutionRuntime(configPath, `${generation}-advance`, false, async (ctx) => {
    await ctx.chopinEvolution.advance();
  });

  const after = await new EvolutionEventStore(file).fold();
  const completedRequestIds: string[] = [];
  const failedRequestIds: string[] = [];
  for (const { artifactId, requestId } of requests) {
    const artifact = after.artifacts.find((item) => item.id === artifactId);
    const receipt = artifact?.deploymentReceipts.find((item) => item.operationId === requestId);
    if (receipt?.health === "pass") completedRequestIds.push(requestId);
    else failedRequestIds.push(requestId);
  }
  return { generation, completedRequestIds, failedRequestIds };
}

export async function runEvolutionReconcileProcess(input: {
  generation: string;
  mainScript: string;
  configPath: string;
  signal?: AbortSignal;
}): Promise<number> {
  const generation = stableGeneration(input.generation);
  if (input.signal?.aborted === true) return 1;
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [input.mainScript, "evolution-reconcile", generation, "--config", input.configPath], {
      // Reconciler output is daemon log detail; it must not mix into the TUI or web interactive output.
      stdio: "ignore",
      env: { ...process.env, CHOPIN_PROCESS_GENERATION: generation },
    });
    let escalation: NodeJS.Timeout | undefined;
    let settled = false;
    const cleanup = () => {
      if (escalation !== undefined) clearTimeout(escalation);
      input.signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 5_000);
      escalation.unref();
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(signal === null ? code ?? 1 : 1);
    });
  });
}

function claimPath(eventsFile: string, generation: string): string {
  const hash = createHash("sha256").update(generation).digest("hex");
  return `${eventsFile}.generation-${hash}.claim`;
}

async function removeAbandonedClaim(path: string, staleMs: number): Promise<boolean> {
  let owner: Partial<ClaimOwner> | undefined;
  try {
    owner = JSON.parse(await readFile(path, "utf8")) as Partial<ClaimOwner>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
  }
  if (typeof owner?.pid === "number") {
    if (processIsAlive(owner.pid)) return false;
  } else {
    try {
      const info = await stat(path);
      if (Date.now() - info.mtimeMs < staleMs) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function acquireGenerationClaim(
  eventsFile: string,
  generation: string,
  staleMs: number,
): Promise<(() => Promise<void>) | undefined> {
  const path = claimPath(eventsFile, generation);
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      const owner: ClaimOwner = { pid: process.pid, generation, nonce: randomUUID(), createdAt: new Date().toISOString() };
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
      return async () => {
        await handle.close();
        try {
          const current = JSON.parse(await readFile(path, "utf8")) as Partial<ClaimOwner>;
          if (current.nonce === owner.nonce) await unlink(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await removeAbandonedClaim(path, staleMs))) return undefined;
    }
  }
  return undefined;
}

function unresolvedGenerations(projection: EvolutionProjection): string[] {
  return [...new Set(projection.artifacts.flatMap((artifact) => artifact.deploymentRequests
    .filter((request) => !artifact.deploymentReceipts.some((receipt) => receipt.operationId === request.requestId))
    .map((request) => request.targetGeneration)))].sort();
}

class EvolutionSupervisor implements EvolutionSupervisorHandle {
  private readonly store: EvolutionEventStore;
  private pendingRevision?: string;
  private pendingGenerations: string[] = [];
  private readonly pollIntervalMs: number;
  private readonly debounceMs: number;
  private readonly retryDelayMs: number;
  private readonly claimStaleMs: number;
  private readonly abort = new AbortController();
  private readonly retryAfter = new Map<string, number>();
  private watcher?: ReturnType<typeof watch>;
  private pollTimer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;
  private currentScan?: Promise<SupervisionResult[]>;
  private rescanRequested = false;
  private stopped = false;

  constructor(private readonly input: EvolutionSupervisorInput) {
    this.store = new EvolutionEventStore(input.eventsFile);
    this.pollIntervalMs = positiveInterval(input.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs");
    this.debounceMs = positiveInterval(input.debounceMs, DEFAULT_DEBOUNCE_MS, "debounceMs", true);
    this.retryDelayMs = positiveInterval(input.retryDelayMs, DEFAULT_RETRY_DELAY_MS, "retryDelayMs");
    this.claimStaleMs = positiveInterval(input.claimStaleMs, DEFAULT_CLAIM_STALE_MS, "claimStaleMs");
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.input.eventsFile), { recursive: true });
    try {
      this.watcher = watch(dirname(this.input.eventsFile), (_event, filename) => {
        if (filename === null || filename.toString() === basename(this.input.eventsFile)) this.scheduleScan();
      });
      this.watcher.on("error", (error) => this.report(error));
    } catch (error) {
      // Some filesystems do not support watch; polling remains the complete recovery path.
      this.report(error as Error);
    }
    this.pollTimer = setInterval(() => this.scheduleScan(), this.pollIntervalMs);
    this.scheduleScan(0);
  }

  scanNow(): Promise<SupervisionResult[]> {
    if (this.stopped) return Promise.resolve([]);
    if (this.currentScan !== undefined) {
      this.rescanRequested = true;
      return this.currentScan;
    }
    this.currentScan = this.scanLoop().finally(() => {
      this.currentScan = undefined;
    });
    return this.currentScan;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.watcher?.close();
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.abort.abort();
    await this.currentScan?.catch(() => undefined);
  }

  private scheduleScan(delay = this.debounceMs): void {
    if (this.stopped) return;
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.scanNow().catch((error) => this.report(error as Error));
    }, delay);
  }

  private async scanLoop(): Promise<SupervisionResult[]> {
    const results: SupervisionResult[] = [];
    do {
      this.rescanRequested = false;
      results.push(...await this.scanPass());
    } while (this.rescanRequested && !this.stopped);
    return results;
  }

  private async scanPass(): Promise<SupervisionResult[]> {
    const results: SupervisionResult[] = [];
    for (const generation of await this.pending()) {
      if (this.stopped) break;
      if ((this.retryAfter.get(generation) ?? 0) > Date.now()) continue;
      const release = await acquireGenerationClaim(this.input.eventsFile, generation, this.claimStaleMs);
      if (release === undefined) continue;
      try {
        // Another supervisor may have finished between the listing and the claim; re-read after claiming.
        if (!(await this.pending()).includes(generation)) continue;
        let exitCode: number;
        try {
          exitCode = await (this.input.runGeneration?.(generation, this.abort.signal)
            ?? runEvolutionReconcileProcess({
              generation,
              mainScript: this.input.mainScript,
              configPath: this.input.configPath,
              signal: this.abort.signal,
            }));
        } catch (error) {
          exitCode = 1;
          this.report(error as Error);
        }
        results.push({ generation, exitCode });
        if (exitCode === 0) this.retryAfter.delete(generation);
        else this.retryAfter.set(generation, Date.now() + this.retryDelayMs);
      } finally {
        await release();
      }
    }
    return results;
  }

  private report(error: Error): void {
    this.input.onError?.(error);
  }

  private async pending(): Promise<string[]> {
    const snapshot = await this.store.snapshot();
    if (snapshot.revision !== this.pendingRevision) {
      this.pendingGenerations = unresolvedGenerations(snapshot.projection);
      this.pendingRevision = snapshot.revision;
    }
    return this.pendingGenerations;
  }
}

export async function startEvolutionSupervisor(input: EvolutionSupervisorInput): Promise<EvolutionSupervisorHandle> {
  const supervisor = new EvolutionSupervisor(input);
  await supervisor.start();
  return supervisor;
}

/** Run one scan; kept for the CLI's `--once` and diagnostic scripts. */
export async function superviseEvolution(input: EvolutionSupervisorInput): Promise<SupervisionResult[]> {
  const supervisor = new EvolutionSupervisor(input);
  try {
    return await supervisor.scanNow();
  } finally {
    await supervisor.stop();
  }
}
