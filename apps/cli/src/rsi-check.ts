import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { checkProject } from "./rsi-project.js";
import type { ProjectCheck } from "./rsi-project.js";

/** Submitting only ends the current execution round; quality is still decided by the isolated holdout acceptance. */
export function projectCheckTool(snapshot: () => Promise<Record<string, string>>, checks: ProjectCheck[]): ToolDefinition {
  return { name: "project_check", description: "Run fixed public checks. Set finish=true when the task is ready to submit; passing public checks ends this turn. Independent acceptance remains private.",
    parameters: { type: "object", properties: { finish: { type: "boolean" } }, additionalProperties: false },
    output: { schema: { type: "object", additionalProperties: false, required: ["sourceDigest", "passed", "total", "results"], properties: {
      sourceDigest: { type: "string" }, passed: { type: "integer" }, total: { type: "integer" },
      results: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "passed"], properties: {
        id: { type: "string" }, passed: { type: "boolean" }, error: { type: "string" },
      } } },
    } },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(args, execution) {
      const report = await checkProject(await snapshot(), checks, execution.signal);
      if ((args as { finish?: boolean }).finish === true) {
        if (report.passed !== report.total) throw new Error(`Public checks failed: ${JSON.stringify(report)}`);
        execution.concludeTurn();
      }
      return report;
    },
  };
}
