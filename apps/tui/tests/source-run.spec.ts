import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const hooks = pathToFileURL(join(root, "scripts", "source-hooks.ts")).href;
const source = (path: string) => JSON.stringify(pathToFileURL(join(root, path)).href);

describe("running from the sources", () => {
  it("runs chopin from any directory with chopin-dev.sh", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chopin-source-"));
    const { stdout } = await run(join(root, "chopin-dev.sh"), ["help"], { cwd: directory });
    expect(stdout).toContain("usage: chopin");
  }, 30_000);

  it("starts a project's service from the sources through the hooks alone", async () => {
    const home = await mkdtemp(join(tmpdir(), "chopin-home-"));
    const directory = await realpath(await mkdtemp(join(tmpdir(), "chopin-project-")));
    // Opens the project as chopin does, from a process run from the sources with an option of its own.
    const script = join(home, "open.mts");
    await writeFile(script, [
      `const { openProject } = await import(${source("apps/tui/src/project.ts")});`,
      `const { runtimeWith } = await import(${source("apps/tui/tests/models.ts")});`,
      "const [first] = (await runtimeWith()).getModels();",
      "await openProject(process.argv[2], async () => ({ provider: first.provider, modelId: first.id }));",
    ].join("\n"));
    const { CHOPIN_MODEL: _, ...environment } = process.env;
    await run(process.execPath, ["--import", hooks, "--no-deprecation", script, directory], { env: { ...environment, CHOPIN_HOME: home } });

    const [project = ""] = await readdir(join(home, "projects"));
    const { pid } = JSON.parse(await readFile(join(home, "projects", project, "service.json"), "utf8")) as { pid: number };
    try {
      const { stdout } = await run("ps", ["-ww", "-o", "command=", "-p", String(pid)]);
      expect(stdout.trim()).toBe(`${process.execPath} --import ${hooks} ${join(root, "apps/tui/src/bin.ts")} daemon ${directory}`);
    } finally {
      process.kill(pid, "SIGTERM");
    }
  }, 30_000);
});
