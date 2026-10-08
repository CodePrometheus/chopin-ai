/**
 * The core declaration of a mission (task type): what shape it produces, and what
 * must have been done before submitting.
 *
 * Both live on the same preset config line and are never split -- the gate guards
 * exactly this submission action, and two lines would turn "who guards whom" into
 * an implicit convention in the config.
 *
 * A mission is not a chopin invention; it is a dsh agent preset: one preset patch in
 * the bundle, with its own toolset, prompt sections and scope isolation.
 * Adding a mission = adding a preset patch, in which this plugin takes one line.
 *
 * The output gets no session event of its own. The submission call's arguments
 * already land in full in `tool/call` and can be rebuilt from the log; another
 * event would be a second copy of the same fact.
 *
 * @module @chopin/report
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createGateGuard } from "@chopin/gate";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { JsonSchemaNode, ToolDefinition } from "@deepseek-ai/dsh-tools";

type JsonValue = Parameters<ToolDefinition["output"]["render"]>[1];

export const name = "chopin-report";
// The guard goes through ctx.tools.guard() and lands in this line's scope; the status
// service is only for the UI and its absence does not weaken discipline, so no static inject.
export const inject = ["tools"];

/** Declaration of the submission tool: name, description for the model, and the output JSON Schema. */
export interface ReportToolConfig {
  name: string;
  description: string;
  /** Output shape, a JSON Schema with an object root, defined by the mission itself. */
  parameters: Record<string, unknown>;
}

/** Rule shape in config. Fields are mutable; assigning to the readonly fields of {@link GateRule} is the safe direction. */
export interface GateRuleConfig {
  id: string;
  description: string;
  satisfiedByTools: string[];
}

export interface Config {
  tool: ReportToolConfig;
  /** Rules that must be met before submitting; an empty array means this mission has no gate. */
  gates: GateRuleConfig[];
}

const GateRuleSchema: z<GateRuleConfig> = z.object({
  id: z.string().required(),
  description: z.string().required(),
  satisfiedByTools: z.array(z.string()).required(),
});

export const Config: z<Config> = z.object({
  tool: z.object({
    name: z.string().required(),
    description: z.string().required(),
    parameters: z.dict(z.any()).required(),
  }).required(),
  gates: z.array(GateRuleSchema).default([]),
});

/**
 * Confirmation returned to the model once the submission is accepted. Deliberately
 * does not echo the full output: that would put the same content in context twice
 * and waste budget.
 */
const OUTPUT_SCHEMA: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: ["accepted", "fields"],
  properties: {
    accepted: { type: "boolean" },
    fields: { type: "array", items: { type: "string" } },
  },
};

function render(_args: unknown, value: JsonValue): ContentBlock[] {
  const fields = (value as { fields: string[] }).fields;
  return [{ type: "text", text: `Report accepted with ${fields.length} field(s): ${fields.join(", ")}.` }];
}

export function apply(ctx: Context, config: Config): void {
  const { tool, gates } = config;

  // Register the gate first: with invalid rules this mission should have no submission
  // exit at all. The guard registers from this line's context, lands in its preset's
  // scope and dies with the line -- two generations of one preset each get their own
  // guard and never collide.
  if (gates.length > 0) {
    const registration = { guardedTool: tool.name, rules: gates };
    ctx.tools.guard(createGateGuard(registration));
    ctx.get("chopinGates")?.announce(registration);
  }

  const definition: ToolDefinition = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    output: { schema: OUTPUT_SCHEMA, render },
    execute(args) {
      // Reaching here means the gate let the call through -- the guard judges before execute, so denied calls never arrive.
      const fields = Object.keys(args as Record<string, unknown>).sort();
      return Promise.resolve({ accepted: true, fields });
    },
    presentCall: (args) => ({
      card: "generic",
      title: tool.name,
      kind: "other",
      rawInput: args as JsonValue,
    }),
  };

  ctx.tools.register(definition);
}
