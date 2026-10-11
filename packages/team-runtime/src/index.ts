/**
 * Team mode as a dsh plugin. Each project's team is driven by its current lead: the session
 * that leads it, in whichever process runs that session. Workers run as one-shot sub-agents
 * of the lead, so the terminal shows them under it. Other sessions read the team and append
 * to its log; the lead's engine acts on what they add. Nothing here calls a model.
 *
 * @module @chopin/team-runtime
 */

import { createHash } from "node:crypto";
import { access, mkdir, realpath, writeFile, watch } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import {
  acquireLease, findTeamRoot, holderAlive, leaseHolder, loadTeamConfig, takeOverLease, TeamEngine, TeamEventStore, teamEvent,
} from "@chopin/team";
import type { Lease, LeaseHolder, TaskProjection, TaskSpec, TeamConfig, TeamProjection } from "@chopin/team";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-loop";
import type {} from "@deepseek-ai/dsh-subagent";

import { ShellCommandPort } from "./commands.js";
import { DshWorkerPort } from "./worker.js";

export { roundSignals } from "./signals.js";
export type { CheckMeta, LoggedEvent, RoundSignals } from "./signals.js";
export { checkTool, leadOnlyGuard, reportTool } from "./tools.js";
export { DshWorkerPort } from "./worker.js";
export { runConfined, ShellCommandPort } from "./commands.js";
export { skillLoaded } from "./lead.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    chopinTeam: ChopinTeam;
  }
  interface Events {
    /** A task stopped and waits for a person; the host composition decides how to tell them. */
    "chopin-team/attention"(root: string, task: TaskProjection): void;
  }
}

export interface Config {
  /** Where team logs live, one directory per project. */
  dir: string;
  /** The agent preset every worker round runs under. */
  workerPreset: string;
  /** Further tools workers are refused, besides the team's own lead tools. Trailing `*` matches a prefix. */
  leadOnlyTools: string[];
  /** How long a worker's approval request waits for the person before it counts as refused. */
  approvalTimeoutSeconds: number;
}

export const Config: z<Config> = z.object({
  dir: z.string().required(),
  workerPreset: z.string().required(),
  leadOnlyTools: z.array(z.string()).default([]),
  approvalTimeoutSeconds: z.number().default(120),
});

/** The team's own tools for leads; workers never get them. */
export const LEAD_TOOLS = ["team_status", "team_take_over", "team_batch_*", "team_task_*"];

/** How a session stands towards a project's team. */
export type TeamRole = { kind: "lead" } | { kind: "watcher"; lead?: LeaseHolder };

export interface TeamProject {
  root: string;
  folder: string;
  config: TeamConfig;
  store: TeamEventStore;
  /** Set while this process drives the team. */
  engine?: TeamEngine;
  lease?: Lease;
  lead?: Agent;
  following?: AbortController;
}

const HOST = { kind: "host", id: "chopin-team" } as const;
const PROJECT_FILE = "project.json";
const LEASE_FILE = "engine.lease";
const LOG_FILE = "events.jsonl";
/** How long a lead that took over waits for the previous lead's rounds to settle. */
const HANDOVER_MS = 30_000;
const PROVIDER = "team";

/** A stable directory name for a project root: readable, and unique by the root's digest. */
function projectKey(root: string): string {
  const name = basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  return `${name}-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ChopinTeam extends Service {
  static inject = ["agents", "agentPresets", "agentDefaultModel", "shell", "sessionPersistence", "subagents"];

  private readonly projects = new Map<string, Promise<TeamProject>>();
  private readonly workers: DshWorkerPort;
  private readonly commands: ShellCommandPort;
  private closing = false;

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, "chopinTeam");
    this.workers = new DshWorkerPort(ctx, {
      provider: PROVIDER, preset: config.workerPreset, leadOnlyTools: [...LEAD_TOOLS, ...config.leadOnlyTools],
      approvalTimeoutMs: config.approvalTimeoutSeconds * 1_000,
    });
    this.commands = new ShellCommandPort(ctx);
  }

  async [Service.init](): Promise<void> {
    await mkdir(this.config.dir, { recursive: true });
    this.ctx.effect(() => this.ctx.subagents.registerProvider(this.workers.provider()));
    this.ctx.effect(() => () => this.closeAll());
  }

  /** The folder of the project at `root`, whether or not it has a team yet. */
  private folderOf(root: string): string {
    return join(this.config.dir, projectKey(root));
  }

  /** The root of the team that a session working in `cwd` belongs to, if that project has one. */
  async teamRootFor(cwd: string): Promise<string | undefined> {
    const root = await findTeamRoot(cwd);
    if (root === undefined) return undefined;
    const real = await realpath(root);
    try {
      await access(join(this.folderOf(real), LOG_FILE));
      return real;
    } catch {
      return undefined;
    }
  }

  /** The team of the project at `root`, loaded on first use; this alone drives nothing. */
  async open(root: string): Promise<TeamProject> {
    const real = await realpath(root);
    let project = this.projects.get(real);
    if (project === undefined) {
      project = this.load(real);
      this.projects.set(real, project);
      project.catch(() => this.projects.delete(real));
    }
    return project;
  }

  private async load(root: string): Promise<TeamProject> {
    const config = await loadTeamConfig(root);
    const temp = await realpath(tmpdir());
    for (const slot of config.slots) {
      const path = await realpath(slot.path).catch(() => slot.path);
      if (!relative(temp, path).startsWith("..")) {
        this.ctx.logger.warn(`team ${basename(root)}: slot ${slot.name} is in the temporary directory, which every worker sandbox may write; slots there are not isolated from each other`);
      }
    }
    const folder = this.folderOf(root);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, PROJECT_FILE), `${JSON.stringify({ root })}\n`);
    return { root, folder, config, store: new TeamEventStore(join(folder, LOG_FILE)) };
  }

  /**
   * Make `agent` the lead of the team at `root` when it may be: nobody leads it, or `takeOver`
   * is set because the person asked. Otherwise it watches.
   */
  async attach(root: string, agent: Agent, takeOver = false): Promise<TeamRole> {
    const project = await this.open(root);
    if (project.lead === agent) return { kind: "lead" };
    const sessionId = String(agent.session.id);
    const path = join(project.folder, LEASE_FILE);
    if (project.engine !== undefined) {
      // This process already drives the team: the lead changes sessions without stopping a round.
      if (project.lead !== undefined && !takeOver) return { kind: "watcher", ...(project.lease === undefined ? {} : { lead: project.lease.holder }) };
      project.lease = (await takeOverLease(path, sessionId)).lease;
      project.lead = agent;
      this.bindLead(project, agent);
      return { kind: "lead" };
    }
    let lease = await acquireLease(path, sessionId);
    if (lease === undefined) {
      const holder = await leaseHolder(path);
      if (!takeOver) return { kind: "watcher", ...(holder === undefined ? {} : { lead: holder }) };
      const taken = await takeOverLease(path, sessionId);
      lease = taken.lease;
      if (taken.previous !== undefined) await this.awaitHandover(project, taken.previous);
    }
    project.lease = lease;
    project.lead = agent;
    this.bindLead(project, agent);
    await this.drive(project);
    return { kind: "lead" };
  }

  /** Give the previous lead's process time to stop its rounds before this one recovers them. */
  private async awaitHandover(project: TeamProject, previous: LeaseHolder): Promise<void> {
    const deadline = Date.now() + HANDOVER_MS;
    while (Date.now() < deadline && holderAlive(previous)) {
      const running = Object.values((await project.store.fold()).tasks).some((task) => task.status === "running");
      if (!running) return;
      await delay(500);
    }
  }

  private bindLead(project: TeamProject, agent: Agent): void {
    agent.ctx.effect(() => () => {
      if (project.lead === agent) void this.stop(project, true);
    });
  }

  private async drive(project: TeamProject): Promise<void> {
    if (this.closing) return;
    const { root } = project;
    const label = basename(root);
    project.engine = new TeamEngine({
      config: project.config, store: project.store, commands: this.commands, hostId: HOST.id,
      worker: {
        runRound: (round) => {
          if (project.lead === undefined) throw new Error("no lead session to run a worker under");
          return this.workers.runRound(round, project.lead, `${label} · ${round.taskId} · round ${round.round}`);
        },
        salvage: (sessionId) => this.workers.salvage(sessionId),
      },
      onAttention: (task) => this.ctx.emit("chopin-team/attention", root, task),
      onError: (error) => this.ctx.logger.warn(`team ${label}: ${message(error)}`),
    });
    project.following = new AbortController();
    void this.followLease(project, project.following.signal);
    await project.engine.start();
  }

  /** Stop driving as soon as another process takes the lease over. */
  private async followLease(project: TeamProject, signal: AbortSignal): Promise<void> {
    try {
      for await (const change of watch(project.folder, { signal })) {
        if (change.filename !== LEASE_FILE || project.lease === undefined) continue;
        if (!(await project.lease.held())) {
          this.ctx.logger.info(`team ${basename(project.root)}: another session took over; this process stops driving it`);
          await this.stop(project, false);
          return;
        }
      }
    } catch (error) {
      if (!signal.aborted) this.ctx.logger.warn(`team ${basename(project.root)}: ${message(error)}`);
    }
  }

  /** Stop this process's engine: rounds save their work and pause. `release` hands the lease back. */
  private async stop(project: TeamProject, release: boolean): Promise<void> {
    const { engine, lease } = project;
    project.engine = undefined;
    project.lead = undefined;
    project.lease = undefined;
    project.following?.abort();
    project.following = undefined;
    await engine?.close();
    if (release) await lease?.release();
  }

  async projection(root: string): Promise<TeamProjection> {
    return (await this.open(root)).store.fold();
  }

  /** Who leads the team at `root`, as this process can tell. */
  async leadOf(root: string): Promise<LeaseHolder | undefined> {
    const project = await this.open(root);
    const holder = project.lease?.holder ?? await leaseHolder(join(project.folder, LEASE_FILE));
    return holder !== undefined && holderAlive(holder) ? holder : undefined;
  }

  /** Record a lead's batch; its acceptance tasks start at once, everything else waits for approval. */
  async propose(root: string, batchId: string, tasks: TaskSpec[], leadSession: string): Promise<void> {
    const project = await this.open(root);
    await project.store.append(teamEvent("batch.proposed", { kind: "master", id: leadSession }, { batchId, tasks, proposedBy: leadSession }));
    void project.engine?.pump();
  }

  /** Approve a batch on a person's recorded decision. */
  async approve(root: string, batchId: string, approvalAuditId: string): Promise<void> {
    const project = await this.open(root);
    await project.store.append(teamEvent("batch.approved", HOST, { batchId, approvalAuditId, decidedAt: new Date().toISOString() }));
    void project.engine?.pump();
  }

  /** Reject a batch, stopping any acceptance task still writing its checks; their work stays on their branches. */
  async reject(root: string, batchId: string, reason: string): Promise<void> {
    const project = await this.open(root);
    const taskIds = (await project.store.fold()).batches[batchId]?.taskIds ?? [];
    await this.assertStoppable(project, taskIds);
    for (const id of taskIds) await project.engine?.stopTask(id, "replanned", `batch rejected: ${reason}`);
    await project.store.append(teamEvent("batch.rejected", HOST, { batchId, reason }));
  }

  /** Relay a person's decision on a task that waits for one; the task goes back in the queue. */
  async decide(root: string, taskId: string, decision: string, leadSession: string): Promise<void> {
    const project = await this.open(root);
    await project.store.append(teamEvent("decision.recorded", { kind: "master", id: leadSession }, { taskId, decision, sessionId: leadSession }));
    void project.engine?.pump();
  }

  /** Record a person's confirmation of a landed task's manual stage, or of its acceptance when `stage` is omitted. */
  async accept(root: string, taskId: string, stage: string | undefined, evidence: string): Promise<void> {
    const project = await this.open(root);
    await project.store.append(stage === undefined
      ? teamEvent("task.accepted", HOST, { taskId })
      : teamEvent("task.stage-passed", HOST, { taskId, stage, evidence }));
    void project.engine?.pump(true);
  }

  /** Send landed work back on a person's finding; it waits for a decision on what to change. */
  async rework(root: string, taskId: string, reason: string): Promise<void> {
    const project = await this.open(root);
    await project.store.append(teamEvent("task.rework", HOST, { taskId, reason }));
  }

  /** Cancel a task; a running one is stopped first and its branch kept. */
  async cancel(root: string, taskId: string, reason: string, leadSession: string): Promise<void> {
    const project = await this.open(root);
    await this.assertStoppable(project, [taskId]);
    if (await project.engine?.stopTask(taskId, "cancelled", reason)) return;
    await project.store.append(teamEvent("task.cancelled", { kind: "master", id: leadSession }, { taskId, reason }));
  }

  /** Refuse to stop a task this process does not run, naming the session that leads the team. */
  private async assertStoppable(project: TeamProject, taskIds: readonly string[]): Promise<void> {
    if (project.engine !== undefined) return;
    const projection = await project.store.fold();
    const running = taskIds.filter((id) => projection.tasks[id]?.status === "running");
    if (running.length === 0) return;
    const lead = await this.leadOf(project.root);
    throw new Error(`${running.join(", ")} ${running.length === 1 ? "is" : "are"} running under the lead session ${lead?.sessionId ?? "unknown"}; stop it there, or take over the team first`);
  }

  private async closeAll(): Promise<void> {
    this.closing = true;
    const projects = await Promise.allSettled([...this.projects.values()]);
    await Promise.all(projects.flatMap((settled) => settled.status === "fulfilled" ? [this.stop(settled.value, true)] : []));
  }
}

// The cordis loader resolves Service-class plugins by default export; this one is the framework contract.
export default ChopinTeam;
