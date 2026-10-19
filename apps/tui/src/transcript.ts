import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ConversationView } from "@earendil-works/pi-durable";
import { Container, Markdown, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { entryUpdates, inputText, inWrittenOrder, liveUpdates, toolText } from "@chopin-ai/harness-pi";
import { markdownTheme, style } from "./theme.js";

/**
 * The conversation as it scrolls. Committed entries become components once and stay; only what is being
 * generated, below them, is rebuilt as it changes. Everything is drawn from ACP updates.
 */
export class Transcript extends Container {
  readonly #committed = new Container();
  readonly #live = new Container();
  readonly #seen = new Set<number>();
  readonly #calls = new Map<string, ToolCall>();
  #view: ConversationView | undefined;
  #stale = false;

  constructor() {
    super();
    this.addChild(this.#committed);
    this.addChild(this.#live);
  }

  update(view: ConversationView): void {
    // A view changes part by part, so entries or what is being generated changed only if their parts did.
    const before = this.#view;
    this.#view = view;
    if (view.entries !== before?.entries) {
      for (const entry of view.entries) {
        if (this.#seen.has(entry.id)) continue;
        this.#seen.add(entry.id);
        for (const update of entryUpdates(entry)) this.#commit(update);
      }
    }
    if (view.entries !== before?.entries || view.docs["pi.live"] !== before?.docs["pi.live"]) this.#stale = true;
  }

  /** What is being generated is drawn anew once per frame, however many changes arrived since the last. */
  override render(width: number): string[] {
    if (this.#stale && this.#view !== undefined) {
      this.#stale = false;
      this.#live.clear();
      for (const update of liveUpdates(this.#view)) {
        const component = draw(update);
        if (component !== undefined) this.#live.addChild(component);
      }
    }
    return super.render(width);
  }

  #commit(update: SessionUpdate): void {
    if (update.sessionUpdate === "tool_call_update") {
      this.#calls.get(update.toolCallId)?.finish(update.status === "failed", toolText(update.content ?? []));
      return;
    }
    const component = draw(update);
    if (component instanceof ToolCall && update.sessionUpdate === "tool_call") this.#calls.set(update.toolCallId, component);
    if (component !== undefined) this.#committed.addChild(component);
  }
}

/**
 * Text as the terminal may draw it: every line break becomes "\n", a tab the three spaces the terminal's components
 * count it as, and other control characters, which could move the cursor, set the title or write the clipboard,
 * become a visible mark, as do direction overrides.
 */
export function printable(text: string): string {
  const lines = text.replace(/\r\n?|[\v\f\u0085\u2028\u2029]/g, "\n").replace(/\t/g, "   ");
  return inWrittenOrder(lines).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "\ufffd");
}

/** Text printable on a single row, its line breaks become spaces. */
export function oneRow(text: string): string {
  return printable(text).replace(/\n+/g, " ");
}

function draw(update: SessionUpdate): Component | undefined {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return new Text(style("bold")(`› ${update.content.type === "text" ? printable(update.content.text) : `[${update.content.type}]`}`), 1, 1);
    case "agent_message_chunk":
      return update.content.type === "text" ? new Markdown(printable(update.content.text), 1, 0, markdownTheme) : undefined;
    case "agent_thought_chunk":
      return update.content.type === "text" ? new Text(style(["dim", "italic"])(printable(update.content.text)), 1, 0) : undefined;
    case "tool_call":
      return new ToolCall(update.title, update.rawInput);
    default:
      return undefined;
  }
}

/** One tool call: what was called, then how it ended and the head of what it returned. */
class ToolCall implements Component {
  readonly #title: string;
  readonly #input: string;
  #ended?: { failed: boolean; output: string };

  constructor(title: string, input: unknown) {
    this.#title = oneRow(title);
    this.#input = oneRow(inputText(input));
  }

  finish(failed: boolean, output: string): void {
    this.#ended = { failed, output: printable(output) };
  }

  render(width: number): string[] {
    const mark = this.#ended === undefined ? style("dim")("○") : this.#ended.failed ? style("red")("✗") : style("green")("●");
    const head = truncateToWidth(` ${mark} ${style("bold")(this.#title)} ${style("dim")(this.#input)}`, width);
    const output = (this.#ended?.output ?? "").split("\n").filter((line) => line.trim() !== "");
    const shown = output.slice(0, 4).map((line) => truncateToWidth(style("dim")(`   ⎿ ${line}`), width));
    const more = output.length > 4 ? [truncateToWidth(style("dim")(`     … ${output.length - 4} more lines`), width)] : [];
    return [head, ...shown, ...more];
  }

  invalidate(): void {}
}
