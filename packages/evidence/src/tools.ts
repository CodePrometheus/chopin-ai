/**
 * Evidence tools: evidence bundle download and extraction, plus Pi harness session trace parsing.
 *
 * These are native tools rather than declarative YAML: chained history reconstruction,
 * the semantics of truncation markers and cache path derivation cannot be expressed in a
 * shell template. Declarative stays the default; native is only for the few a template
 * really cannot express.
 */

import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { JsonSchemaNode, ToolDefinition } from "@deepseek-ai/dsh-tools";

import { downloadAndExtract } from "./bundle.js";
import { getRun, getSystemPrompt, listRuns, reconstructHistory } from "./trace.js";

type JsonValue = Parameters<ToolDefinition["output"]["render"]>[1];

const TRACE_PATH: JsonSchemaNode = { type: "string", description: "absolute path to the trace JSONL file" };
const RUN_ID: JsonSchemaNode = { type: "string", description: "runId from trace_list_runs" };

function params(properties: Record<string, JsonSchemaNode>): Record<string, unknown> {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}

/** Shared output declaration for the tools that render as text. */
const TEXT_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: { text: { type: "string" } },
  } satisfies JsonSchemaNode,
  render: (_args: unknown, value: JsonValue): ContentBlock[] => [
    { type: "text", text: (value as { text: string }).text },
  ],
};

function card(name: string) {
  return (args: unknown) => ({ card: "generic" as const, title: name, kind: "other" as const, rawInput: args as JsonValue });
}

export function evidenceTools(): ToolDefinition[] {
  return [
    {
      name: "bundle_fetch",
      description:
        "Download and extract an evidence bundle (a zip attached to the report, often a time-limited signed URL). "
        + "Cached; returns the local extract dir to explore with the log tools.",
      parameters: params({ url: { type: "string", description: "the .zip URL from the report body" } }),
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["extractDir", "zipPath"],
          properties: { extractDir: { type: "string" }, zipPath: { type: "string" } },
        },
        render: (_args, value) => {
          const paths = value as { extractDir: string; zipPath: string };
          return [{ type: "text", text: `extracted to: ${paths.extractDir}\nzip: ${paths.zipPath}` }];
        },
      },
      async execute(args) {
        const { extractDir, zipPath } = await downloadAndExtract((args as { url: string }).url);
        return { extractDir, zipPath };
      },
      presentCall: card("bundle_fetch"),
    },
    {
      name: "trace_list_runs",
      description:
        "List all conversation runs (full_run) in a Pi session trace JSONL file, in time order, "
        + "with the triggering user prompt of each.",
      parameters: params({ trace_path: TRACE_PATH }),
      output: TEXT_OUTPUT,
      async execute(args) {
        const runs = await listRuns((args as { trace_path: string }).trace_path);
        if (runs.length === 0) return { text: "no full_run records found in this file" };
        const lines = runs.map(
          (run) => `${run.runId}\tmsgs=${run.messageCount}\tctx=${run.contextCount}\t${run.firstUserText}`,
        );
        return { text: lines.join("\n") };
      },
      presentCall: card("trace_list_runs"),
    },
    {
      name: "trace_get_run",
      description:
        "Get the messages of one run. Fields marked traceTruncated were clipped by the trace writer only — "
        + "the model saw the full text; never read them as model-side truncation.",
      parameters: params({ trace_path: TRACE_PATH, run_id: RUN_ID }),
      output: TEXT_OUTPUT,
      async execute(args) {
        const { trace_path, run_id } = args as { trace_path: string; run_id: string };
        const run = await getRun(trace_path, run_id);
        if (run === undefined) return { text: `run ${run_id} not found` };
        return { text: JSON.stringify(run, null, 2) };
      },
      presentCall: card("trace_get_run"),
    },
    {
      name: "trace_reconstruct_history",
      description:
        "Reconstruct the full history the model saw at the start of a given run, by chaining all earlier runs "
        + "(handles the legacy inline-context format).",
      parameters: params({ trace_path: TRACE_PATH, run_id: RUN_ID }),
      output: TEXT_OUTPUT,
      async execute(args) {
        const { trace_path, run_id } = args as { trace_path: string; run_id: string };
        const history = await reconstructHistory(trace_path, run_id);
        return { text: `history length: ${history.length}\n${JSON.stringify(history.slice(-50), null, 2)}` };
      },
      presentCall: card("trace_reconstruct_history"),
    },
    {
      name: "trace_system_prompt",
      description: "Get the system prompt of a session trace (dedicated system_prompt record, legacy inline fallback).",
      parameters: params({ trace_path: TRACE_PATH }),
      output: TEXT_OUTPUT,
      async execute(args) {
        const prompt = await getSystemPrompt((args as { trace_path: string }).trace_path);
        return { text: prompt ?? "no system prompt found" };
      },
      presentCall: card("trace_system_prompt"),
    },
  ];
}
