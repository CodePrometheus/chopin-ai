import type { Draft } from "@earendil-works/chord/delta";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Models, UserMessage } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  CompactionTask,
  defineEntry,
  defineExtension,
  GenerationTask,
  hook,
  ProviderDoc,
  UsageDoc,
  type ConversationId,
  type EntryId,
  type Extension,
  type Harness,
  type TaskId,
  type UsageState,
} from "@earendil-works/pi-durable";

/** Where a conversation was compacted for being idle; the model never reads it. */
export const IdleCompactionEntry = defineEntry("chopin.idle-compaction");

/** How much of its prompt cache's lifetime an idle conversation waits before it is compacted. */
const WAIT = 0.9;

/** Below this much context, a summary costs more than rewriting the cache on return would. */
const WORTH_TOKENS = 64_000;

const PROMPT = `Summarize this conversation so far as a checkpoint another model will continue the work from. Do not call tools and \
do not answer anything in it; reply with the summary alone. If it starts with an earlier summary, fold that in.

Use this format:

## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context

Keep each section short. Preserve exact file paths, function names and error messages.`;

export interface IdleCompactionOptions {
  /** The models the harness asks, with its credentials. */
  models: Models;
  /** Whether people come back to `conversation`; no other is compacted for being idle. */
  eligible(conversation: ConversationId): Promise<boolean>;
  /** Current dispatch permission, checked again after provider request assembly. */
  authorize?(conversation: ConversationId, context: Context): Promise<boolean>;
  /** Activity notification for a host's wake and retention projection. */
  changed?(): void;
  report?: (error: unknown) => void;
}

/**
 * Compacts a conversation left idle just before its prompt cache expires. The summary is asked for in a request that
 * repeats the conversation's own and adds one message, so the provider reads all but that from its cache.
 */
export class IdleCompaction {
  readonly extension: Extension;
  readonly #options: IdleCompactionOptions;
  /** Each conversation's timer, and what stops the compaction it starts. */
  readonly #waiting = new Map<ConversationId, { timer: NodeJS.Timeout; stop: AbortController }>();
  /** Summaries ready to be placed, each with the newest entry it covers. */
  readonly #summaries = new Map<ConversationId, { summary: string; tail: EntryId }>();
  readonly #work = new Set<Promise<void>>();
  readonly #placing = new Set<TaskId>();
  #harness: Harness | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(options: IdleCompactionOptions) {
    this.#options = options;
    this.extension = defineExtension({
      name: "chopin-idle-compaction",
      hooks: [
        hook(GenerationTask, {
          beforeRequest: (_request, api) => void this.cancel(api.conversationId),
          afterResponse: (message, api) => this.#schedule(api.conversationId, message),
        }),
        hook(CompactionTask, {
          beforeCompact: (compaction, api) => {
            const ready = this.#summaries.get(api.conversationId);
            if (ready === undefined || compaction.instructions !== undefined) return undefined;
            this.#summaries.delete(api.conversationId);
            // An entry newer than the summarized request is not in the summary.
            return compaction.entries.every((entry) => entry.id <= ready.tail) ? { summary: ready.summary } : { decline: true };
          },
        }),
      ],
    });
  }

  /** Starts on `harness`, which runs this extension. */
  attach(harness: Harness): void {
    this.#harness = harness;
  }

  /** Drops what is scheduled for `conversation`, and stops its compaction if one is asking for a summary. */
  cancel(conversation: ConversationId): void {
    const waiting = this.#waiting.get(conversation);
    if (waiting === undefined) return;
    this.#waiting.delete(conversation);
    clearTimeout(waiting.timer);
    waiting.stop.abort();
    this.#options.changed?.();
  }

  /** Nonpersistent timers and in-flight work require this process to remain available. */
  get active(): boolean { return this.#waiting.size > 0 || this.#work.size > 0; }

  /** Cancels optional work whose conversations no longer have an active delegation. */
  cancelAll(): void {
    for (const conversation of [...this.#waiting.keys()]) this.cancel(conversation);
  }

  /** Stops new requests and drains existing summaries before their storage can close. */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.cancelAll();
    await Promise.all([...this.#placing].map((task) => this.#harness!.abortTask(task, BACKGROUND_CONTEXT)));
    await Promise.allSettled([...this.#work]);
  }

  /** After a final answer worth compacting, from a model whose cache lifetime is known and that did use its cache. */
  #schedule(conversation: ConversationId, answer: AssistantMessage): void {
    if (this.#closed || answer.stopReason !== "stop") return;
    if (calculateContextTokens(answer.usage) < WORTH_TOKENS || answer.usage.cacheRead + answer.usage.cacheWrite === 0) return;
    // Requests keep the default retention, the short one.
    const lifetime = this.#options.models.getModel(answer.provider, answer.model)?.promptCache?.short;
    if (lifetime === undefined) return;
    const delay = answer.timestamp + lifetime * 1_000 * WAIT - Date.now();
    if (delay <= 0) return;
    this.cancel(conversation);
    const stop = new AbortController();
    const timer = setTimeout(() => {
      const work = this.#compact(conversation, answer, stop.signal);
      this.#work.add(work);
      void work
        .catch((error: unknown) => void (this.#closed || stop.signal.aborted || this.#options.report?.(error)))
        .finally(() => {
          this.#work.delete(work);
          if (this.#waiting.get(conversation)?.stop === stop) this.#waiting.delete(conversation);
          this.#options.changed?.();
        });
    }, delay);
    timer.unref();
    this.#waiting.set(conversation, { timer, stop });
    this.#options.changed?.();
  }

  async #compact(id: ConversationId, answer: AssistantMessage, signal: AbortSignal): Promise<void> {
    const harness = this.#harness;
    if (harness === undefined || !(await this.#options.eligible(id))) return;
    const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
    if (!(await this.#authorized(id, context))) return;
    const conversation = await harness.conversation(id, context);
    if (conversation === undefined) return;
    const [view, agent, provider] = await Promise.all([
      conversation.context(context),
      conversation.agent(context),
      harness.snapshot(ProviderDoc, id, context),
    ]);
    // Only while that answer is still the last word, with the model that gave it, is its cache this request's.
    const last = view.messages.at(-1);
    const tail = view.entries.at(-1);
    const model = agent.model === undefined ? undefined : this.#options.models.getModel(agent.model.provider, agent.model.modelId);
    if (last?.role !== "assistant" || last.timestamp !== answer.timestamp || tail === undefined || provider === undefined) return;
    if (model === undefined || model.provider !== answer.provider || model.id !== answer.model) return;
    const ask: UserMessage = { role: "user", content: [{ type: "text", text: PROMPT }], timestamp: Date.now() };
    context.abortSignal?.throwIfAborted();
    const reply = await this.#options.models.completeSimple(model, { messages: [...view.messages, ask] }, {
      signal,
      sessionId: provider.sessionId,
      ...(this.#options.authorize !== undefined && { onPayload: async () => {
        if (!(await this.#authorized(id, context))) throw new Error("background model dispatch is no longer authorized");
      } }),
      ...(agent.thinkingLevel === "off" ? {} : { reasoning: agent.thinkingLevel }),
    });
    await conversation.commit(async (tx) => charge(await tx.doc(UsageDoc, id), reply), BACKGROUND_CONTEXT);
    const summary = summaryOf(reply);
    if (summary === undefined || signal.aborted || this.#closed) return;
    // Past this point the summary is placed whoever comes back, so nothing waits on `signal`.
    this.#summaries.set(id, { summary, tail: tail.id });
    let placing: TaskId | undefined;
    try {
      const task = await conversation.compact(undefined, BACKGROUND_CONTEXT);
      placing = task;
      this.#placing.add(placing);
      if (this.#closed) await harness.abortTask(placing, BACKGROUND_CONTEXT);
      const settled = await harness.waitForTask(task, BACKGROUND_CONTEXT);
      const outcome = settled.state.outcome;
      if (outcome.status === "completed" && (outcome.result.entryId !== undefined || outcome.result.submissionId !== undefined)) {
        await conversation.submit({ type: "write", entry: { kind: IdleCompactionEntry.kind } }, BACKGROUND_CONTEXT);
      }
    } finally {
      if (placing !== undefined) this.#placing.delete(placing);
      this.#summaries.delete(id);
    }
  }

  #authorized(id: ConversationId, context: Context): Promise<boolean> {
    return this.#options.authorize?.(id, context) ?? Promise.resolve(true);
  }
}

/** The text of a clean stop that calls no tool; anything else is no summary. */
function summaryOf(reply: AssistantMessage): string | undefined {
  if (reply.stopReason !== "stop" || reply.content.some((content) => content.type === "toolCall")) return undefined;
  const text = reply.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("\n").trim();
  return text === "" ? undefined : text;
}

/** Adds what `reply` used to the conversation's ledger, under its model as its answers are. */
function charge(ledger: Draft<UsageState>, reply: AssistantMessage): void {
  const key = `${reply.provider}/${reply.model}`;
  const total = ledger.models[key];
  if (total === undefined) return void (ledger.models[key] = structuredClone(reply.usage));
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[field] += reply.usage[field];
  for (const field of ["cacheWrite1h", "reasoning"] as const) {
    const used = reply.usage[field];
    if (used !== undefined) total[field] = (total[field] ?? 0) + used;
  }
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[field] += reply.usage.cost[field];
}
