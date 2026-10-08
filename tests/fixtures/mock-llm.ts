/**
 * Fake model for e2e: follows a script step by step, built to force the gates' behavior out.
 *
 *   1. submit without searching anything  -> the gate must reject and name the missing one
 *   2. search the ledger                  -> succeeds
 *   3. submit again                       -> must pass this time
 *   4. submit to an exit whose gate can never be satisfied -> must report a configuration error, not a plain rejection
 *   5. write the ledger                   -> no approval service in the composition, ask must degrade to a rejection
 *   6. wrap up
 *
 * The point is that steps 1 and 3 use the same tool with the same arguments: the only
 * variable is the tool call in between. Unless the gate really reads the session log, these
 * two steps cannot differ.
 *
 * Erasable-syntax TypeScript only: the Loader runs it in lib mode under Node's native type stripping.
 */

import type { Context } from "@deepseek-ai/cordis";
import {
  ToolCallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";

const OFF = ReasoningEffortId("off");

const REPORT_ARGS = JSON.stringify({
  problem: "users see the app hang on startup",
  rootCause: "the delivery cron re-enqueues a sentinel row it never clears",
});

const LEDGER_ARGS = JSON.stringify({ error: "ETIMEDOUT connecting to 10.0.0.4:5432" });

/** One tool call step. */
async function* callTool(id: string, name: string, args: string): AsyncIterable<StreamChunk> {
  const callId = ToolCallId(id);
  yield { type: "block-start", index: 0, blockType: "tool-call" };
  yield { type: "tool-call-delta", index: 0, id: callId, name, argumentsDelta: args };
  yield { type: "block-end", index: 0, block: { type: "tool-call", id: callId, name, arguments: args } };
  yield { type: "usage", usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
  yield { type: "finish", reason: { kind: "tool-calls" } };
}

class GateMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: OFF, name: "Off" }], defaultEffort: OFF },
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // The number of tool results already returned is the position in the script.
    const answered = options.messages.filter(message => message.role === "tool").length;

    if (answered === 0) {
      yield* callTool("gate-e2e-submit-1", "submit_report", REPORT_ARGS);
      return;
    }
    if (answered === 1) {
      yield* callTool("gate-e2e-ledger", "ledger_search", LEDGER_ARGS);
      return;
    }
    if (answered === 2) {
      yield* callTool("gate-e2e-submit-2", "submit_report", REPORT_ARGS);
      return;
    }
    if (answered === 3) {
      yield* callTool("gate-e2e-broken", "submit_broken", JSON.stringify({ problem: "anything" }));
      return;
    }
    if (answered === 4) {
      const args = JSON.stringify({
        id: "cron-sentinel-leak",
        errorString: "ETIMEDOUT connecting to 10.0.0.4:5432",
        rootCause: "the delivery cron re-enqueues a sentinel row it never clears",
        anchoredTag: "app-1.3.3",
        status: "open",
      });
      yield* callTool("gate-e2e-ledger-write", "ledger_write", args);
      return;
    }

    const reply = "done";
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: reply };
    yield { type: "block-end", index: 0, block: { type: "text", text: reply } };
    yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

export const name = "chopin-gate-mock-llm";
export const inject = ["llm"];

export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(["chopin-gate-mock"], new GateMockAdapter());
}
