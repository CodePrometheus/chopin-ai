/**
 * Declarative toolset schema (design borrowed from an open-source incident-investigation agent):
 * a data source is a YAML file, not code, so adding one never touches core.
 */

export interface ToolParamDef {
  description: string;
  required?: boolean;
  /**
   * The value is the argument of the option right before it (`-e {{pattern}}`), so a leading `-` is
   * data. Every other param refuses a leading `-`, which the command would parse as a switch.
   */
  allowLeadingDash?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  /** Shell command with {{param}} placeholders. */
  command: string;
  params?: Record<string, ToolParamDef>;
  /** Byte cap on output handed to the model; the default budget applies when omitted. */
  outputBudgetBytes?: number;
  timeoutMs?: number;
}

export interface ToolsetDef {
  name: string;
  description: string;
  /** Prerequisite commands: the toolset is offered to the model only when all exit 0. */
  prerequisites?: Array<{ command: string }>;
  tools: ToolDef[];
}

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
/** An option token (`-e`, `--search`, `--grep=`) ending right where the placeholder starts. */
const OPTION_BEFORE = /(?:^|\s)--?[A-Za-z][\w-]*(?:\s+|=)$/;

export function validateToolset(raw: unknown, sourcePath: string): ToolsetDef {
  const ts = raw as Partial<ToolsetDef>;
  if (!ts || typeof ts.name !== "string" || !ts.name) {
    throw new Error(`${sourcePath}: toolset missing name`);
  }
  if (typeof ts.description !== "string") {
    throw new Error(`${sourcePath}: toolset ${ts.name} missing description`);
  }
  if (!Array.isArray(ts.tools) || ts.tools.length === 0) {
    throw new Error(`${sourcePath}: toolset ${ts.name} has no tools`);
  }
  for (const tool of ts.tools) {
    if (!tool.name || !tool.description || !tool.command) {
      throw new Error(`${sourcePath}: toolset ${ts.name} has a tool missing name/description/command`);
    }
    // ${VAR} is a config-injected constant and is not validated here; only the model-filled {{param}} is
    for (const match of tool.command.matchAll(PLACEHOLDER)) {
      const p = match[1]!;
      const def = tool.params?.[p];
      if (!def) {
        throw new Error(`${sourcePath}: tool ${tool.name} uses {{${p}}} but does not declare it in params`);
      }
      if (def.allowLeadingDash !== true) continue;
      const before = tool.command.slice(0, match.index);
      const after = tool.command.slice(match.index + match[0].length);
      if (!OPTION_BEFORE.test(before) || !/^(?:\s|$)/.test(after)) {
        throw new Error(
          `${sourcePath}: tool ${tool.name} allows a leading dash in {{${p}}}, so it must directly follow an option such as -e`,
        );
      }
    }
  }
  return ts as ToolsetDef;
}
