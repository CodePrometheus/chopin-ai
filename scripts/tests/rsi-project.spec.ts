import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { assertProjectTaskPack, checkProject, loadProjectTasks, snapshotWorkspace } from "../../apps/cli/src/rsi-project.js";
import { ProjectFileSystem } from "../../apps/cli/src/rsi-session.js";
import { projectTasks } from "./fixtures/project-tasks.js";

/** Executable code runs only inside the macOS OS sandbox; other platforms refuse it (covered by the refusal tests). */
const SANDBOXED = process.platform === "darwin";

describe("engineering task isolation and judge boundaries", () => {
  it("rejects task packs with missing tasks, cross-split sources, out-of-bounds paths or rule edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "rsi-project-pack-"));
    await expect(loadProjectTasks(root)).rejects.toThrow(/No project tasks/);
    const pack = projectTasks(); expect(() => assertProjectTaskPack(pack)).not.toThrow();
    pack.tasks[1]!.family = pack.tasks[0]!.family;
    expect(() => assertProjectTaskPack(pack)).toThrow(/boundary/);
    const path = projectTasks(); path.tasks[0]!.writable = ["../private"];
    expect(() => assertProjectTaskPack(path)).toThrow(/relative/);
    path.tasks[0]!.writable = ["CLAUDE.md"];
    expect(() => assertProjectTaskPack(path)).toThrow(/immutable/);
  });

  it("native file interface rejects reading outside files, symlinks and edits to read-only inputs, and allows declared outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "rsi-project-files-"));
    const workspace = join(root, "workspace"); await mkdir(join(workspace, "src"), { recursive: true });
    const task = projectTasks().tasks[0]!;
    for (const [path, content] of Object.entries(task.files)) await writeFile(join(workspace, path), content);
    await writeFile(join(root, "private.txt"), "private-input");
    await symlink(join(root, "private.txt"), join(workspace, "src/alias.mjs"));
    task.writable.push("src/alias.mjs");
    const ctx = new Context();
    try {
      const fs = new ProjectFileSystem(ctx, workspace, task);
      await expect(fs.resolve("../private.txt")).rejects.toThrow(/permissions/);
      await expect(fs.resolve("src/alias.mjs")).rejects.toThrow(/permissions/);
      const immutable = await fs.resolve("src/index.mjs");
      await expect(fs.writeText(immutable, "changed")).rejects.toThrow(/permissions/);
      await fs.writeText(await fs.resolve("src/value.mjs"), "export const value = 1;");
      expect(await readFile(join(workspace, "src/value.mjs"), "utf8")).toContain("1");
      expect(await readFile(join(root, "private.txt"), "utf8")).toBe("private-input");
      await expect(snapshotWorkspace(workspace, task)).rejects.toThrow(/symbolic link/);
    } finally { await ctx.fiber.dispose(); }
  });

  it("refuses to run candidate modules without the macOS sandbox", async () => {
    const task = projectTasks().tasks[0]!;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      await expect(checkProject(task.files, task.checks)).rejects.toThrow("No supported project execution sandbox");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it.runIf(SANDBOXED)("multi-file artifacts run in a separate process; external modules, host access and infinite loops cannot produce a pass", async () => {
    const task = projectTasks().tasks[0]!;
    expect((await checkProject(task.files, task.checks)).passed).toBe(0);
    const fixed = { ...task.files, "src/value.mjs": "export const value = 1;" };
    expect((await checkProject(fixed, task.checks)).passed).toBe(3);
    for (const source of [
      "import fs from 'node:fs'; export const value = 1;",
      "export const value = process.env.SECRET;",
      "while (true) {} export const value = 1;",
    ]) {
      const result = await checkProject({ ...fixed, "src/value.mjs": source }, task.checks.slice(0, 1));
      expect(result.passed).toBe(0); expect(result.results[0]!.error).toBeTruthy();
    }
  }, 12_000);
});
