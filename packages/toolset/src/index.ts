/**
 * Register declarative toolsets as tools the model can see.
 *
 * Adding a data source is always just adding one YAML file -- command, params,
 * prerequisite checks and output budget all live in that file, and no code changes.
 * This is where chopin's "onboarding a project is config only" constraint mostly lives.
 *
 * A toolset whose prerequisites fail is not registered at all, and the log names it.
 * Skipping silently would make the model believe the capability does not exist and
 * detour to a worse conclusion instead of telling you what is missing.
 *
 * Belongs to the agent plane: written into each mission's preset, so different
 * missions get different tool surfaces. Registering at the host layer would show every
 * mission the same set and the isolation would be gone.
 *
 * @module @chopin/toolset
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { JsonSchemaNode, ToolDefinition } from "@deepseek-ai/dsh-tools";

import { ToolsetExecutor } from "./executor.js";
import { loadToolsets } from "./loader.js";
import type { ToolDef } from "./schema.js";

type JsonValue = Parameters<ToolDefinition["output"]["render"]>[1];

export { loadToolsets } from "./loader.js";
export { ToolsetExecutor } from "./executor.js";
export type { ToolRunResult } from "./executor.js";
export { validateToolset } from "./schema.js";
export type { ToolDef, ToolParamDef, ToolsetDef } from "./schema.js";

export const name = "chopin-toolset";
export const inject = ["tools"];

export interface Config {
  /** Directories holding *.yaml toolset definitions. Relative paths resolve against the process cwd. */
  dirs: string[];
  /**
   * Which toolsets this mission wants (by the YAML `name`). Empty means all in the
   * directories. Missions have different tool surfaces anyway, and two toolsets may
   * define a tool of the same name (engineering and chopin-self both have git_diff)
   * -- swallowing a whole directory would collide at registration.
   */
  toolsets: string[];
  /** Project constants filling the `${VAR}` placeholders in commands. Secrets go through environment variables, never here. */
  vars: Record<string, string>;
}

export const Config: z<Config> = z.object({
  dirs: z.array(z.string()).default([]),
  toolsets: z.array(z.string()).default([]),
  vars: z.dict(z.string()).default({}),
});

const OUTPUT_SCHEMA: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "output", "clipped", "exitCode"],
  properties: {
    ok: { type: "boolean" },
    output: { type: "string" },
    clipped: { type: "boolean" },
    exitCode: { type: "integer" },
  },
};

/** Translate declared params into the JSON Schema the model sees. Declarative tool params are always strings. */
function parametersOf(tool: ToolDef): Record<string, unknown> {
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];
  for (const [param, def] of Object.entries(tool.params ?? {})) {
    properties[param] = { type: "string", description: def.description };
    if (def.required !== false) required.push(param);
  }
  return { type: "object", additionalProperties: false, required, properties };
}

function render(_args: unknown, value: JsonValue): ContentBlock[] {
  const result = value as unknown as { ok: boolean; output: string; exitCode: number };
  const head = result.ok ? "" : `command failed (exit ${result.exitCode})\n`;
  return [{ type: "text", text: `${head}${result.output}` }];
}

function define(tool: ToolDef, executor: ToolsetExecutor): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: parametersOf(tool),
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args) {
      const result = await executor.run(tool, args as Record<string, string>);
      if (!result.ok) {
        throw new HarnessError(`command failed (exit ${result.exitCode ?? "unknown"})\n${result.output}`, "COMMAND_FAILED");
      }
      return { ...result, exitCode: result.exitCode ?? -1 };
    },
    presentCall: (args) => ({
      card: "generic",
      title: tool.name,
      kind: "other",
      rawInput: args as JsonValue,
    }),
  };
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  // Directories often come from env expressions and are empty strings when unset -- that is "not configured", not "configured an empty directory".
  const dirs = config.dirs.filter((dir) => dir.trim() !== "");
  if (dirs.length === 0) {
    ctx.logger.warn("no toolset directory configured; declarative tools are unavailable");
    return;
  }
  const available = await loadToolsets(dirs);
  const wanted = new Set(config.toolsets);
  const missing = [...wanted].filter((name) => !available.some((toolset) => toolset.name === name));
  if (missing.length > 0) {
    // A named toolset does not exist: this is a config error; skipping silently would make gate-referenced tools vanish.
    throw new Error(`toolset(s) not found in ${dirs.join(", ")}: ${missing.join(", ")}`);
  }
  const toolsets = wanted.size === 0 ? available : available.filter((toolset) => wanted.has(toolset.name));
  const executor = new ToolsetExecutor(config.vars);

  for (const toolset of toolsets) {
    if (!(await executor.isAvailable(toolset))) {
      ctx.logger.warn(
        "toolset %s skipped: prerequisites not met (%d tool(s) unavailable)",
        toolset.name,
        toolset.tools.length,
      );
      continue;
    }
    for (const tool of toolset.tools) ctx.tools.register(define(tool, executor));
  }
}
