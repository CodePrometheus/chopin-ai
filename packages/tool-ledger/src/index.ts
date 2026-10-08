/**
 * `ledger_search`: look up the conclusion ledger by error string.
 *
 * This tool is the actual carrier of the judgement "recurring N times means the first N-1
 * fixes were at the wrong layer", so the output puts `missedBecause` (why the last fix did
 * not reach the root) in the most visible spot: it is the only information that can stop
 * this fix from landing at the same layer again.
 *
 * Only a summary is returned, not the full record: the signals list in a record can be
 * long, and what the investigator needs is "does it exist, how many times was it fixed,
 * where did the last fix miss"; details can be fetched by id.
 *
 * Writing needs a person's approval, and approval has two carriers, either of which suffices:
 *
 *   1. An approval the user spoke in the session log, verified from the event stream by
 *      `approvalInSession`. The log is a tamper-proof matter of record, the same discipline
 *      as gates reading the tool-call log rather than claims.
 *   2. dsh's approval prompt, the fallback when 1 is absent.
 *
 * With the prompt as the only carrier, writes always fail in a session that has prompts
 * off, and that failure looks exactly like "a person saw it and declined". The approval
 * discipline stays; only its carrier can vary.
 *
 * @module @chopin/tool-ledger
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { JsonSchemaNode, ToolDefinition } from "@deepseek-ai/dsh-tools";

import { normalizeErrorString } from "@chopin/ledger";
import type { DefectRecord, DefectStatus } from "@chopin/ledger";

type JsonValue = Parameters<ToolDefinition["output"]["render"]>[1];

export const name = "chopin-tool-ledger";

/**
 * The approval the user spoke in this session, or undefined.
 *
 * The criterion is deliberately narrow, because loosening it means "the model approved itself":
 *
 *   * Only messages with the `user` role count. The assistant repeating "I approve" does not.
 *   * Only plain text blocks count. The same words in an image caption or an echoed tool result do not.
 *   * The phrase must relate directly to writing the ledger; any stray "ok" or "sure" does
 *     not count. Such words are everywhere in a dev conversation, and using them as the
 *     criterion is the same as having none.
 *
 * Once spoken, approval holds for the whole session rather than per entry: that is exactly
 * what the user means by "approve all", and demanding it per entry would turn this path into
 * a text version of the prompt.
 */
export function approvalInSession(session: { snapshotEvents(): readonly unknown[] } | undefined): string | undefined {
  if (session === undefined) return undefined;
  const events = session.snapshotEvents();
  for (const event of events) {
    const record = event as {
      type?: string;
      data?: { role?: string; content?: unknown; source?: { kind?: string } };
    };
    // The event type is `user/message` with the body in `data.content`. The first version used
    // `message` and `data.message.content`: the check never matched and the tool still reported
    // "rejected", same shape as a real rejection. Verify the shape against a session file, not other event types.
    if (record.type !== "user/message") continue;
    if (record.data?.role !== "user") continue;
    // `source.kind` separates real human input from plugin injection (goal rounds and the
    // like): approval wording inside injected text does not pass.
    if (record.data.source?.kind !== "user") continue;
    const blocks = Array.isArray(record.data.content) ? record.data.content : [];
    for (const block of blocks) {
      const text = block as { type?: string; text?: string };
      if (text.type !== "text" || typeof text.text !== "string") continue;
      if (LEDGER_APPROVAL.test(text.text)) return text.text.trim().slice(0, 200);
    }
  }
  return undefined;
}

/**
 * Approval phrases. One set each for Chinese and English; both require "approve" to appear
 * together with "ledger/lesson", or a whole sentence explicit enough not to misfire (the
 * "approve directly, skip pending" form).
 */
const LEDGER_APPROVAL =
  /(全部批准|直接批准|批准.{0,8}(经验|档案|账本|ledger)|(经验|档案|账本|ledger).{0,8}批准|approve.{0,20}(ledger|lesson)|(ledger|lesson).{0,20}approved)/i;
export const inject = ["tools", "chopinLedger"];

interface Match {
  id: string;
  status: string;
  rootCause: string;
  anchoredTag: string;
  signalCount: number;
  fixes: { pr: string; layer: string; date: string; missedBecause: string }[];
}

interface SearchResult {
  matches: Match[];
  /** The highest fix count among the matches; above 0 means this is not the first time. */
  timesFixedBefore: number;
}

const OUTPUT_SCHEMA: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: ["matches", "timesFixedBefore"],
  properties: {
    timesFixedBefore: { type: "integer" },
    matches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status", "rootCause", "anchoredTag", "signalCount", "fixes"],
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          rootCause: { type: "string" },
          anchoredTag: { type: "string" },
          signalCount: { type: "integer" },
          fixes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["pr", "layer", "date", "missedBecause"],
              properties: {
                pr: { type: "string" },
                layer: { type: "string" },
                date: { type: "string" },
                missedBecause: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

function summarize(record: DefectRecord): Match {
  return {
    id: record.id,
    status: record.status,
    rootCause: record.rootCause.description,
    anchoredTag: record.rootCause.anchoredTag,
    signalCount: record.signals.length,
    fixes: record.fixes.map((fix) => ({
      pr: fix.pr,
      layer: fix.layer,
      date: fix.date,
      missedBecause: fix.missedBecause ?? "",
    })),
  };
}

function render(_args: unknown, value: JsonValue): ContentBlock[] {
  const result = value as unknown as SearchResult;
  if (result.matches.length === 0) {
    return [{ type: "text", text: "No ledger record matches this error string. Treat it as first observed." }];
  }
  const lines: string[] = [];
  for (const match of result.matches) {
    lines.push(`[${match.id}] status=${match.status} anchored=${match.anchoredTag} signals=${match.signalCount}`);
    lines.push(`  root cause: ${match.rootCause}`);
    for (const fix of match.fixes) {
      const missed = fix.missedBecause === "" ? "" : ` — missed because: ${fix.missedBecause}`;
      lines.push(`  fixed ${fix.date} in ${fix.pr} at layer ${fix.layer}${missed}`);
    }
  }
  if (result.timesFixedBefore > 0) {
    lines.push(`Fixed ${result.timesFixedBefore} time(s) before and still recurring: the previous fixes were at the wrong layer.`);
  }
  return [{ type: "text", text: lines.join("\n") }];
}

const WRITE_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: ["id", "recurrence", "promotedCandidate"],
  properties: {
    id: { type: "string" },
    /** How many times this record was observed before; above 0 is a recurrence. */
    recurrence: { type: "integer" },
    /** Id of the pending candidate marked promoted along the way; empty string when none matched. */
    promotedCandidate: { type: "string" },
  },
};

const STATUSES: string[] = ["open", "mitigated", "recurring", "root-fixed"];

function renderWrite(_args: unknown, value: JsonValue): ContentBlock[] {
  const written = value as { id: string; recurrence: number; promotedCandidate: string };
  const note = written.recurrence > 0
    ? ` This is occurrence ${written.recurrence + 1}: the earlier fixes did not reach the root.`
    : "";
  const promoted = written.promotedCandidate === ""
    ? ""
    : ` Pending candidate ${written.promotedCandidate} is now marked promoted; curation_review will check from here on whether the signal actually stops.`;
  return [{ type: "text", text: `Ledger record ${written.id} written.${note}${promoted}` }];
}

function writeDefinition(ctx: Context): ToolDefinition {
  return {
    name: "ledger_write",
    description:
      "Record an approved root cause in the defect ledger. Requires the user's approval every time — "
      + "the ledger is what future investigations trust, so nothing enters it on your judgement alone. "
      + "Call this only after the user has agreed with the root cause, never as a step of your own analysis.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id", "errorString", "rootCause", "anchoredTag", "status"],
      properties: {
        id: { type: "string", description: "Lowercase slug identifying the defect (letters, digits, dashes); also the file name." },
        errorString: { type: "string", description: "The raw error string, verbatim. Normalized internally into the match key." },
        rootCause: { type: "string", description: "The structural defect, not the trigger." },
        anchoredTag: { type: "string", description: "The release tag the analysis was anchored at." },
        status: { type: "string", enum: STATUSES, description: "Where this defect stands now." },
      },
    },
    output: { schema: WRITE_OUTPUT_SCHEMA, render: renderWrite },
    async execute(args) {
      const input = args as {
        id: string;
        errorString: string;
        rootCause: string;
        anchoredTag: string;
        status: string;
      };
      // An existing record means a recurrence: keep its signals and fix history, add only this observation and conclusion.
      const existing = await ctx.chopinLedger.load(input.id);
      const now = new Date().toISOString();
      const observed = existing?.observedErrors ?? [];
      const record: DefectRecord = {
        id: input.id,
        errorKey: normalizeErrorString(input.errorString).key,
        observedErrors: observed.includes(input.errorString) ? observed : [...observed, input.errorString],
        rootCause: { description: input.rootCause, anchoredTag: input.anchoredTag },
        status: input.status as DefectStatus,
        signals: existing?.signals ?? [],
        fixes: existing?.fixes ?? [],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await ctx.chopinLedger.save(record);

      // If this write happens to land a pending candidate, the promotion is stamped here: the
      // write needs your approval, so "promoted" cannot appear out of nowhere, and nothing relies
      // on the model remembering another tool call. Only with the stamp can curation_review ask "did the signal recur?".
      const candidate = await ctx.chopinLedger.pending.findByKey(input.errorString);
      if (candidate !== undefined) await ctx.chopinLedger.pending.settle(candidate.id, "promoted");

      return { id: record.id, recurrence: record.fixes.length, promotedCandidate: candidate?.id ?? "" };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "ledger_write",
      kind: "other",
      rawInput: args as JsonValue,
    }),
  };
}

export function apply(ctx: Context): void {
  const definition: ToolDefinition = {
    name: "ledger_search",
    description:
      "Search the defect ledger by raw error string for prior occurrences of the same defect. "
      + "The error string is normalized internally (paths, timestamps, uuids, and numbers are flattened), "
      + "so the same defect matches across users, sessions, and releases. "
      + "Pass the error text verbatim, not a paraphrase of the symptom.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["error"],
      properties: {
        error: { type: "string", description: "The raw error string, copied verbatim from the evidence." },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args) {
      const { error } = args as { error: string };
      const records = await ctx.chopinLedger.search(error);
      const matches = records.map(summarize);
      const timesFixedBefore = matches.reduce((most, match) => Math.max(most, match.fixes.length), 0);
      return { matches, timesFixedBefore };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "ledger_search",
      kind: "other",
      rawInput: args as JsonValue,
    }),
  };

  ctx.tools.register(definition);
  ctx.tools.register(writeDefinition(ctx));

  // Writing the ledger needs a person's approval, but the prompt is not its only carrier. No guard here: a guard can only reject, not ask.
  //
  // The log comes first: if the user spoke approval in the session, that sentence is in the
  // event stream, tamper-proof and auditable, the same discipline as gates reading the tool-call
  // log rather than claims. Once verified, let it through without asking again: re-asking an
  // answered question only teaches people to click yes without reading.
  //
  // Fall back to the prompt only without log evidence. When the session policy has prompts off
  // it lands as a rejection, which looks like a real one, so the reason must spell out the difference.
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec.name !== "ledger_write") return next();

    const spoken = approvalInSession(exec.agent?.session);
    if (spoken !== undefined) return next();

    return {
      kind: "ask",
      reason:
        "Writing to the defect ledger needs your approval: future investigations trust it. "
        + "If this comes back rejected without you having seen a prompt, approval prompts are "
        + "disabled in this session — that is not a decision about the lesson. Do not retry; "
        + "say plainly that you approve writing this to the ledger, or record it where it will "
        + "actually be read (the project's AGENTS.md for a durable rule, the task's todo.md).",
    };
  });
}
