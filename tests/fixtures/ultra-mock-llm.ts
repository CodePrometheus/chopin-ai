import type { Context } from "@deepseek-ai/cordis";
import {
  ToolCallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";

const LOW = ReasoningEffortId("low");
const MAX = ReasoningEffortId("max");

export const ultraTrace: {
  requests: Array<{
    sessionId?: string;
    provider: string;
    model: string;
    effort?: string;
    ultraTool: boolean;
    system?: string;
    toolNames: string[];
  }>;
  activeWorkers: number;
  maxConcurrentWorkers: number;
} = {
  requests: [],
  activeWorkers: 0,
  maxConcurrentWorkers: 0,
};

export function resetUltraTrace(): void {
  ultraTrace.requests.length = 0;
  ultraTrace.activeWorkers = 0;
  ultraTrace.maxConcurrentWorkers = 0;
}

async function* text(value: string): AsyncIterable<StreamChunk> {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text: value };
  yield { type: "block-end", index: 0, block: { type: "text", text: value } };
  yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
  yield { type: "finish", reason: { kind: "stop" } };
}

async function* delegate(): AsyncIterable<StreamChunk> {
  const id = ToolCallId("ultra-e2e-delegate");
  const args = JSON.stringify({
    tasks: [
      { description: "inspect alpha", prompt: "Inspect alpha independently and return one evidence-backed sentence." },
      { description: "inspect beta", prompt: "Inspect beta independently and return one evidence-backed sentence." },
    ],
  });
  yield { type: "block-start", index: 0, blockType: "tool-call" };
  yield { type: "tool-call-delta", index: 0, id, name: "ultra_delegate", argumentsDelta: args };
  yield { type: "block-end", index: 0, block: { type: "tool-call", id, name: "ultra_delegate", arguments: args } };
  yield { type: "usage", usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
  yield { type: "finish", reason: { kind: "tool-calls" } };
}

class UltraMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: provider === "chopin-ultra-current" || provider === "chopin-ultra-active-next"
          ? [{ id: LOW, name: "Low" }, { id: MAX, name: "Max" }]
          : [{ id: LOW, name: "Low" }],
        defaultEffort: LOW,
      },
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const system = options.messages.findLast((message) => message.role === "system")?.content
      .filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const toolNames = options.tools?.map((tool) => tool.name) ?? [];
    const ultraTool = toolNames.includes("ultra_delegate");
    ultraTrace.requests.push({
      ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
      provider: options.provider,
      model: options.model,
      ...(options.reasoningEffort === undefined ? {} : { effort: String(options.reasoningEffort) }),
      ultraTool,
      ...(system === undefined ? {} : { system }),
      toolNames,
    });

    const ultraWorker = system?.includes("one bounded worker in a Chopin Ultra batch") === true;
    if (ultraWorker) {
      ultraTrace.activeWorkers += 1;
      ultraTrace.maxConcurrentWorkers = Math.max(ultraTrace.maxConcurrentWorkers, ultraTrace.activeWorkers);
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield* text(`worker ${String(options.sessionId)} completed`);
      } finally {
        ultraTrace.activeWorkers -= 1;
      }
      return;
    }

    if (!ultraTool) {
      yield* text(options.provider === "chopin-ultra-initial" ? "ordinary child complete" : "standard complete");
      return;
    }

    const answered = options.messages.some((message) => message.role === "tool" && message.toolCallId === "ultra-e2e-delegate");
    if (!answered) {
      yield* delegate();
      return;
    }
    yield* text("ultra synthesis complete");
  }
}

export const name = "chopin-ultra-mock-llm";
export const inject = ["llm", "tools"];

export function apply(ctx: Context): void {
  ctx.llm.registerAdapter([
    "chopin-ultra-initial",
    "chopin-ultra-current",
    "chopin-ultra-active-next",
    "chopin-ultra-next",
  ], new UltraMockAdapter());
  for (const [toolName, description] of [
    ["subagent", "Fixture delegation tool that Ultra must hide from its parent and workers."],
    ["read", "Fixture safe tool that remains available to Ultra workers."],
  ] as const) {
    ctx.tools.register({
      name: toolName,
      description,
      parameters: { type: "object", additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { called: { type: "boolean" } },
          required: ["called"],
        },
        render: () => [{ type: "text", text: `fixture ${toolName} called` }],
      },
      execute() {
        return Promise.resolve({ called: true });
      },
    });
  }
}
