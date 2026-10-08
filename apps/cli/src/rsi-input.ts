import { assertExecutionContext, CONTEXT_SELECTOR_TOOL, IMPROVER_TOOL, improvementDigest } from "@chopin/evolution";
import type { ExecutionContext, ImprovementInput, JsonValue } from "@chopin/evolution";
import { scrub } from "@chopin/ledger";
import type { ProjectTask } from "./rsi-project.js";
import type { TrialContextSnapshot } from "./rsi-context.js";

export const PROJECT_CORE_TOOLS = ["read", "write", "edit", "project_check"];

export function projectEnvironment(task: ProjectTask, context: TrialContextSnapshot, limit: number, used: number,
  additionalTools: readonly string[] = []): ExecutionContext {
  const value: ExecutionContext = { objective: task.objective, taskKinds: task.taskKinds ?? [],
    files: [...new Set([...Object.keys(task.files), ...task.writable])], writable: [...new Set(task.writable)],
    tools: [...new Set([...PROJECT_CORE_TOOLS, ...(context.entries.length ? ["experience_read"] : []),
      ...additionalTools.filter(name => name !== IMPROVER_TOOL && name !== CONTEXT_SELECTOR_TOOL)])],
    sourceIds: context.entries.map(entry => entry.id), budget: { limit, remaining: Math.max(0, limit - used) } };
  assertExecutionContext(value); return value;
}

export function improvementEvidence(feedback: readonly unknown[]): NonNullable<ImprovementInput["evidence"]> {
  const evidence = feedback.map(item => {
    const value = JSON.parse(scrub(JSON.stringify(item))) as JsonValue;
    return { digest: improvementDigest(value), value };
  });
  if (evidence.length > 8 || JSON.stringify(evidence).length > 32_000) throw new Error("Improvement evidence exceeds the planning contract");
  return evidence;
}

/** Only declared inputs and real artifacts are assembled; session transcripts and holdout answers are never read. */
export function projectEvidence(task: ProjectTask, output: Record<string, string>) {
  const sources: Array<{ path: string; inputDigest: string; outputDigest: string; writable: boolean;
    input?: string; output?: string; redacted?: boolean }> = [];
  for (const path of Object.keys(task.files).sort((left, right) => Number(task.writable.includes(left)) - Number(task.writable.includes(right)) || left.localeCompare(right))) {
    const input = task.files[path]!; const result = output[path] ?? "";
    const identity = { path, inputDigest: improvementDigest(input), outputDigest: improvementDigest(result), writable: task.writable.includes(path) };
    const selected = { ...identity, input: scrub(input), ...(result !== input ? { output: scrub(result) } : {}),
      ...(scrub(input) !== input || scrub(result) !== result ? { redacted: true } : {}) };
    sources.push(JSON.stringify([...sources, selected]).length <= 8_000 ? selected : identity);
  }
  return { objective: task.objective, sources };
}
