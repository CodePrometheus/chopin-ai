import { fstatSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const PROFILES = {
  tui: { name: "chopin-tui", surface: "@xmoon76/dsh-pi-tui", surfaceVersion: "0.5.0" },
  web: { name: "chopin", surface: "@deepseek-ai/dsh-web-app", surfaceVersion: undefined },
} as const;

/** dsh's Harness home, resolved the same way dsh itself does. */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/**
 * Proxy for the model endpoint. Reaching Anthropic from here requires one: without it
 * every request is ECONNREFUSED, which surfaces as failed OAuth refreshes and sign-ins.
 *
 * The value comes from CHOPIN_LLM_PROXY, read from the process environment first and
 * then from ~/.dsh/.env. Proxy variables may only come from the launching environment —
 * the dsh launcher refuses HTTPS_PROXY inside its .env layers — so this entry injects
 * them into the child process and dsh routes every fetch through them. Loopback goes
 * through NO_PROXY so the MemOS viewer and internal tools connect directly; chopin's
 * declarative toolsets already strip proxy variables when running commands.
 */
export async function llmProxy(): Promise<string | undefined> {
  const fromEnv = process.env.CHOPIN_LLM_PROXY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const text = await readFile(join(dshHome(), ".env"), "utf8");
    const line = text.split("\n").find((l) => /^\s*(export\s+)?CHOPIN_LLM_PROXY\s*=/.test(l));
    const value = line?.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function proxiedEnv(proxy: string | undefined): NodeJS.ProcessEnv {
  if (proxy === undefined) return { ...process.env };
  const noProxy = ["localhost", "127.0.0.1", "::1", process.env.NO_PROXY].filter(Boolean).join(",");
  return {
    ...process.env,
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    NO_PROXY: noProxy,
  };
}

/**
 * Preload arguments that silence MemOS.
 *
 * MemOS's default logger writes INFO to stdout and drowns the TUI, and in embedded mode
 * it reads no configuration at all (see `@chopin/memos-quiet`). Turning it off as an
 * ordinary plugin is a race: our module starts first, but the moment `await import()`
 * yields the event loop MemOS has already printed its startup log. `node --import` waits
 * for the preload's top-level await before running the main module, which is deterministic.
 *
 * The argument is omitted when the artifact is missing: half a build should still start.
 * @returns Arguments for node, normally a single `--import`.
 */
/**
 * Make sure fds 0/1/2 are open before spawning.
 *
 * `stdio: "inherit"` copies these three fds of the parent to the child; if any of them is
 * closed, `spawn()` throws `Error: spawn EBADF` **synchronously** -- not an error event,
 * a throw, so no listener on the child can catch it.
 *
 * When they are closed: the caller closed one explicitly (`chopin 0<&-`), or an upstream
 * process destroyed stdin (the TUI calls `process.stdin.destroy()` when handing over the
 * terminal) and then chained into chopin. Reopen a real one from `/dev/tty` when the
 * terminal is reachable, otherwise fall back to `/dev/null`: the UI degrades, but it does
 * not crash on an EBADF nobody can read.
 */
export async function ensureStdio(): Promise<void> {
  const { openSync } = await import("node:fs");
  for (const fd of [0, 1, 2]) {
    try {
      fstatSync(fd);
      continue; // This fd is fine.
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EBADF") continue;
    }
    // openSync always returns the lowest free fd, and we fill 0/1/2 in order,
    // so the number it hands back is exactly the missing one.
    const write = fd !== 0;
    try {
      openSync("/dev/tty", write ? "w" : "r");
    } catch {
      openSync("/dev/null", write ? "w" : "r");
    }
  }
}

/**
 * Process-level preloads, injected as `--import` in order; must be in place before dsh starts.
 *
 * `memos-quiet`: MemOS reads no configuration in embedded mode; a plugin that turns it off
 * loses the race to its `core.init()`.
 */
const PRELOADS = ["memos-quiet"] as const;

export async function preloadArgs(): Promise<string[]> {
  const args: string[] = [];
  for (const pkg of PRELOADS) {
    const preload = join(repoRoot, "packages", pkg, "dist", "preload.js");
    try {
      await lstat(preload);
      args.push("--import", pathToFileURL(preload).href);
    } catch {
      // Skip when not built: every preload is a nice-to-have hardening, not a requirement.
    }
  }
  return args;
}

/**
 * When macOS's objc runtime dlopens two different copies of libvips it prints
 * "Class ... is implemented in both ..." to stderr -- onto the screen the TUI is drawing.
 *
 * Two copies are unavoidable: dsh's attachments plugin needs sharp 0.35 (in the chopin repo
 * tree), MemOS's transformers need sharp 0.34 (in the profile tree), and two incompatible
 * requirements in two node_modules means two dylibs. Three routes tried and rejected: align
 * the versions (pnpm does not re-resolve, and objc dedupes by image, so two copies of the
 * same version still warn); drop one of the loaders (`attachments` is injected by eight
 * packages such as tool-fs and apiproxy and cannot be removed; disabling MemOS's local
 * embedding loses vector recall); filter the child's stderr (the TUI renders a stream of
 * control sequences, forwarding it line by line tears it apart -- in practice a black screen).
 *
 * What remains is this: tell the objc runtime not to report duplicate classes. It only
 * silences that diagnostic; each dylib keeps serving its own sharp and they never exchange objects.
 */
export function objcQuietEnv(): NodeJS.ProcessEnv {
  return process.platform === "darwin" ? { OBJC_DEBUG_DUPLICATE_CLASSES: "NO" } : {};
}

/** dsh's executable entry point. */
export async function dshBin(): Promise<string> {
  const manifestPath = require.resolve("@deepseek-ai/dsh/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { bin?: string | Record<string, string> };
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["dsh"];
  if (bin === undefined) throw new Error("@deepseek-ai/dsh declares no bin");
  return join(dirname(manifestPath), bin);
}
