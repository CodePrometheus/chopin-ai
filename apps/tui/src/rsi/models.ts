import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { retryAssistantCall, type Api, type AssistantMessage, type Model, type Models, type RetryPolicy } from "@earendil-works/pi-ai";
import type { Complete } from "@chopin-ai/core";

const WEEK_MS = 7 * 24 * 60 * 60_000;

/** What the loop has spent, as JSON Lines of US dollars at list prices, and the most it may spend in a week. */
export class Budget {
  readonly path: string;
  readonly weeklyUsd: number;

  constructor(path: string, weeklyUsd: number) {
    this.path = path;
    this.weeklyUsd = weeklyUsd;
  }

  /** Spent over the last seven days. */
  async spent(now = Date.now()): Promise<number> {
    const text = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as { at: number; usd: number })
      .filter((charge) => now - charge.at < WEEK_MS).reduce((sum, charge) => sum + charge.usd, 0);
  }

  async charge(usd: number, now = Date.now()): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify({ at: now, usd })}\n`);
  }

  /** Throws once the week's budget is spent, so the loop stops before its next call. */
  async check(): Promise<void> {
    const spent = await this.spent();
    if (spent >= this.weeklyUsd) throw new BudgetSpent(spent, this.weeklyUsd);
  }
}

export class BudgetSpent extends Error {
  constructor(spent: number, weekly: number) {
    super(`the loop has spent $${spent.toFixed(2)} of its $${weekly.toFixed(2)} for the week`);
  }
}

/** Transient failures, such as a dropped connection, are tried again for about a minute. */
const RETRY: RetryPolicy = { enabled: true, maxRetries: 5, baseDelayMs: 2_000 };

/**
 * One model call of the loop: refused once the budget is spent, tried again on a transient failure, and charged for
 * every attempt. A call that still fails throws, so no judge ever reads a failed reply as the model's answer.
 */
export async function paidCall(budget: Budget, call: () => Promise<AssistantMessage>): Promise<AssistantMessage> {
  await budget.check();
  const reply = await retryAssistantCall(async () => {
    const attempt = await call();
    await budget.charge(attempt.usage.cost.total);
    return attempt;
  }, RETRY, undefined);
  if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? `the model's call ended: ${reply.stopReason}`);
  return reply;
}

/** One prompt, one reply, from `model`, as a paid call. */
export function completer(models: Models, model: Model<Api>, budget: Budget): Complete {
  return async (prompt) => {
    const reply = await paidCall(budget, () => models.completeSimple(model, { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }));
    return reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  };
}

/** The model `provider/id` names among `models`. */
export function namedModel(models: Models, name: string): Model<Api> {
  const slash = name.indexOf("/");
  const model = slash <= 0 ? undefined : models.getModel(name.slice(0, slash), name.slice(slash + 1));
  if (model === undefined) throw new Error(`no model ${name}; it is named as provider/model, signed in with /login`);
  return model;
}
