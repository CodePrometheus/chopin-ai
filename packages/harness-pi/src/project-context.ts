import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** The names a directory's instructions go by, the first one present winning, as the coding agent reads them. */
const NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/** An instruction file of the project the agent works in. */
export interface ContextFile {
  path: string;
  content: string;
}

/**
 * The project's own instructions, as the coding agent gives them to its model. They are read from the workspace
 * before each request, so an edit holds from the next one.
 */
export const projectContext: Extension = defineExtension({
  name: "chopin-project",
  sections: [section("project_context", async ({ env }, context) => {
    const files = env === undefined ? [] : await contextFiles(env, context);
    if (files.length === 0) return undefined;
    return [
      "Project-specific instructions and guidelines:",
      ...files.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`),
    ].join("\n\n");
  })],
});

/**
 * One file per directory, from the root of the file system down to `env`'s working directory; a linked worktree
 * nested in its main repository stands in for that repository's file, which covers the same code.
 */
export async function contextFiles(env: ExecutionEnv, context: Context): Promise<ContextFile[]> {
  const dirs: string[] = [];
  for (let dir = env.cwd; ; dir = posix.dirname(dir)) {
    dirs.push(dir);
    if (posix.dirname(dir) === dir) break;
  }
  const listed = await Promise.all(dirs.map(async (dir) => {
    const entries = await env.listDir(dir, context);
    return new Set(entries.ok ? entries.value.map((entry) => entry.name) : []);
  }));
  const shadowed = await shadowedFile(env, dirs, listed, context);
  const files: ContextFile[] = [];
  for (const [index, dir] of dirs.entries()) {
    for (const name of NAMES.filter((each) => listed[index]?.has(each))) {
      const read = await env.readTextFile(posix.join(dir, name), context);
      if (!read.ok) continue;
      const own = shadowed === undefined || posix.join(await canonical(env, dir, context), name) !== shadowed;
      if (own) files.unshift({ path: posix.join(dir, name), content: read.value.replace(/^﻿/, "") });
      break;
    }
  }
  return files;
}

/** The main repository's file that a linked worktree nested inside it shadows with its own; undefined in any other case. */
async function shadowedFile(env: ExecutionEnv, dirs: readonly string[], listed: readonly Set<string>[], context: Context): Promise<string | undefined> {
  const at = listed.findIndex((names) => names.has(".git"));
  const worktree = dirs[at];
  if (worktree === undefined) return undefined;
  // A worktree's .git is a file naming its git directory, whose commondir leads to the main repository's.
  const pointer = await env.readTextFile(posix.join(worktree, ".git"), context);
  if (!pointer.ok || !pointer.value.startsWith("gitdir: ")) return undefined;
  const gitDir = posix.resolve(worktree, pointer.value.slice("gitdir: ".length).trim());
  const common = await env.readTextFile(posix.join(gitDir, "commondir"), context);
  if (!common.ok) return undefined;
  const commonGitDir = await canonical(env, posix.resolve(gitDir, common.value.trim()), context);
  const main = posix.dirname(commonGitDir);
  const nested = (await canonical(env, worktree, context)).startsWith(`${main}/`);
  if (!nested || await canonical(env, posix.join(main, ".git"), context) !== commonGitDir) return undefined;
  const own = NAMES.find((name) => listed[at]?.has(name));
  return own === undefined ? undefined : posix.join(main, own);
}

async function canonical(env: ExecutionEnv, path: string, context: Context): Promise<string> {
  const found = await env.canonicalPath(path, context);
  return found.ok ? found.value : path;
}
