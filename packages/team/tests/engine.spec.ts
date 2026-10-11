import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { parseTeamConfig } from "../src/config.js";
import { TeamEngine } from "../src/engine.js";
import type { CommandPort, WorkerOutcome, WorkerPort, WorkerRound } from "../src/engine.js";
import { teamEvent } from "../src/events.js";
import { treeDigest } from "../src/git.js";
import { leadBrief } from "../src/status.js";
import { TeamEventStore } from "../src/store.js";
import type { RoundReport, TaskSpec } from "../src/types.js";

const run = promisify(execFile);
const HOST = { kind: "host", id: "orchestrator" } as const;
const MASTER = { kind: "master", id: "master-session" } as const;
const COMPLETE: RoundReport = { status: "complete", summary: "done", evidence: ["checked"], nextSteps: [] };
const directories: string[] = [];
const engines: TeamEngine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd })).stdout.trim();
}

async function write(root: string, path: string, content: string): Promise<void> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}

/** A bare remote, the project checkout, three slots and a team log. */
async function project(fullCheck: unknown = { where: "ci" }, delivery = "push") {
  const root = await mkdtemp(join(tmpdir(), "team-engine-"));
  directories.push(root);
  const remote = join(root, "remote.git");
  await run("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  const main = join(root, "project");
  await run("git", ["clone", "--quiet", remote, main]);
  await git(main, "config", "user.name", "Team Test");
  await git(main, "config", "user.email", "team@example.com");
  await write(main, "src/shared.txt", "base\n");
  await git(main, "add", ".");
  await git(main, "commit", "--quiet", "-m", "base");
  await git(main, "push", "--quiet", "origin", "HEAD:main");
  const slots = ["slot-1", "slot-2", "slot-3"].map((name) => ({ name, path: join(root, name) }));
  for (const slot of slots) await git(main, "worktree", "add", "--quiet", "--detach", slot.path, "origin/main");
  const config = parseTeamConfig({
    slots, checks: [{ paths: ["src/**", "tests/**"], run: "check-src" }], fullCheck, delivery, pollSeconds: 3600,
  }, main);
  return { main, remote, config, store: new TeamEventStore(join(root, "team.jsonl")) };
}

type Script = (round: WorkerRound) => Promise<Partial<WorkerOutcome>>;

/** A worker whose behaviour per task is a script; it records every brief it was given. */
function worker(scripts: Record<string, Script>) {
  const briefs: Record<string, string[]> = {};
  const port: WorkerPort = {
    async runRound(round) {
      (briefs[round.taskId] ??= []).push(round.prompt);
      const outcome = await scripts[round.taskId]!(round);
      return { usage: { requests: 1, inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 }, exhausted: false, deniedApprovals: [], ...outcome };
    },
    async salvage() {
      return { usage: { requests: 3, inputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 30 } };
    },
  };
  return { port, briefs };
}

/** The checks a worker would have run itself, on exactly the tree it leaves. */
async function checked(cwd: string): Promise<Partial<WorkerOutcome>> {
  return { report: COMPLETE, passingCheck: { tree: await treeDigest(cwd), commands: ["check-src"] } };
}

const shell: CommandPort = {
  async run(command, options) {
    try {
      const { stdout, stderr } = await run("sh", ["-c", command], { cwd: options.cwd, signal: options.signal });
      return { exitCode: 0, output: stdout + stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { exitCode: typeof failure.code === "number" ? failure.code : 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  },
};

function spec(id: string, overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id, kind: "change", objective: `do ${id}`, ...(overrides.kind === undefined || overrides.kind === "change" ? { commitMessage: `feat: ${id}` } : {}),
    writeScope: [`src/${id}/**`], dependsOn: [], acceptance: { criteria: `${id} works`, examples: [] },
    maxRequests: 10, maxRounds: 3, stages: [], manualAcceptance: true, ...overrides,
  };
}

async function propose(store: TeamEventStore, tasks: TaskSpec[], approve = true): Promise<void> {
  await store.append(teamEvent("batch.proposed", MASTER, { batchId: "b1", tasks, proposedBy: "master-session" }));
  if (approve) await store.append(teamEvent("batch.approved", HOST, { batchId: "b1", approvalAuditId: "audit", decidedAt: new Date().toISOString() }));
}

async function engine(setup: Awaited<ReturnType<typeof project>>, port: WorkerPort, commands: CommandPort = shell) {
  const errors: unknown[] = [];
  const instance = new TeamEngine({ config: setup.config, store: setup.store, worker: port, commands, hostId: "orchestrator", onError: (error) => errors.push(error) });
  engines.push(instance);
  await instance.start();
  await instance.settled();
  return { instance, errors };
}

describe("team engine", () => {
  it("runs rounds until complete, then squashes and pushes the work onto the trunk", async () => {
    const setup = await project();
    await propose(setup.store, [spec("alpha")]);
    const { port, briefs } = worker({
      alpha: async (round) => {
        await write(round.cwd, `src/alpha/step-${round.round}.txt`, `${round.round}\n`);
        return round.round === 1 ? { report: { status: "continue", summary: "half way", evidence: [], nextSteps: ["finish step 2"] } } : checked(round.cwd);
      },
    });
    const { errors } = await engine(setup, port);
    expect(errors).toEqual([]);
    const task = (await setup.store.fold()).tasks.alpha!;
    expect(task).toMatchObject({ status: "landed", rounds: 2, usage: { requests: 2 } });
    expect(briefs.alpha![1]).toContain("finish step 2");
    expect(await git(setup.main, "log", "-1", "--format=%s", "origin/main")).toBe("feat: alpha");
    expect(await git(setup.main, "show", "--name-only", "--format=", "origin/main")).toBe("src/alpha/step-1.txt\nsrc/alpha/step-2.txt");
  });

  it("writes acceptance checks before approval and delivers them with the change they gate, untouched", async () => {
    const setup = await project();
    const author = spec("author", { kind: "acceptance", writeScope: ["tests/**"], manualAcceptance: false });
    await propose(setup.store, [author, spec("alpha", { manualAcceptance: false }), spec("beta", { manualAcceptance: false })], false);
    const { port } = worker({
      author: async (round) => {
        await write(round.cwd, "tests/alpha.check", "expect alpha\n");
        await write(round.cwd, "tests/beta.check", "expect beta\n");
        return { report: { ...COMPLETE, checks: [{ forTaskId: "alpha", path: "tests/alpha.check" }, { forTaskId: "beta", path: "tests/beta.check" }] } };
      },
      alpha: async (round) => {
        expect(await readFile(join(round.cwd, "tests/alpha.check"), "utf8")).toBe("expect alpha\n");
        await write(round.cwd, "src/alpha/impl.txt", "alpha\n");
        return checked(round.cwd);
      },
      beta: async (round) => {
        await write(round.cwd, "tests/beta.check", "expect nothing\n");
        await write(round.cwd, "src/beta/impl.txt", "beta\n");
        return checked(round.cwd);
      },
    });
    const { instance, errors } = await engine(setup, port);
    expect((await setup.store.fold()).tasks.author?.status).toBe("done");
    expect((await setup.store.fold()).tasks.alpha?.status).toBe("proposed");
    await setup.store.append(teamEvent("batch.approved", HOST, { batchId: "b1", approvalAuditId: "audit", decidedAt: new Date().toISOString() }));
    await instance.pump();
    await instance.settled();
    expect(errors).toEqual([]);
    const projection = await setup.store.fold();
    expect(projection.tasks.alpha?.status).toBe("done");
    expect(await git(setup.main, "show", "--name-only", "--format=", "origin/main")).toBe("src/alpha/impl.txt\ntests/alpha.check");
    expect(projection.tasks.beta).toMatchObject({ status: "attention", attention: { reason: "write-scope", detail: expect.stringContaining("tests/beta.check") } });
  });

  it("holds work outside the write scope for a person, then resumes it from its branch in another slot", async () => {
    const setup = await project();
    await propose(setup.store, [spec("alpha")]);
    let attempts = 0;
    const { port, briefs } = worker({
      alpha: async (round) => {
        attempts += 1;
        if (attempts === 1) {
          await write(round.cwd, "src/alpha/impl.txt", "alpha\n");
          await write(round.cwd, "src/shared.txt", "changed\n");
          return checked(round.cwd);
        }
        expect(await readFile(join(round.cwd, "src/alpha/impl.txt"), "utf8")).toBe("alpha\n");
        await run("git", ["checkout", "origin/main", "--", "src/shared.txt"], { cwd: round.cwd });
        return checked(round.cwd);
      },
    });
    const { instance } = await engine(setup, port);
    const paused = (await setup.store.fold()).tasks.alpha!;
    expect(paused).toMatchObject({ status: "attention", attention: { reason: "write-scope", detail: expect.stringContaining("src/shared.txt") } });
    expect(paused.attention?.savedCommit).toBeDefined();
    await setup.store.append(teamEvent("decision.recorded", MASTER, { taskId: "alpha", decision: "leave src/shared.txt alone", sessionId: "master-session" }));
    await instance.pump();
    await instance.settled();
    const resumed = (await setup.store.fold()).tasks.alpha!;
    expect(resumed).toMatchObject({ status: "landed", attemptIds: ["alpha-a1", "alpha-a2"] });
    expect(briefs.alpha![1]).toContain("leave src/shared.txt alone");
  });

  it("closes out a round a dead host left open, counts what it spent and finishes the task", async () => {
    const setup = await project();
    await propose(setup.store, [spec("alpha")]);
    const hang = worker({ alpha: async (round) => {
      await write(round.cwd, "src/alpha/impl.txt", "alpha\n");
      return new Promise(() => undefined);
    } });
    const dead = new TeamEngine({ config: setup.config, store: setup.store, worker: hang.port, commands: shell, hostId: "orchestrator" });
    void dead.start();
    await expect.poll(async () => (await setup.store.fold()).tasks.alpha?.attempt?.round, { timeout: 10_000 }).toBe(1);
    const { port, briefs } = worker({ alpha: async (round) => {
      expect(await readFile(join(round.cwd, "src/alpha/impl.txt"), "utf8")).toBe("alpha\n");
      return checked(round.cwd);
    } });
    await engine(setup, port);
    const task = (await setup.store.fold()).tasks.alpha!;
    expect(task).toMatchObject({ status: "landed", rounds: 2, usage: { requests: 4 } });
    expect(briefs.alpha![0]).toContain("the host stopped during the round");
  });

  it("checks the batch once it is on the trunk and bisects a failure to the task that caused it", async () => {
    const setup = await project({ where: "local", run: "test ! -e src/beta/bad.txt" });
    await propose(setup.store, [spec("alpha"), spec("beta"), spec("gamma")]);
    const { port } = worker(Object.fromEntries(["alpha", "beta", "gamma"].map((id) => [id, async (round: WorkerRound) => {
      await write(round.cwd, `src/${id}/${id === "beta" ? "bad" : "good"}.txt`, `${id}\n`);
      return checked(round.cwd);
    }])));
    const { instance, errors } = await engine(setup, port);
    await instance.pump(true);
    await instance.settled();
    expect(errors).toEqual([]);
    const projection = await setup.store.fold();
    expect(projection.batches.b1?.check).toMatchObject({ passed: false, culpritTaskId: "beta" });
    expect(projection.tasks.beta).toMatchObject({ status: "attention", attention: { reason: "batch-check" } });
    expect(projection.tasks.alpha?.status).toBe("landed");
  });

  it("completes a read-only task from its report and refuses one that wrote a file", async () => {
    const setup = await project();
    await propose(setup.store, [spec("scout", { kind: "read-only", writeScope: [] }), spec("sneak", { kind: "read-only", writeScope: [] }),
      spec("alpha", { dependsOn: ["scout"] })]);
    const { port, briefs } = worker({
      scout: async () => ({ report: { ...COMPLETE, summary: "the parser lives in src/alpha" } }),
      sneak: async (round) => {
        await write(round.cwd, "notes.md", "oops\n");
        return { report: COMPLETE };
      },
      alpha: async (round) => {
        await write(round.cwd, "src/alpha/impl.txt", "alpha\n");
        return checked(round.cwd);
      },
    });
    await engine(setup, port);
    const projection = await setup.store.fold();
    expect(projection.tasks.scout?.status).toBe("done");
    expect(projection.tasks.sneak).toMatchObject({ status: "attention", attention: { reason: "write-scope" } });
    expect(briefs.alpha![0]).toContain("the parser lives in src/alpha");
  });

  it("opens a pull request instead of pushing, and counts the task landed once a squash merge carries its patch", async () => {
    const setup = await project({ where: "ci" }, "pull-request");
    await propose(setup.store, [spec("alpha")]);
    const { port } = worker({ alpha: async (round) => {
      await write(round.cwd, "src/alpha/impl.txt", "alpha\n");
      return checked(round.cwd);
    } });
    const { instance } = await engine(setup, port);
    expect((await setup.store.fold()).tasks.alpha?.status).toBe("delivered");
    expect(await git(setup.main, "log", "-1", "--format=%s", "origin/main")).toBe("base");
    const reviewer = join(setup.main, "..", "reviewer");
    await run("git", ["clone", "--quiet", setup.remote, reviewer]);
    await git(reviewer, "config", "user.name", "Reviewer");
    await git(reviewer, "config", "user.email", "reviewer@example.com");
    await git(reviewer, "merge", "--quiet", "--squash", "origin/team/alpha");
    await git(reviewer, "commit", "--quiet", "-m", "feat: alpha (#1)");
    await git(reviewer, "push", "--quiet", "origin", "HEAD:main");
    await instance.pump(true);
    await instance.settled();
    const task = (await setup.store.fold()).tasks.alpha!;
    expect(task.status).toBe("landed");
    expect(task.landedCommit).toBe(await git(reviewer, "rev-parse", "HEAD"));
  });

  it("commits a local delivery on the task branch only, and counts it landed once the person merges it", async () => {
    const setup = await project({ where: "ci" }, "local");
    await propose(setup.store, [spec("alpha")]);
    const { port } = worker({ alpha: async (round) => {
      await write(round.cwd, "src/alpha/impl.txt", "alpha\n");
      return checked(round.cwd);
    } });
    const { instance } = await engine(setup, port);
    expect((await setup.store.fold()).tasks.alpha?.status).toBe("delivered");
    expect(await git(setup.main, "log", "-1", "--format=%s", "origin/main")).toBe("base");
    expect(leadBrief(await setup.store.fold())).toContain("- alpha: branch team/alpha");
    await git(setup.main, "merge", "--quiet", "--ff-only", "team/alpha");
    await instance.pump(true);
    await instance.settled();
    expect((await setup.store.fold()).tasks.alpha?.status).toBe("landed");
  });

  it("acts on a batch another process appends to its log without being asked", async () => {
    const setup = await project();
    const { port } = worker({ alpha: async (round) => {
      await write(round.cwd, "src/alpha/impl.txt", "alpha\n");
      return checked(round.cwd);
    } });
    await engine(setup, port);
    await propose(new TeamEventStore(setup.store.path), [spec("alpha")]);
    await expect.poll(async () => (await setup.store.fold()).tasks.alpha?.status, { timeout: 15_000 }).toBe("landed");
  });

  it("cancels a running task without deleting its work", async () => {
    const setup = await project();
    await propose(setup.store, [spec("alpha")]);
    let release!: () => void;
    const started = new Promise<void>((resolve) => { release = resolve; });
    const { port } = worker({ alpha: async (round) => {
      await write(round.cwd, "src/alpha/half.txt", "half\n");
      release();
      await new Promise((resolve) => round.signal.addEventListener("abort", resolve, { once: true }));
      return {};
    } });
    const instance = new TeamEngine({ config: setup.config, store: setup.store, worker: port, commands: shell, hostId: "orchestrator" });
    engines.push(instance);
    void instance.start();
    await started;
    expect(await instance.stopTask("alpha", "cancelled", "the person dropped it")).toBe(true);
    const task = (await setup.store.fold()).tasks.alpha!;
    expect(task.status).toBe("cancelled");
    expect(await git(setup.main, "show", "team/alpha:src/alpha/half.txt")).toBe("half");
  });

  it("parks a task at its request cap, at a refused approval, and at a checked tree that changed", async () => {
    const setup = await project();
    await propose(setup.store, [spec("alpha", { writeScope: ["src/alpha/**"] }), spec("beta"), spec("gamma")]);
    const { port } = worker({
      alpha: async () => ({ exhausted: true, usage: { requests: 10, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }),
      beta: async () => ({ report: { status: "continue", summary: "needs to push", evidence: [], nextSteps: [] }, deniedApprovals: ["bash"] }),
      gamma: async (round) => {
        await write(round.cwd, "src/gamma/impl.txt", "one\n");
        const outcome = await checked(round.cwd);
        await write(round.cwd, "src/gamma/impl.txt", "two\n");
        return outcome;
      },
    });
    await engine(setup, port);
    const projection = await setup.store.fold();
    expect(projection.tasks.alpha?.attention?.reason).toBe("request-budget");
    expect(projection.tasks.beta?.attention).toMatchObject({ reason: "approval", detail: expect.stringContaining("bash") });
    expect(projection.tasks.gamma?.attention).toMatchObject({ reason: "check-failed", detail: "the working tree changed after the last passing check" });
  });
});
