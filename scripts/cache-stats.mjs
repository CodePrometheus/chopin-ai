#!/usr/bin/env node
/**
 * Measure how well the prompt cache actually works, from dsh's session logs.
 *
 * Why measure: Anthropic's cache writes cost more than plain input (1.25x at the 5-minute
 * TTL, 2x at 1 hour) while reads cost only 0.1x. So "should the TTL be longer" cannot be
 * guessed; it depends on the read/write ratio in real traffic. The end of the output says how to read it.
 *
 * Session logs are **multi-frame** zstd: every append writes a frame, so `zstdDecompressSync`
 * only decodes the first one (and the whole session looks like a single line). This splits on
 * the frame magic and decodes frame by frame.
 *
 * Usage: node scripts/cache-stats.mjs [sessions root] [--days N]
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

/** The zstd frame magic number. */
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function dshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
}

/** Decompress a multi-frame zstd file frame by frame; bad frames are skipped so one cannot ruin the whole tally. */
function decompressFrames(buffer) {
  const starts = [];
  for (let i = buffer.indexOf(FRAME_MAGIC, 0); i !== -1; i = buffer.indexOf(FRAME_MAGIC, i + 4)) starts.push(i);
  let text = "";
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buffer.length;
    try {
      text += zstdDecompressSync(buffer.subarray(starts[k], end)).toString();
    } catch {
      // A half-written trailing frame is normal: the session is still running.
    }
  }
  return text;
}

async function* sessionFiles(root) {
  let workspaces;
  try {
    workspaces = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = join(root, workspace.name);
    for (const session of await readdir(workspaceDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const file = join(workspaceDir, session.name, "session.jsonl.zstd");
      try {
        yield { file, workspace: workspace.name, mtime: (await stat(file)).mtimeMs };
      } catch {
        // This session directory has not been written yet.
      }
    }
  }
}

const args = process.argv.slice(2);
const daysIndex = args.indexOf("--days");
const days = daysIndex >= 0 ? Number(args[daysIndex + 1]) : 7;
const root = args.find((a) => !a.startsWith("--") && a !== String(days)) ?? join(dshHome(), "sessions");
const cutoff = Date.now() - days * 86_400_000;

const total = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, requests: 0 };
const perWorkspace = new Map();
let sessions = 0;

for await (const { file, workspace, mtime } of sessionFiles(root)) {
  if (mtime < cutoff) continue;
  const text = decompressFrames(await readFile(file));
  let seen = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "assistant/chunk" || event.data?.chunk?.type !== "usage") continue;
    const u = event.data.chunk.usage ?? {};
    const row = perWorkspace.get(workspace) ?? { input: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
    for (const [key, field] of [["input", "inputTokens"], ["cacheRead", "cacheReadTokens"], ["cacheWrite", "cacheWriteTokens"], ["output", "outputTokens"], ["reasoning", "reasoningTokens"]]) {
      total[key] += u[field] ?? 0;
      if (key in row) row[key] += u[field] ?? 0;
    }
    total.requests += 1;
    row.requests += 1;
    perWorkspace.set(workspace, row);
    seen = true;
  }
  if (seen) sessions += 1;
}

const fmt = (n) => n.toLocaleString("en-US");
const pct = (a, b) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);

console.log(`Last ${days} days, ${sessions} session(s), ${fmt(total.requests)} model request(s)\n`);
console.log(`  cache read      ${fmt(total.cacheRead).padStart(12)}  (billed at 0.1x)`);
console.log(`  cache write     ${fmt(total.cacheWrite).padStart(12)}  (billed at 1.25x for 5min / 2x for 1h)`);
console.log(`  uncached input  ${fmt(total.input).padStart(12)}  (billed at 1x)`);
console.log(`  output          ${fmt(total.output).padStart(12)}`);
const prompt = total.cacheRead + total.cacheWrite + total.input;
console.log(`\n  hit rate        ${pct(total.cacheRead, prompt)}   read/write ratio ${total.cacheWrite === 0 ? "—" : (total.cacheRead / total.cacheWrite).toFixed(1)}`);

// "No writes" and "writes not reported" are different things; do not let the latter read as the former.
// cacheWriteTokens in dsh's TokenUsage is optional and only present when the provider reports it:
// Anthropic reports cache_creation_input_tokens, DeepSeek reports only hits/misses and has no write figure.
if (total.cacheWrite === 0 && total.cacheRead > 0) {
  console.log("\n  Note: this data has no cache write records at all. Most likely nothing was wrong; this provider");
  console.log("        just does not report writes (DeepSeek does not). Judging the TTL needs Claude data.");
}
if (total.requests > 0 && prompt === 0) {
  console.log("\n  Note: requests but no token records; these rounds most likely failed before the model was called (e.g. no credentials).");
}

if (perWorkspace.size > 1) {
  console.log("\n  By workspace:");
  for (const [name, row] of [...perWorkspace].sort((a, b) => b[1].cacheRead - a[1].cacheRead)) {
    const p = row.cacheRead + row.cacheWrite + row.input;
    console.log(`    ${pct(row.cacheRead, p).padStart(6)}  ${String(row.requests).padStart(5)} req  ${name}`);
  }
}

console.log("\nHow to read this:");
console.log("  read/write > 3       the cache is paying off; leave the TTL alone.");
console.log("  read/write near 1    every round rewrites: something in the prefix changes each time (timestamps, random ids, toolset order).");
console.log("                       that is a bug to fix; a longer TTL will not save it.");
console.log("  high hit rate AND high read/write, with gaps between requests often over 5 minutes");
console.log("                       is the only case where PI_CACHE_RETENTION=long pays (writes go to 2x; needs >= 3 reads to break even).");
