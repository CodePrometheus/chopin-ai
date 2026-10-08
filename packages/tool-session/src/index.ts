/**
 * The curate tool surface: read session signals, view the pending area, record into it,
 * merge, settle, and feed back.
 *
 * The admission line shows here: writing to the pending area **needs no approval** (it is
 * untrusted by design, so an unattended overnight run may write freely), while promotion
 * into the ledger goes through `ledger_write`, which you approve on the spot.
 *
 * Admission alone is not memory. Memory requires feedback after promotion: **does the
 * lesson actually work?** `curation_review` is that piece. It does not ask "does the model
 * find it useful" but "did the original signal recur?", which the normalized key answers at
 * a glance. That is far more objective than pi-style "did the turn succeed" heuristics,
 * because gates and tools exist precisely to stop recurrence: still failing after
 * installation means the fix was at the wrong layer.
 *
 * @module @chopin/tool-session
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { JsonSchemaNode, ToolDefinition } from "@deepseek-ai/dsh-tools";

import { consolidationDue } from "@chopin/ledger";
import type { PendingEntry } from "@chopin/ledger";

import { countSessions, readSessions } from "./read.js";
import { scoreLesson } from "./review.js";
import { extractSignals } from "./signals.js";

type JsonValue = Parameters<ToolDefinition["output"]["render"]>[1];

export { readSessions, countSessions, decompressFrames, dshHome } from "./read.js";
export { scoreLesson } from "./review.js";
export type { LessonScore, ScorableLesson } from "./review.js";
export type { SessionLog, SessionEventRecord } from "./read.js";
export { extractSignals, scrub } from "./signals.js";
export type { Signal, SignalKind } from "./signals.js";

export const name = "chopin-tool-session";
export const inject = ["tools", "chopinLedger"];

export interface Config {
  /** Session log root; empty means `$DSH_HOME/sessions`. */
  sessionsDir: string;
}

export const Config: z<Config> = z.object({
  sessionsDir: z.string().default(""),
});

const SIGNALS_OUTPUT: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: ["signals", "sessionsRead", "days"],
  properties: {
    days: { type: "integer" },
    sessionsRead: { type: "integer" },
    signals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "tool", "sample", "occurrences", "sessions", "workspaces"],
        properties: {
          kind: { type: "string" },
          tool: { type: "string" },
          sample: { type: "string" },
          occurrences: { type: "integer" },
          sessions: { type: "integer" },
          workspaces: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const PENDING_ITEM: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: ["id", "lesson", "evidence", "occurrences", "sessions", "proposal", "confidence", "confirmedCount", "contradictedCount", "firstSeenAt", "lastSeenAt"],
  properties: {
    id: { type: "string" },
    lesson: { type: "string" },
    evidence: { type: "string" },
    occurrences: { type: "integer" },
    sessions: { type: "integer" },
    proposal: { type: "string" },
    confidence: { type: "number" },
    confirmedCount: { type: "integer" },
    contradictedCount: { type: "integer" },
    firstSeenAt: { type: "string" },
    lastSeenAt: { type: "string" },
  },
};

/** Only the fields the model needs: `key` and the internal clock add nothing to the judgement, only noise to the context. */
function summarize(entry: PendingEntry) {
  return {
    id: entry.id,
    lesson: entry.lesson,
    evidence: entry.evidence,
    occurrences: entry.occurrences,
    sessions: entry.sessions,
    proposal: entry.proposal,
    confidence: Number(entry.confidence.toFixed(2)),
    confirmedCount: entry.confirmedCount,
    contradictedCount: entry.contradictedCount,
    firstSeenAt: entry.firstSeenAt,
    lastSeenAt: entry.lastSeenAt,
  };
}

/** Session root: an empty config falls back to dsh's own resolution. */
function sessionsRoot(config: Config): string | undefined {
  return config.sessionsDir.trim() === "" ? undefined : config.sessionsDir;
}

function card(title: string) {
  return (args: unknown) => ({ card: "generic" as const, title, kind: "other" as const, rawInput: args as JsonValue });
}

function signalsTool(ctx: Context, config: Config): ToolDefinition {
  return {
    name: "session_signals",
    description:
      "Read the harness's own session logs and return what repeatedly went wrong: gate rejections and failing tool "
      + "calls, deduplicated by a normalized key so one problem does not appear ten times in ten wordings, counted "
      + "across sessions, with credentials scrubbed. Deterministic — no model reads the raw logs. "
      + "A signal seen in one session only is noise; the count across DISTINCT sessions is what makes it a lesson.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        days: { type: "integer", description: "How far back to read. Default 7." },
        min_occurrences: { type: "integer", description: "Drop signals seen fewer times than this. Default 2." },
        workspace: { type: "string", description: "Only this workspace (dsh names them after the cwd)." },
      },
    },
    output: {
      schema: SIGNALS_OUTPUT,
      render: (_args, value) => {
        const result = value as unknown as {
          days: number;
          sessionsRead: number;
          signals: { kind: string; tool: string; sample: string; occurrences: number; sessions: number }[];
        };
        if (result.signals.length === 0) {
          return [{ type: "text", text: `Read ${result.sessionsRead} session(s) over ${result.days} day(s); nothing recurred.` }];
        }
        const lines = [`Read ${result.sessionsRead} session(s) over ${result.days} day(s):`];
        for (const signal of result.signals) {
          lines.push(`[${signal.kind}] ${signal.tool} — ${signal.sessions} session(s), ${signal.occurrences} time(s)`);
          lines.push(`  ${signal.sample}`);
        }
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      const { days = 7, min_occurrences = 2, workspace } = args as { days?: number; min_occurrences?: number; workspace?: string };
      const all = await readSessions({ root: sessionsRoot(config), sinceMs: Date.now() - days * 86_400_000 });
      const logs = workspace === undefined ? all : all.filter((log) => log.workspace.includes(workspace));
      const signals = extractSignals(logs, { minOccurrences: min_occurrences });
      ctx.logger.info("session_signals: %d session(s) -> %d signal(s)", logs.length, signals.length);
      return {
        days,
        sessionsRead: logs.length,
        signals: signals.map((s) => ({
          kind: s.kind,
          tool: s.tool,
          sample: s.sample,
          occurrences: s.occurrences,
          sessions: s.sessions,
          workspaces: s.workspaces,
        })),
      };
    },
    presentCall: card("session_signals"),
  };
}

function pendingListTool(ctx: Context, config: Config): ToolDefinition {
  return {
    name: "curation_pending_list",
    description:
      "List the experience candidates waiting for the user's approval, with their confidence. These are NOT "
      + "trusted conclusions — nothing here has been reviewed. Check it before recording a new candidate so one "
      + "lesson does not accumulate under several ids. The reply also says whether a consolidation pass is due: "
      + "when it is, look for candidates that are the same lesson in different words and merge them.",
    parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["pending", "consolidation"],
        properties: {
          pending: { type: "array", items: PENDING_ITEM },
          consolidation: {
            type: "object",
            additionalProperties: false,
            required: ["due", "reason"],
            properties: { due: { type: "boolean" }, reason: { type: "string" } },
          },
        },
      },
      render: (_args, value) => {
        const result = value as unknown as {
          pending: { id: string; lesson: string; occurrences: number; sessions: number; proposal: string; confidence: number }[];
          consolidation: { due: boolean; reason: string };
        };
        const lines = result.pending.length === 0
          ? ["The pending area is empty."]
          : result.pending.map((p) =>
              `[${p.id}] ${p.sessions} session(s), ${p.occurrences} time(s), confidence ${p.confidence.toFixed(2)} -> ${p.proposal}\n  ${p.lesson}`,
            );
        lines.push(
          result.consolidation.due
            ? `Consolidation is due: ${result.consolidation.reason}. Merge candidates that say the same thing in different words.`
            : `No consolidation needed: ${result.consolidation.reason}.`,
        );
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute() {
      const pending = await ctx.chopinLedger.pending.list();
      const state = await ctx.chopinLedger.pending.consolidationState();
      const sessionCount = await countSessions({ root: sessionsRoot(config) });
      const consolidation = consolidationDue({ state, sessionCount });
      // Close the gate the moment "consolidation is due" is reported: the hint itself hands this
      // merge pass to the model. Left open, it stays open whenever the model finds nothing to merge, and every night rescans.
      if (consolidation.due) await ctx.chopinLedger.pending.markConsolidated(sessionCount);
      return { pending: pending.map(summarize), consolidation };
    },
    presentCall: card("curation_pending_list"),
  };
}

function pendingRecordTool(ctx: Context): ToolDefinition {
  return {
    name: "curation_pending_record",
    description:
      "Record one experience candidate in the pending area. No approval needed — the pending area is explicitly "
      + "untrusted, which is what lets an unattended run write to it. Promotion into the ledger is a separate, "
      + "approved action (ledger_write). Recording the same normalized signal again merges into the existing "
      + "candidate and raises its count rather than adding a duplicate.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id", "signal", "lesson", "evidence", "proposal"],
      properties: {
        id: { type: "string", description: "Lowercase slug (letters, digits, dashes); also the file name." },
        signal: { type: "string", description: "The raw recurring text this came from. Normalized internally into the merge key." },
        lesson: { type: "string", description: "What to do differently, in behavioral terms: what stops going wrong." },
        evidence: { type: "string", description: "Which sessions, how many times, and what the tool-call log showed." },
        proposal: {
          type: "string",
          enum: ["ledger", "gate", "toolset", "note"],
          description:
            "Where this should land if approved: a ledger record, a new gate rule, a new declarative tool, or just a note. "
            + "Prefer gate or toolset — those actually prevent the failure, so a later review can check whether the signal "
            + "stopped. A ledger record or a note only informs, and nothing can confirm it from the logs.",
        },
        occurrences: { type: "integer", description: "How many times observed in this pass. Default 1." },
        sessions: { type: "integer", description: "How many DISTINCT sessions back it. Sets the starting confidence — pass what session_signals reported. Default 1." },
      },
    },
    output: {
      schema: { type: "object", additionalProperties: false, required: ["entry"], properties: { entry: PENDING_ITEM } },
      render: (_args, value) => {
        const { entry } = value as unknown as { entry: { id: string; occurrences: number; sessions: number; confidence: number } };
        return [{
          type: "text",
          text: `Pending candidate ${entry.id}: ${entry.sessions} session(s), ${entry.occurrences} occurrence(s), starting confidence ${entry.confidence.toFixed(2)}. It reaches the ledger only when the user approves it.`,
        }];
      },
    },
    async execute(args) {
      const input = args as {
        id: string; signal: string; lesson: string; evidence: string;
        proposal: "ledger" | "gate" | "toolset" | "note"; occurrences?: number; sessions?: number;
      };
      return { entry: summarize(await ctx.chopinLedger.pending.record(input)) };
    },
    presentCall: card("curation_pending_record"),
  };
}

function pendingMergeTool(ctx: Context): ToolDefinition {
  return {
    name: "curation_pending_merge",
    description:
      "Merge one pending candidate into another because they are the same lesson worded differently. "
      + "Identical signals already merge on their own — this is for the ones whose wording drifted too far for that. "
      + "Counts add up, the earliest first-seen wins, and the absorbed candidate is filed under merged/ rather than "
      + "deleted, so the decision stays auditable. Deciding what is 'the same lesson' is a judgement call and yours; "
      + "only merge when acting on one would fully cover the other.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["into", "from"],
      properties: {
        into: { type: "string", description: "Id of the candidate to keep — usually the better-worded or better-supported one." },
        from: { type: "string", description: "Id of the candidate to absorb." },
      },
    },
    output: {
      schema: { type: "object", additionalProperties: false, required: ["entry"], properties: { entry: PENDING_ITEM } },
      render: (args, value) => {
        const { from } = args as { from: string };
        const { entry } = value as unknown as { entry: { id: string; occurrences: number; sessions: number } };
        return [{ type: "text", text: `Merged ${from} into ${entry.id}: now ${entry.sessions} session(s), ${entry.occurrences} occurrence(s).` }];
      },
    },
    async execute(args) {
      const { into, from } = args as { into: string; from: string };
      return { entry: summarize(await ctx.chopinLedger.pending.merge(into, from)) };
    },
    presentCall: card("curation_pending_merge"),
  };
}

function pendingSettleTool(ctx: Context): ToolDefinition {
  return {
    name: "curation_pending_settle",
    description:
      "Close out a pending candidate: 'promoted' once the lesson actually landed somewhere (a gate rule, a "
      + "declarative tool), 'rejected' once the user has seen it and does not want it. A candidate promoted into "
      + "the LEDGER needs no call here — ledger_write settles it itself. Marking something promoted that did not "
      + "land corrupts the review that follows, because the review judges a lesson by whether the failure stopped.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id", "outcome"],
      properties: {
        id: { type: "string", description: "Candidate id." },
        outcome: { type: "string", enum: ["promoted", "rejected"], description: "'promoted' — it landed. 'rejected' — the user does not want it." },
      },
    },
    output: {
      schema: { type: "object", additionalProperties: false, required: ["id", "outcome"], properties: { id: { type: "string" }, outcome: { type: "string" } } },
      render: (_args, value) => {
        const result = value as unknown as { id: string; outcome: string };
        const note = result.outcome === "promoted" ? " curation_review will check from here on whether the signal actually stops." : "";
        return [{ type: "text", text: `Candidate ${result.id} settled as ${result.outcome}.${note}` }];
      },
    },
    async execute(args) {
      const { id, outcome } = args as { id: string; outcome: "promoted" | "rejected" };
      await ctx.chopinLedger.pending.settle(id, outcome);
      return { id, outcome };
    },
    presentCall: card("curation_pending_settle"),
  };
}

const REVIEW_ITEM: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: ["id", "lesson", "proposal", "outcome", "confidenceBefore", "confidenceAfter", "recurrencesAfter", "sessionsAfter", "flaggedForRemoval"],
  properties: {
    id: { type: "string" },
    lesson: { type: "string" },
    proposal: { type: "string" },
    outcome: { type: "string" },
    confidenceBefore: { type: "number" },
    confidenceAfter: { type: "number" },
    recurrencesAfter: { type: "integer" },
    sessionsAfter: { type: "integer" },
    flaggedForRemoval: { type: "boolean" },
  },
};

function reviewTool(ctx: Context, config: Config): ToolDefinition {
  return {
    name: "curation_review",
    description:
      "Score every promoted lesson against what actually happened afterwards, and report which ones are not "
      + "working. For a lesson that became a gate rule or a declarative tool, the test is objective: did the "
      + "signal it was meant to prevent show up again in sessions since it landed? Still recurring means the fix "
      + "was at the wrong layer — that outcome costs three times what a confirmation earns, deliberately. Lessons "
      + "that only inform (a ledger record, a note) prevent nothing, so recurrence is not held against them; they "
      + "only decay with time. Deterministic — it reads the logs, not your judgement.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        dry_run: { type: "boolean", description: "Report the scores without writing them back. Default false." },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["reviewed", "notWorking", "dryRun"],
        properties: {
          dryRun: { type: "boolean" },
          reviewed: { type: "array", items: REVIEW_ITEM },
          notWorking: { type: "array", items: { type: "string" } },
        },
      },
      render: (_args, value) => {
        const result = value as unknown as {
          dryRun: boolean;
          reviewed: { id: string; lesson: string; outcome: string; confidenceBefore: number; confidenceAfter: number; recurrencesAfter: number; sessionsAfter: number; flaggedForRemoval: boolean }[];
          notWorking: string[];
        };
        if (result.reviewed.length === 0) {
          return [{ type: "text", text: "Nothing has been promoted yet, so there is nothing to review." }];
        }
        const lines = result.reviewed.map((item) => {
          const arrow = `${item.confidenceBefore.toFixed(2)} -> ${item.confidenceAfter.toFixed(2)}`;
          const why = item.outcome === "contradicted"
            ? `still recurred ${item.recurrencesAfter} time(s) since it landed`
            : item.outcome === "confirmed"
              ? `no recurrence across ${item.sessionsAfter} session(s) since it landed`
              : "nothing to judge it by yet";
          return `[${item.id}] ${item.outcome} (${arrow}) — ${why}\n  ${item.lesson}`;
        });
        if (result.notWorking.length > 0) {
          lines.push(`Not working, worth revisiting: ${result.notWorking.join(", ")}. A promoted lesson whose signal keeps coming back was fixed at the wrong layer.`);
        }
        if (result.dryRun) lines.push("(dry run — nothing was written back)");
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      const { dry_run = false } = args as { dry_run?: boolean };
      const promoted = (await ctx.chopinLedger.pending.listPromoted()).filter((entry) => entry.promotedAt !== undefined);
      if (promoted.length === 0) return { reviewed: [], notWorking: [], dryRun: dry_run };

      // Read every session since the earliest promotion once, then slice per promotion time.
      // Reading per candidate would decompress the same logs N times, pure waste.
      const earliest = Math.min(...promoted.map((entry) => Date.parse(entry.promotedAt as string)));
      const logs = await readSessions({ root: sessionsRoot(config), sinceMs: earliest });

      const reviewed = [];
      const notWorking: string[] = [];
      for (const entry of promoted) {
        const since = Date.parse(entry.promotedAt as string);
        const after = logs.filter((log) => log.modifiedAt >= since);

        const { outcome, recurrencesAfter } = scoreLesson(entry, after);
        const confidenceBefore = entry.confidence;
        // A dry run takes the same computation path and just skips the write: a "preview" that echoes the current value is no preview.
        const result = await ctx.chopinLedger.pending.feedback(entry.id, outcome, { dryRun: dry_run });

        reviewed.push({
          id: entry.id,
          lesson: entry.lesson,
          proposal: entry.proposal,
          outcome,
          confidenceBefore: Number(confidenceBefore.toFixed(2)),
          confidenceAfter: Number(result.confidence.confidence.toFixed(2)),
          recurrencesAfter,
          sessionsAfter: after.length,
          flaggedForRemoval: result.confidence.flaggedForRemoval,
        });
        if (outcome === "contradicted" || result.confidence.flaggedForRemoval) notWorking.push(entry.id);
      }

      ctx.logger.info("curation_review: %d promoted lesson(s), %d not working", reviewed.length, notWorking.length);
      return { reviewed, notWorking, dryRun: dry_run };
    },
    presentCall: card("curation_review"),
  };
}

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(signalsTool(ctx, config));
  ctx.tools.register(pendingListTool(ctx, config));
  ctx.tools.register(pendingRecordTool(ctx));
  ctx.tools.register(pendingMergeTool(ctx));
  ctx.tools.register(pendingSettleTool(ctx));
  ctx.tools.register(reviewTool(ctx, config));
}
