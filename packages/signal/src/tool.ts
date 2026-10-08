/**
 * `triage_run`: run one triage round and hand the signals worth investigating to the model.
 *
 * Scheduling does not happen here. dsh ships its own schedule, so the model can arrange
 * "run every hour" itself; a second timer in chopin would only be one more thing to conflict with it.
 *
 * @module @chopin/signal/tool
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { JsonSchemaNode, ToolDefinition } from "@deepseek-ai/dsh-tools";

import type { TriageOutcome } from "./adapter.js";

type JsonValue = Parameters<ToolDefinition["output"]["render"]>[1];

export const name = "chopin-tool-signal";
export const inject = ["tools", "chopinSignals"];

const OUTPUT_SCHEMA: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: ["fresh", "sources"],
  properties: {
    fresh: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "ref", "symptom", "errorString", "evidencePointers"],
        properties: {
          id: { type: "string" },
          kind: { type: "string" },
          ref: { type: "string" },
          symptom: { type: "string" },
          errorString: { type: "string" },
          evidencePointers: { type: "array", items: { type: "string" } },
        },
      },
    },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status", "count", "detail"],
        properties: {
          name: { type: "string" },
          status: { type: "string" },
          count: { type: "integer" },
          detail: { type: "string" },
        },
      },
    },
  },
};

function render(_args: unknown, value: JsonValue): ContentBlock[] {
  const result = value as unknown as {
    fresh: { id: string; kind: string; ref: string; symptom: string }[];
    sources: { name: string; status: string; count: number; detail: string }[];
  };
  const lines = result.sources.map((source) => {
    const why = source.detail === "" ? "" : `  (${source.detail})`;
    return `[${source.status.padEnd(11)}] ${source.name}  new=${source.count}${why}`;
  });
  if (result.fresh.length === 0) {
    lines.push("", "No new signal this round.");
  } else {
    lines.push("", `${result.fresh.length} new signal(s):`);
    for (const signal of result.fresh) lines.push(`  ${signal.id}  ${signal.kind}:${signal.ref}  ${signal.symptom}`);
  }
  return [{ type: "text", text: lines.join("\n") }];
}

export function apply(ctx: Context): void {
  const definition: ToolDefinition = {
    name: "triage_run",
    description:
      "Poll every configured signal source once and return what is new since the last round. "
      + "Deterministic: no model reads the raw logs — sources cluster by normalized error string and "
      + "rank by occurrence and reach. A source that is unavailable is reported as such, never skipped silently.",
    parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
    output: { schema: OUTPUT_SCHEMA, render },
    async execute() {
      const outcome: TriageOutcome = await ctx.chopinSignals.runOnce();
      return {
        fresh: outcome.fresh.map((request) => ({
          id: request.id,
          kind: request.source.kind,
          ref: request.source.ref,
          symptom: request.symptom,
          errorString: request.errorString ?? "",
          evidencePointers: request.evidencePointers,
        })),
        sources: outcome.sources.map((source) => ({
          name: source.name,
          status: source.status,
          count: source.count,
          detail: source.detail ?? "",
        })),
      };
    },
    presentCall: () => ({ card: "generic", title: "triage_run", kind: "other", rawInput: null }),
  };

  ctx.tools.register(definition);
}
