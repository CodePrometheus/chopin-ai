import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDef, ToolsetDef } from "./schema.js";

const execFileAsync = promisify(execFile);

const DEFAULT_OUTPUT_BUDGET = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface ToolRunResult {
  ok: boolean;
  /** Output clipped to budget; when clipped, `clipped` is set and a marker is appended. */
  output: string;
  clipped: boolean;
  exitCode: number | null;
}

/**
 * Filtering belongs on the query side (grep/jq); the budget here is the last line of
 * defense against one chatty tool flooding the model context.
 */
function applyBudget(text: string, budgetBytes: number): { output: string; clipped: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= budgetBytes) return { output: text, clipped: false };
  const head = buf.subarray(0, budgetBytes).toString("utf8");
  return {
    output: `${head}\n…[clipped at ${budgetBytes} bytes of ${buf.byteLength}; narrow the query instead of paging]`,
    clipped: true,
  };
}

function substitute(
  command: string,
  args: Record<string, string>,
  tool: ToolDef,
  vars: Record<string, string>,
): string {
  // Expand config variables ${VAR} first (project constants such as the repo name), then the model-supplied {{param}}
  const withVars = command.replace(/\$\{(\w+)\}/g, (raw, name: string) => vars[name] ?? raw);
  return withVars.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    const value = args[name];
    if (value === undefined) {
      if (tool.params?.[name]?.required !== false) throw new Error(`tool ${tool.name}: missing param ${name}`);
      return "";
    }
    if (value.startsWith("-") && tool.params?.[name]?.allowLeadingDash !== true) {
      throw new Error(`tool ${tool.name}: param ${name} must not start with "-"; the command would read it as an option`);
    }
    // Wrap in POSIX sh single quotes; embedded single quotes use close-escape-reopen.
    return `'${value.replace(/'/g, `'\\''`)}'`;
  });
}

export class ToolsetExecutor {
  private prereqCache = new Map<string, boolean>();

  /** vars come from project config and fill the ${VAR} placeholders in toolset commands. */
  constructor(private readonly vars: Record<string, string> = {}) {}

  /** Prerequisites are checked once per toolset; an unavailable set fails explicitly, never silently. */
  async isAvailable(toolset: ToolsetDef): Promise<boolean> {
    const cached = this.prereqCache.get(toolset.name);
    if (cached !== undefined) return cached;
    let ok = true;
    for (const prereq of toolset.prerequisites ?? []) {
      try {
        await execFileAsync("sh", ["-c", prereq.command], { timeout: 15_000 });
      } catch {
        ok = false;
        break;
      }
    }
    this.prereqCache.set(toolset.name, ok);
    return ok;
  }

  async run(tool: ToolDef, args: Record<string, string>): Promise<ToolRunResult> {
    const command = substitute(tool.command, args, tool, this.vars);
    const budget = tool.outputBudgetBytes ?? DEFAULT_OUTPUT_BUDGET;
    try {
      const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
        timeout: tool.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", ALL_PROXY: "", all_proxy: "" },
      });
      const merged = stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout;
      const { output, clipped } = applyBudget(merged, budget);
      return { ok: true, output, clipped, exitCode: 0 };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
      const merged = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
      const { output, clipped } = applyBudget(merged, budget);
      return { ok: false, output, clipped, exitCode: typeof e.code === "number" ? e.code : null };
    }
  }
}
