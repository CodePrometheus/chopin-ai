import { appendFile, readFile } from "node:fs/promises";
import type { PromptResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { parseJsonLines } from "./json-file.js";

/** Recorded token totals; input includes tokens read from or written to the provider cache. */
export interface TokenUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}

/** One recorded ACP event or turn outcome, with optional adapter-owned usage totals. */
export type TranscriptEntry =
  | { at: string; notification: SessionNotification }
  | { at: string; sessionId: string; turnEnd: PromptResponse & { usage?: TokenUsage } };

/** Transcripts are JSON Lines, appended as the run goes so a crash loses at most the line being written. */
export async function appendTranscript(path: string, entry: TranscriptEntry): Promise<void> {
  await appendFile(path, `${JSON.stringify(entry)}\n`);
}

export async function readTranscript(path: string): Promise<TranscriptEntry[]> {
  return parseTranscript(await readFile(path, "utf8"), path);
}

/**
 * The entries of a transcript's text, read from `source`, which a failure names; a last line without its newline is
 * one a crash cut short.
 */
export function parseTranscript(text: string, source = "the transcript"): TranscriptEntry[] {
  return parseJsonLines(text.slice(0, text.lastIndexOf("\n") + 1), source) as TranscriptEntry[];
}

/** What one task run leaves behind: its transcript, and the patch it made to the workspace's git work tree. */
export interface TaskRun {
  transcript: TranscriptEntry[];
  /** The patch as git wrote it, bytes and all; `undefined` when the workspace is not a git work tree. */
  diff: Uint8Array | undefined;
}
