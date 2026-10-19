import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { Conversations, connect } from "@chopin-ai/harness-pi/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveModel, type ChooseModel } from "../src/model.js";
import { openProject, runDaemon } from "../src/project.js";

const [first] = builtinModels().getModels();
const choose: ChooseModel = async () => ({ provider: first?.provider ?? "", modelId: first?.id ?? "" });
const refuse: ChooseModel = async () => { throw new Error("should not ask"); };

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "chopin-home-"));
  process.env.CHOPIN_HOME = home;
  delete process.env.CHOPIN_MODEL;
});
afterEach(async () => {
  for (const pid of await daemons()) process.kill(pid, "SIGTERM");
  delete process.env.CHOPIN_HOME;
});

/** The process of every project service this test's home records. */
async function daemons(): Promise<number[]> {
  const projects = await readdir(join(home, "projects")).catch(() => []);
  const records = await Promise.all(projects.map((project) =>
    readFile(join(home, "projects", project, "service.json"), "utf8").then((text) => [JSON.parse(text).pid as number], () => [])));
  return records.flat();
}

async function exited(pid: number): Promise<void> {
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 100 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  expect(alive()).toBe(false);
}

describe("openProject", () => {
  it("starts one background service per project, which every chopin joins and none owns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chopin-project-"));
    const first = await openProject(directory, choose);
    const second = await openProject(directory, refuse);
    expect(second.url.href).toBe(first.url.href);
    const [pid] = await daemons();
    expect(pid).not.toBe(process.pid);

    const host = connect(second.url, { token: second.token });
    const conversations = await host.get(Conversations, {});
    expect(await host.root((ctx) => conversations.create(ctx))).toBeTypeOf("number");
    await host.close();

    process.kill(pid ?? 0, "SIGTERM");
    await exited(pid ?? 0);
    expect(await daemons()).toEqual([]);
    const next = await openProject(directory, refuse);
    expect(next.url.href).not.toBe(first.url.href);
  });

  it("starts a single service when several chopins open a project for the first time at once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chopin-project-"));
    const opened = await Promise.all([1, 2, 3].map(() => openProject(directory, choose)));
    expect(new Set(opened.map((project) => project.url.href)).size).toBe(1);
    expect(await daemons()).toHaveLength(1);
  });

  it("replaces a service that died without cleaning up", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chopin-project-"));
    const first = await openProject(directory, choose);
    const [pid] = await daemons();
    process.kill(pid ?? 0, "SIGKILL");
    await exited(pid ?? 0);

    const next = await openProject(directory, refuse);
    expect(next.token).not.toBe(first.token);
  });

  it("does not trust a left-over record whose process id now belongs to another process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chopin-project-"));
    const first = await openProject(directory, choose);
    const [pid] = await daemons();
    process.kill(pid ?? 0, "SIGKILL");
    await exited(pid ?? 0);
    const [project] = await readdir(join(home, "projects"));
    const record = join(home, "projects", project ?? "", "service.json");
    await writeFile(record, JSON.stringify({ ...JSON.parse(await readFile(record, "utf8")), pid: process.pid }));

    const next = await openProject(directory, refuse);
    expect(next.token).not.toBe(first.token);
  });

  it("starts the service once one that was ending lets go of the project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chopin-project-"));
    const project = createHash("sha256").update(await realpath(directory)).digest("hex").slice(0, 16);
    await mkdir(join(home, "projects", project), { recursive: true });
    const ending = new DatabaseSync(join(home, "projects", project, "service.lock"));
    ending.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
    setTimeout(() => ending.close(), 1_500);

    const opened = await openProject(directory, choose);
    expect(opened.token).toBeTruthy();
    expect(await daemons()).toHaveLength(1);
  }, 15_000);

  it("reports why the service could not start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chopin-project-"));
    process.env.CHOPIN_MODEL = "nobody/nothing";
    await expect(openProject(directory, refuse)).rejects.toThrow("unknown model nobody/nothing");
  });
});

describe("runDaemon", () => {
  it("serves until idle, and admits no second service of the project meanwhile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chopin-project-"));
    process.env.CHOPIN_MODEL = `${first?.provider}/${first?.id}`;
    const serving = runDaemon(directory, { idleMs: 200 });
    for (let i = 0; i < 100 && (await daemons()).length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await daemons()).toEqual([process.pid]);

    await runDaemon(directory, { idleMs: 200 });
    expect(await daemons()).toEqual([process.pid]);
    await serving;
    expect(await daemons()).toEqual([]);
  });
});

describe("settings", () => {
  it("are never seen half written by a chopin reading at the same moment", async () => {
    const models = builtinModels();
    const asked = Promise.all(Array.from({ length: 20 }, () => resolveModel(models, choose)));
    await expect(asked).resolves.toHaveLength(20);
  });
});

describe("resolveModel", () => {
  const models = builtinModels();

  it("asks once and keeps the answer", async () => {
    const asked = await resolveModel(models, choose);
    expect(await resolveModel(models, refuse)).toEqual(asked);
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8")).model).toBe(`${asked.provider}/${asked.modelId}`);
  });

  it("prefers CHOPIN_MODEL and refuses a model it does not know", async () => {
    process.env.CHOPIN_MODEL = `${first?.provider}/${first?.id}`;
    expect(await resolveModel(models, refuse)).toEqual({ provider: first?.provider, modelId: first?.id });
    process.env.CHOPIN_MODEL = "nobody/nothing";
    await expect(resolveModel(models, refuse)).rejects.toThrow("unknown model nobody/nothing");
  });
});
