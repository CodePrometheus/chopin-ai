import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { carried, diff, DirectoryWorkspaceProvider, run, snapshot, type Workspace } from "../src/index.js";

const patchText = async (workspace: Workspace, base?: string) => {
  const patch = await diff(workspace, base);
  return patch === undefined ? undefined : Buffer.from(patch).toString("utf8");
};

describe("DirectoryWorkspaceProvider", () => {
  it("runs commands in its root and never deletes the directory", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chopin-directory-")));
    const workspace = new DirectoryWorkspaceProvider(root).open("local");
    expect(workspace.root).toBe(root);
    expect(await workspace.state()).toBe("running");
    expect((await run(workspace, ["pwd"])).stdout).toBe(`${root}\n`);
    await expect(workspace.destroy()).rejects.toThrow("never destroyed");
  });

  it("sets variables for the command alone, under their own names, and refuses to start it with one changed", () => {
    const launch = new DirectoryWorkspaceProvider(process.cwd()).open("local")
      .command(["/usr/bin/env"], { TOKEN: "a b=c", PATH: "/nowhere" });
    expect(launch.argv.join(" ")).not.toContain("a b=c");
    const [binary, ...args] = launch.argv;
    const output = execFileSync(binary ?? "", args, { env: { ...process.env, ...launch.env }, encoding: "utf8" });
    const seen = Object.fromEntries(output.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    expect(seen).toMatchObject({ TOKEN: "a b=c", PATH: "/nowhere" });
    expect(Object.keys(seen).filter((name) => name.startsWith("CHOPIN_ENV_"))).toEqual([]);

    // A shell that holds the variable read-only never starts the command.
    const held = carried(["/usr/bin/env"], { HELD: "mine" });
    const refused = spawnSync("/bin/sh", ["-c", `readonly HELD=theirs; ${held.exec}`, "sh", "/usr/bin/env"], {
      env: { ...process.env, ...held.env }, encoding: "utf8",
    });
    expect(refused.status).toBe(126);
    expect(refused.stderr).toContain("keeps its own HELD");
    expect(refused.stdout).not.toContain("HELD=");
  });

  it.runIf(process.platform === "darwin")("keeps every command away from hidden directories, and nothing else", async () => {
    const top = await realpath(await mkdtemp(join(tmpdir(), "chopin-hidden-")));
    await mkdir(join(top, "hidden"));
    await writeFile(join(top, "hidden", "secret"), "s3cret\n");
    await writeFile(join(top, "open"), "fine\n");
    const workspace = new DirectoryWorkspaceProvider(top, { hidden: [join(top, "hidden")] }).open("local");
    const reading = await run(workspace, ["sh", "-c", "cat hidden/secret; ls hidden"]);
    expect(reading.stdout).toBe("");
    expect(reading.stderr).toContain("Operation not permitted");
    expect((await run(workspace, ["sh", "-c", "echo x > hidden/new"])).exitCode).not.toBe(0);
    // A child the command starts is held as well.
    expect((await run(workspace, ["sh", "-c", "sh -c 'cat hidden/secret' 2>&1"])).stdout).toContain("Operation not permitted");
    expect((await run(workspace, ["cat", "open"])).stdout).toBe("fine\n");
  });

  it("reports how a program ended as its exit code, signals and unread input included", async () => {
    const workspace = new DirectoryWorkspaceProvider(process.cwd()).open("local");
    expect((await run(workspace, ["sh", "-c", "exit 4"], { input: "x".repeat(1 << 20) })).exitCode).toBe(4);
    expect((await run(workspace, ["sh", "-c", "kill -9 $$"])).exitCode).toBe(137);
  });
});

describe("diff", () => {
  it("takes everything in a repository with no commit yet, and nothing outside a repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "chopin-diff-"));
    const workspace = new DirectoryWorkspaceProvider(root).open("local");
    expect(await patchText(workspace)).toBeUndefined();
    execFileSync("git", ["-C", root, "init", "--quiet"]);
    await writeFile(join(root, "new.txt"), "fresh\n");
    const patch = await patchText(workspace);
    expect(patch).toContain("+++ b/new.txt");
    expect(patch).toContain("+fresh");
    expect(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" })).toBe("?? new.txt\n");
  });

  it("takes only what changed since a snapshot, leaving earlier uncommitted work out", async () => {
    const root = await mkdtemp(join(tmpdir(), "chopin-diff-"));
    const workspace = new DirectoryWorkspaceProvider(root).open("local");
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    await writeFile(join(root, "kept.txt"), "committed\n");
    git("add", "kept.txt");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init");
    await writeFile(join(root, "kept.txt"), "edited before\n");
    await writeFile(join(root, "draft.txt"), "untracked before\n");

    const base = await snapshot(workspace);
    await writeFile(join(root, "agent.txt"), "by the agent\n");
    const patch = await patchText(workspace, base);
    expect(patch).toContain("+++ b/agent.txt");
    expect(patch).not.toContain("kept.txt");
    expect(patch).not.toContain("draft.txt");
    expect(git("status", "--porcelain")).toBe(" M kept.txt\n?? agent.txt\n?? draft.txt\n");
  });

  it("writes a plain patch whatever the user's diff settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "chopin-diff-"));
    const workspace = new DirectoryWorkspaceProvider(root).open("local");
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "color.ui", "always");
    git("config", "diff.noprefix", "true");
    await writeFile(join(root, "a.txt"), "one\n");
    const patch = await patchText(workspace);
    expect(patch).toContain("diff --git a/a.txt b/a.txt");
    expect(patch).not.toContain("\u001b[");
  });

  it("stages as the repository's commits would, so a one-line edit stays one line whatever its line endings", async () => {
    const root = await mkdtemp(join(tmpdir(), "chopin-diff-"));
    const workspace = new DirectoryWorkspaceProvider(root).open("local");
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "core.autocrlf", "input");
    await writeFile(join(root, "a.txt"), "one\r\ntwo\r\n");
    git("add", "a.txt");
    const base = await snapshot(workspace);
    await writeFile(join(root, "a.txt"), "one\r\nTWO\r\n");
    const patch = await patchText(workspace, base);
    expect(patch).toContain("-two");
    expect(patch).toContain("+TWO");
    expect(patch).not.toContain("-one");
  });

  it("covers only the root when it lies inside a larger repository, with paths relative to it", async () => {
    const top = await mkdtemp(join(tmpdir(), "chopin-diff-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", top, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    await mkdir(join(top, "sub"));
    const workspace = new DirectoryWorkspaceProvider(join(top, "sub")).open("local");
    const base = await snapshot(workspace);
    await writeFile(join(top, "elsewhere.txt"), "not the agent's\n");
    await writeFile(join(top, "sub", "mine.txt"), "the agent's\n");
    const patch = await patchText(workspace, base);
    expect(patch).toContain("diff --git a/mine.txt b/mine.txt");
    expect(patch).not.toContain("elsewhere");
  });

  it("keeps the bytes of a file in any encoding, and leaves out what git cannot stage", async () => {
    const root = await mkdtemp(join(tmpdir(), "chopin-diff-"));
    const workspace = new DirectoryWorkspaceProvider(root).open("local");
    execFileSync("git", ["-C", root, "init", "--quiet"]);
    const base = await snapshot(workspace);
    await writeFile(join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe8, 0x0a]));
    execFileSync("git", ["-C", root, "init", "--quiet", "nested"]);
    await writeFile(join(root, "locked.txt"), "no\n");
    await chmod(join(root, "locked.txt"), 0o000);

    const patch = Buffer.from((await diff(workspace, base)) ?? []);
    expect(patch.includes(Buffer.from([0x66, 0xe8, 0x0a]))).toBe(true);
    expect(patch.toString("latin1")).not.toContain("nested");
    expect(patch.toString("latin1")).not.toContain("locked.txt");
  });

  it("fails rather than reporting no repository when git itself cannot run", async () => {
    const root = await mkdtemp(join(tmpdir(), "chopin-diff-"));
    const inner = new DirectoryWorkspaceProvider(root).open("local");
    const inRoot = 'cd "$1" && shift && exec "$@"';
    const noGit: Workspace = { ...inner, command: (argv) => ({ argv: ["env", "PATH=/nonexistent", "/bin/sh", "-c", inRoot, "sh", root, "/bin/sh", ...argv.slice(1)], env: {} }) };
    execFileSync("git", ["-C", root, "init", "--quiet"]);
    await expect(diff(noGit)).rejects.toThrow("git failed");
  });

  it("fails rather than reporting no repository when the repository is broken", async () => {
    const root = await mkdtemp(join(tmpdir(), "chopin-diff-"));
    execFileSync("git", ["-C", root, "init", "--quiet"]);
    await writeFile(join(root, ".git", "config"), "[core\nbroken\n");
    await expect(diff(new DirectoryWorkspaceProvider(root).open("local"))).rejects.toThrow("bad config");
  });
});
