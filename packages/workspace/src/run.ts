import { execFile } from "node:child_process";
import { constants } from "node:os";
import type { Workspace } from "./workspace.js";

export interface RunResult {
  stdout: string;
  stderr: string;
  /** As a shell reports it: 128 plus the signal's number for a program a signal ended. */
  exitCode: number;
}

export interface RunOptions {
  /** Written to the program's standard input, which is closed either way. */
  input?: string;
}

/**
 * Runs a program inside the running workspace and collects all of its output, which callers take whole, such as a
 * patch. However the program ends is a result, as is a program the workspace could not start, which ends with the
 * code its launcher gives, such as 127 for one not found; only a launcher that could not start at all is an error.
 */
export async function run(workspace: Workspace, argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const result = await execute(workspace, argv, options);
  return { ...result, stdout: result.stdout.toString("utf8") };
}

type Executed = Omit<RunResult, "stdout"> & { stdout: Buffer };

/** `run`, keeping standard output as the bytes the program wrote. */
function execute(workspace: Workspace, argv: readonly string[], options: RunOptions): Promise<Executed> {
  const { argv: [binary, ...args], env } = workspace.command(argv);
  return new Promise((resolve, reject) => {
    const child = execFile(binary as string, args, { env: { ...process.env, ...env }, maxBuffer: Infinity, encoding: "buffer" }, (error, stdout, stderr) => {
      const ended = (exitCode: number) => resolve({ stdout, stderr: stderr.toString("utf8"), exitCode });
      if (error === null) return ended(0);
      if (typeof error.code === "number") return ended(error.code);
      const signal = error.signal === undefined || error.signal === null ? undefined : constants.signals[error.signal];
      if (signal === undefined) return reject(error);
      ended(128 + signal);
    });
    // A program that exits without reading its input fails through its exit code, not through the pipe.
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input);
  });
}

/**
 * The workspace's git work tree as a tree object, untracked files under the root included, for `diff` to compare
 * against later.
 * @returns `undefined` when the workspace root is not in a git work tree.
 */
export async function snapshot(workspace: Workspace): Promise<string | undefined> {
  return (await inWorkTree(workspace, "git write-tree"))?.toString("utf8").trim();
}

/**
 * Everything changed under the workspace root since `base`, a `snapshot`, or since the last commit without one,
 * untracked files included, as a binary patch with paths relative to the root: the bytes git wrote, whatever the
 * files' encodings.
 * @returns `undefined` when the workspace root is not in a git work tree.
 */
export function diff(workspace: Workspace, base?: string): Promise<Uint8Array | undefined> {
  const since = '"${1:-$(git rev-parse --verify --quiet HEAD || git hash-object -t tree /dev/null)}"';
  // Plumbing, so the user's diff settings, such as color, prefixes or external tools, never shape the patch.
  const command = `git diff-index --cached --relative --patch --binary ${since}`;
  return inWorkTree(workspace, command, ...(base === undefined ? [] : [base]));
}

/**
 * Runs `command` with everything under the root staged in a throwaway index, so the work tree's own index stays
 * untouched; a root inside a larger repository leaves the rest of it as the real index has it. The throwaway index
 * starts as a copy of the real one, whose cached file stats spare rehashing unchanged files, and files are staged
 * as a commit in this repository would record them. What git cannot stage, such as an unreadable file or a nested
 * repository without a commit, is left out.
 */
async function inWorkTree(workspace: Workspace, command: string, ...args: string[]): Promise<Buffer | undefined> {
  const script = [
    // No repository only when nothing names one: no GIT_DIR and no `.git` up the tree. Any git failure past that is
    // an error, even one git would also give outside a repository.
    'if [ -z "${GIT_DIR:-}" ]; then dir=$(pwd -P); while [ ! -e "$dir/.git" ]; do [ "$dir" = / ] && exit 3; dir=${dir%/*}; dir=${dir:-/}; done; fi',
    // The workspace may belong to another user than the one running this.
    'n=${GIT_CONFIG_COUNT:-0}; export GIT_CONFIG_COUNT=$((n + 1)) "GIT_CONFIG_KEY_$n=safe.directory" "GIT_CONFIG_VALUE_$n=*"',
    'inside=$(git rev-parse --is-inside-work-tree) || exit',
    '[ "$inside" = true ] || exit 3',
    'index="$(git rev-parse --git-path index)"',
    'export GIT_INDEX_FILE="$(mktemp)"',
    "trap 'rm -f \"$GIT_INDEX_FILE\"' EXIT",
    // The copy keeps the index's own time, which git needs to notice a file changed within the same second.
    'if [ -f "$index" ]; then cp -p "$index" "$GIT_INDEX_FILE"; else git read-tree --empty; fi',
    "git add --all --ignore-errors -- .",
    // Status 1: some path was left out.
    'staged=$?; [ "$staged" -le 1 ] || exit "$staged"',
    command,
  ].join("\n");
  const result = await execute(workspace, ["sh", "-c", script, "sh", ...args], {});
  if (result.exitCode === 3) return undefined;
  if (result.exitCode !== 0) throw new Error(`git failed in ${workspace.root}: ${result.stderr.trim()}`);
  return result.stdout;
}
