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

async function* callTool(sequence: number): AsyncIterable<StreamChunk> {
  const callId = ToolCallId(`evolution-e2e-echo-${sequence}`);
  const args = JSON.stringify({ text: "learned capability works" });
  yield { type: "block-start", index: 0, blockType: "tool-call" };
  yield { type: "tool-call-delta", index: 0, id: callId, name: "learned_echo", argumentsDelta: args };
  yield { type: "block-end", index: 0, block: { type: "tool-call", id: callId, name: "learned_echo", arguments: args } };
  yield { type: "usage", usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
  yield { type: "finish", reason: { kind: "tool-calls" } };
}

class EvolutionMockAdapter extends LlmAdapter {
  private requestTool = true;
  private sequence = 0;

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: OFF, name: "Off" }], defaultEffort: OFF } };
  }

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.requestTool) {
      this.requestTool = false;
      this.sequence += 1;
      yield* callTool(this.sequence);
      return;
    }
    this.requestTool = true;
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "done" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "done" } };
    yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

export const name = "chopin-evolution-mock-llm";
export const inject = ["llm"];

export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(["chopin-evolution-mock"], new EvolutionMockAdapter());
}
