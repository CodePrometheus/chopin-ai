import { LlmError } from "@deepseek-ai/dsh-llm";
import type { FinishReason, ToolSchema } from "@deepseek-ai/dsh-llm";
import { improvementDigest } from "@chopin/evolution";
import { scrub } from "@chopin/ledger";

export function assertGenerationFinish(finished: boolean, reason: FinishReason): void {
  if (!finished) throw new LlmError("Generation ended without a finish event", "INCOMPLETE_GENERATION");
  if (reason.kind === "error" || reason.kind === "aborted") throw new LlmError(scrub(reason.failure.message), reason.failure.code);
  if (reason.kind !== "stop" && reason.kind !== "tool-calls") throw new LlmError(`Generation ended with ${reason.kind}`, "INCOMPLETE_GENERATION");
}

export const SOURCE_EDIT_TOOL = "revise_capability";
export class SourceProposalError extends Error {}

export function sourceEditSchema(source: string): ToolSchema {
  const maximum = source.split("\n").length;
  return { name: SOURCE_EDIT_TOOL, description: "Propose replacements in the supplied immutable source. Line numbers are one-based and inclusive; all edits refer to the original source and must not overlap.",
    parameters: { type: "object", additionalProperties: false, required: ["edits"], properties: {
      edits: { type: "array", minItems: 1, maxItems: 16, items: { type: "object", additionalProperties: false,
        required: ["startLine", "endLine", "text"], properties: {
          startLine: { type: "integer", minimum: 1, maximum }, endLine: { type: "integer", minimum: 1, maximum },
          text: { type: "string", maxLength: 64_000 },
        } } },
    } } };
}

/** Every edit is validated against the same original text first, so none is partially applied or shifted by earlier edits. */
export function applySourceEdits(source: string, expectedDigest: string, value: unknown): string {
  if (improvementDigest(source) !== expectedDigest) throw new SourceProposalError("Source edit preimage changed");
  const input = value as { edits?: Array<{ startLine: number; endLine: number; text: string }> };
  if (!input || typeof input !== "object" || Object.keys(input).length !== 1 || !Array.isArray(input.edits)
    || input.edits.length < 1 || input.edits.length > 16) throw new SourceProposalError("Invalid source edit proposal");
  const lines = source.split("\n");
  if (input.edits.some(edit => !edit || typeof edit !== "object")) throw new SourceProposalError("Invalid source edit entry");
  const edits = [...input.edits].sort((left, right) => left.startLine - right.startLine);
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index]!;
    if (!edit || Object.keys(edit).length !== 3 || !Number.isSafeInteger(edit.startLine) || !Number.isSafeInteger(edit.endLine)
      || edit.startLine < 1 || edit.endLine < edit.startLine || edit.endLine > lines.length
      || typeof edit.text !== "string" || edit.text.length > 64_000 || (index > 0 && edits[index - 1]!.endLine >= edit.startLine)) {
      throw new SourceProposalError("Source edit ranges are invalid or overlapping");
    }
  }
  for (const edit of edits.reverse()) lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, edit.text);
  const updated = lines.join("\n");
  if (!updated.trim() || updated.length > 64_000 || updated === source) throw new SourceProposalError("Source edits did not produce a bounded distinct implementation");
  return updated;
}
