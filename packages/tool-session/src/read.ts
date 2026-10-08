/**
 * Read dsh's session logs.
 *
 * The log is **multi-frame** zstd: every append writes one frame, so `zstdDecompressSync`
 * only yields the first one and a 400KB session looks like a single line. This splits on
 * the frame magic and decodes frame by frame, skipping bad ones: a half-written tail frame
 * is normal, that session is still running.
 *
 * @module @chopin/tool-session/read
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { parseSessionFormatLogFilename } from "@deepseek-ai/dsh-session-format";

/** zstd frame magic. */
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** One session event, keeping only the shape used here. */
export interface SessionEventRecord {
  type: string;
  data?: Record<string, unknown>;
}

export interface SessionLog {
  /** Session id (the directory name). */
  id: string;
  /** Which workspace this session belongs to (dsh keeps a directory per cwd). */
  workspace: string;
  /** Time of the last write. */
  modifiedAt: number;
  events: SessionEventRecord[];
}

/** dsh's Harness home, resolved the same way dsh itself does. */
export function dshHome(): string {
  const configured = process.env["DSH_HOME"]?.trim();
  return configured !== undefined && configured !== "" ? configured : join(homedir(), ".dsh");
}

/** Decompress multi-frame zstd frame by frame. */
export function decompressFrames(buffer: Buffer): string {
  const starts: number[] = [];
  for (let at = buffer.indexOf(FRAME_MAGIC, 0); at !== -1; at = buffer.indexOf(FRAME_MAGIC, at + 4)) starts.push(at);
  let text = "";
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index] as number;
    const end = index + 1 < starts.length ? (starts[index + 1] as number) : buffer.length;
    try {
      text += zstdDecompressSync(buffer.subarray(start, end)).toString();
    } catch {
      // Half-written tail frame: the session is still running, skip it.
    }
  }
  return text;
}

function parseEvents(text: string): SessionEventRecord[] {
  const events: SessionEventRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as SessionEventRecord);
    } catch {
      // One bad line must not ruin the whole session.
    }
  }
  return events;
}

/**
 * Read the sessions written in the last few days.
 * @param options - `root` is the session root; `sinceMs` keeps only sessions written after that time.
 * @returns Sessions in descending order of last write.
 */
/** A session's location and time on disk, without content. */
interface SessionRef {
  id: string;
  workspace: string;
  modifiedAt: number;
  file: string;
  compressed: boolean;
}

/**
 * Walk the session directories, stat only, no content.
 *
 * Split out because "how many sessions" and "what happened in them" are two questions:
 * deciding whether to consolidate needs only the former, and decompressing hundreds of
 * zstd logs just to count them is pure waste.
 */
async function* walkSessions(root: string, since: number): AsyncGenerator<SessionRef> {
  let workspaces;
  try {
    workspaces = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = join(root, workspace.name);
    let sessions;
    try {
      sessions = await readdir(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const directory = join(workspaceDir, session.name);
      const generations = (await readdir(directory, { withFileTypes: true })).flatMap((entry) => {
        if (!entry.isFile()) return [];
        const compressed = entry.name.endsWith(".zstd");
        const filename = compressed ? entry.name.slice(0, -5) : entry.name;
        const version = parseSessionFormatLogFilename(filename);
        return version === undefined ? [] : [{ name: entry.name, version, compressed }];
      }).sort((left, right) => right.version - left.version);
      const current = generations[0];
      if (current === undefined) continue;
      if (generations[1]?.version === current.version) {
        throw new Error(`session ${session.name} has ambiguous current log encodings`);
      }
      const file = join(directory, current.name);
      let modifiedAt: number;
      try {
        modifiedAt = (await stat(file)).mtimeMs;
      } catch {
        continue;
      }
      if (modifiedAt < since) continue;
      yield { id: session.name, workspace: workspace.name, modifiedAt, file, compressed: current.compressed };
    }
  }
}

export async function readSessions(options: { root?: string; sinceMs?: number } = {}): Promise<SessionLog[]> {
  const root = options.root ?? join(dshHome(), "sessions");
  const logs: SessionLog[] = [];
  for await (const ref of walkSessions(root, options.sinceMs ?? 0)) {
    const content = await readFile(ref.file);
    logs.push({
      id: ref.id,
      workspace: ref.workspace,
      modifiedAt: ref.modifiedAt,
      events: parseEvents(ref.compressed ? decompressFrames(content) : content.toString("utf8")),
    });
  }
  return logs.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * Count sessions without decompressing content.
 * @param options - `root` is the session root; `sinceMs` counts only sessions touched after that time.
 * @returns The session count.
 */
export async function countSessions(options: { root?: string; sinceMs?: number } = {}): Promise<number> {
  const root = options.root ?? join(dshHome(), "sessions");
  let count = 0;
  for await (const _ of walkSessions(root, options.sinceMs ?? 0)) count += 1;
  return count;
}
