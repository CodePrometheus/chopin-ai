import { boundOutput, sanitizeOutput, utf8ByteLength } from "@earendil-works/chord/output";
import type { JobOutput } from "./jobs.js";

export type CommandOutputLimits = { maxBytes: number; maxLines: number };
export type CommandOutputState = {
  window: string;
  bytes: number;
  newlines: number;
  endsWithNewline: boolean;
  prefixEndsWithNewline: boolean;
  started: boolean;
  stdout: string;
  stderr: string;
  complete: boolean;
};

export function emptyCommandOutput(): CommandOutputState {
  return { window: "", bytes: 0, newlines: 0, endsWithNewline: true, prefixEndsWithNewline: true, started: false, stdout: "", stderr: "", complete: false };
}

/** Restores each channel's UTF-8 decoder from at most three original trailing bytes. */
export function appendCommandOutput(state: CommandOutputState, page: JobOutput, limits: CommandOutputLimits): string {
  let delta = "";
  if (page.stream !== null) {
    const bytes = Buffer.from(page.data, "base64url");
    const previous = Buffer.from(state[page.stream], "base64url");
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    decoder.decode(previous, { stream: true });
    delta = decoder.decode(bytes, { stream: true });
    const tail = Buffer.concat([previous, bytes]);
    state[page.stream] = tail.subarray(Math.max(0, tail.length - 3)).toString("base64url");
  }
  if (page.complete) {
    for (const channel of ["stdout", "stderr"] as const) {
      const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
      decoder.decode(Buffer.from(state[channel], "base64url"), { stream: true });
      delta += decoder.decode();
      state[channel] = "";
    }
    state.complete = true;
  }
  if (delta !== "") {
    const first = !state.started;
    state.started = true;
    if (first && delta.startsWith("\ufeff")) delta = delta.slice(1);
    state.bytes += utf8ByteLength(delta);
    state.newlines += newlines(delta);
    state.endsWithNewline = delta.endsWith("\n");
    if (!Number.isSafeInteger(state.bytes) || !Number.isSafeInteger(state.newlines)) throw new Error("command output counters exceed the exact integer representation");
    const combined = state.window + delta;
    // One extra character and line retain the preceding boundary needed by a later tail window.
    const margin = boundOutput(combined, { maxBytes: limits.maxBytes + 4, maxLines: limits.maxLines + 1, retain: "tail" });
    if (margin.droppedBytes > 0) {
      const bytes = Buffer.from(combined);
      state.prefixEndsWithNewline = bytes[bytes.length - margin.bytes - 1] === 10;
    }
    state.window = margin.text;
  }
  return delta;
}

export function commandOutput(state: CommandOutputState, limits: CommandOutputLimits): { text: string; truncated: boolean } {
  const kept = boundOutput(state.window, { ...limits, retain: "tail" });
  return { text: sanitizeOutput(kept.text), truncated: kept.bytes < state.bytes };
}

/** Omitted-prefix counts let a recovered native tool seed the original bounded output. */
export function commandOutputPrefix(state: CommandOutputState): { bytes: number; newlines: number; endsWithNewline: boolean } | undefined {
  const bytes = state.bytes - utf8ByteLength(state.window);
  return bytes === 0 ? undefined : { bytes, newlines: state.newlines - newlines(state.window), endsWithNewline: state.prefixEndsWithNewline };
}

function newlines(text: string): number {
  let count = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) count++;
  return count;
}
