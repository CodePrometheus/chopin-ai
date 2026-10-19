import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendTranscript, chopinMeta, readTranscript, withChopinMeta, type TranscriptEntry } from "../src/index.js";

describe("transcripts", () => {
  it("round-trips ACP entries through JSON Lines", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "chopin-transcript-")), "run.jsonl");
    const entries: TranscriptEntry[] = [
      { at: "2026-10-18T00:00:00.000Z", notification: { sessionId: "s1", update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } } },
      { at: "2026-10-18T00:00:01.000Z", sessionId: "s1", turnEnd: withChopinMeta(
        { stopReason: "end_turn" }, { model: { provider: "provider-a", id: "model-a" } }) },
    ];
    for (const entry of entries) await appendTranscript(path, entry);
    expect(await readTranscript(path)).toEqual(entries);
  });

  it("keeps its own facts under one namespaced _meta key without touching others", () => {
    const value = withChopinMeta({ stopReason: "end_turn", _meta: { other: 1 } }, { model: { provider: "p", id: "m" } });
    expect(value._meta).toEqual({ other: 1, "chopin-ai": { model: { provider: "p", id: "m" } } });
    expect(chopinMeta(value)).toEqual({ model: { provider: "p", id: "m" } });
    expect(chopinMeta({ stopReason: "end_turn" })).toBeUndefined();
  });
});
