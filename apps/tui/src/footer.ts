import { homedir } from "node:os";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "@earendil-works/pi-coding-agent";
import type { ConversationView, UsageState } from "@earendil-works/pi-durable";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { style } from "./theme.js";
import { oneRow } from "./transcript.js";

type Tone = "dim" | "red";

/**
 * Two rows under the editor, as pi has them: where the agent works, then how the conversation stands and what it has
 * used, with its model at the right.
 */
export class Footer implements Component {
  #where = "";
  #tone: Tone = "dim";
  #state = "";
  #model = "";

  setWhere(where: string): void {
    this.#where = where;
  }

  set(tone: Tone, state: string, model = ""): void {
    this.#tone = tone;
    this.#state = state;
    this.#model = model;
  }

  render(width: number): string[] {
    const left = ` ${oneRow(this.#state)}`;
    const right = oneRow(this.#model);
    const room = width - visibleWidth(left) - visibleWidth(right) - 1;
    const row = right === "" ? left : room >= 2 ? `${left}${" ".repeat(room)}${right}` : `${left} · ${right}`;
    return [truncateToWidth(style("dim")(` ${oneRow(this.#where)}`), width), truncateToWidth(style(this.#tone)(row), width)];
  }

  invalidate(): void {}
}

/** The directory the agent works in as pi shows it: home shortened, then its branch, then the conversation's name. */
export function whereText(cwd: string, branch?: string, name?: string): string {
  return `${homeShortened(cwd)}${branch === undefined ? "" : ` (${branch})`}${name === undefined || name === "" ? "" : ` • ${name}`}`;
}

/** A path with the home directory written as "~". */
export function homeShortened(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * What a conversation used, as pi shows it: tokens in and out, cache reads and writes and cost over the whole
 * conversation, as its store adds them up, compacted history and summaries included; then how full its context is
 * against `contextWindow`, as its last answer measured it.
 */
export function usageText(view: ConversationView, contextWindow: number | undefined, subscription: boolean): string {
  const usage = view.docs["pi.usage"] as UsageState | undefined;
  const total = [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})].reduce((sum, each) => ({
    input: sum.input + each.input,
    output: sum.output + each.output,
    cacheRead: sum.cacheRead + each.cacheRead,
    cacheWrite: sum.cacheWrite + each.cacheWrite,
    cost: sum.cost + each.cost.total,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const last: Usage | undefined = view.entries.flatMap((entry) => entry.model ?? [])
    .findLast((message): message is AssistantMessage => message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error")?.usage;
  const parts = [
    total.input > 0 && `↑${tokens(total.input)}`,
    total.output > 0 && `↓${tokens(total.output)}`,
    total.cacheRead > 0 && `R${tokens(total.cacheRead)}`,
    total.cacheWrite > 0 && `W${tokens(total.cacheWrite)}`,
    (total.cost > 0 || subscription) && `$${total.cost.toFixed(3)}${subscription ? " (sub)" : ""}`,
    contextWindow !== undefined && contextWindow > 0
      && `${last === undefined ? "?" : ((calculateContextTokens(last) / contextWindow) * 100).toFixed(1)}%/${tokens(contextWindow)}`,
  ];
  return parts.filter((part): part is string => typeof part === "string").join(" ");
}

/** A token count, short as pi writes it. */
export function tokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}
