import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  calculateContextTokens,
  CompactionSummaryMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  ToolExecutionComponent,
  UserMessageComponent,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { CompactionEntry, type ConversationView, type EntryRecord, type InboxState, type UserInput } from "@earendil-works/pi-durable";
import { Container, Spacer, TruncatedText, type TUI } from "@earendil-works/pi-tui";
import { inWrittenOrder, ShellEntry, userText, type ShellRun } from "@chopin-ai/harness-pi";
import type { Running } from "@chopin-ai/harness-pi/protocol";
import { style } from "./theme.js";

/**
 * The conversation as pi draws it: each committed message once, a tool's result in its call, and what is being
 * generated below, drawn anew once per frame; then a command of the user's that runs, and what waits in the queue. A
 * compaction starts it over with its summary, then what it kept. Text from the model, a tool or the user is made
 * printable first.
 */
export class Transcript extends Container {
  readonly #tui: TUI;
  readonly #cwd: string;
  /** How each built-in tool is drawn, by name. */
  readonly #tools: Readonly<Record<string, ConstructorParameters<typeof ToolExecutionComponent>[4]>>;
  readonly #committed = new Container();
  readonly #live = new Container();
  readonly #running = new Container();
  readonly #queued = new Container();
  readonly #seen = new Set<number>();
  readonly #calls = new Map<string, ToolExecutionComponent>();
  readonly #answers: AssistantMessageComponent[] = [];
  readonly #summaries: CompactionSummaryMessageComponent[] = [];
  readonly #commands: BashExecutionComponent[] = [];
  /** The commands drawn as waiting in the queue, drawn anew with it. */
  #queuedCommands: BashExecutionComponent[] = [];
  /** The command running, as drawn so far. */
  #run: { command: BashExecutionComponent; output: string } | undefined;
  #view: ConversationView | undefined;
  #stale = false;
  #expanded = false;
  #hideThinking = false;

  /** `cwd`, the directory the agent works in, is where the tools' paths are shown from. */
  constructor(tui: TUI, cwd = process.cwd()) {
    super();
    this.#tui = tui;
    this.#cwd = cwd;
    this.#tools = {
      read: createReadToolDefinition(cwd), write: createWriteToolDefinition(cwd), edit: createEditToolDefinition(cwd),
      bash: createBashToolDefinition(cwd), powershell: createPowerShellToolDefinition(cwd), grep: createGrepToolDefinition(cwd),
      find: createFindToolDefinition(cwd), ls: createLsToolDefinition(cwd),
    };
    this.addChild(this.#committed);
    this.addChild(this.#live);
    this.addChild(this.#running);
    this.addChild(this.#queued);
  }

  update(view: ConversationView): void {
    // A view changes part by part, so entries or what is being generated changed only if their parts did.
    const before = this.#view;
    this.#view = view;
    if (view.entries !== before?.entries) {
      if (view.entries.some((entry) => entry.kind === CompactionEntry.kind && !this.#seen.has(entry.id))) this.#startOver();
      for (const entry of view.entries) {
        if (this.#seen.has(entry.id)) continue;
        this.#seen.add(entry.id);
        if (entry.kind === CompactionEntry.kind) this.#summarized(entry, view.entries);
        else if (ShellEntry.is(entry)) {
          const command = this.#ran(entry.data);
          this.#commands.push(command);
          this.#committed.addChild(command);
        }
        else for (const message of entry.model ?? []) this.#commit(message);
      }
    }
    if (view.docs["pi.inbox"] !== before?.docs["pi.inbox"]) this.#showQueued(view.docs["pi.inbox"] as InboxState | undefined);
    if (view.entries !== before?.entries || view.docs["pi.live"] !== before?.docs["pi.live"]) this.#stale = true;
  }

  /** The command of the user's that runs, as the service tells it; drawn at once, its output added as it grows. */
  setRunning(running: Running): void {
    if (running === null) return this.#stopRunning();
    const run = this.#run;
    if (run !== undefined && running.output === run.output) return;
    if (run !== undefined && running.output.startsWith(run.output)) {
      run.command.appendOutput(printable(running.output.slice(run.output.length)));
      run.output = running.output;
      return;
    }
    // Output that no longer begins as drawn has lost its head to the kept tail, so it is drawn anew.
    this.#stopRunning();
    const command = new BashExecutionComponent(printable(running.command), this.#tui, running.excluded);
    command.setExpanded(this.#expanded);
    if (running.output !== "") command.appendOutput(printable(running.output));
    this.#run = { command, output: running.output };
    this.#running.addChild(command);
  }

  /** Shows every tool's and command's whole output, or only its head. */
  setExpanded(expanded: boolean): void {
    this.#expanded = expanded;
    for (const call of this.#calls.values()) call.setExpanded(expanded);
    for (const summary of this.#summaries) summary.setExpanded(expanded);
    for (const command of [...this.#commands, ...this.#queuedCommands]) command.setExpanded(expanded);
    this.#run?.command.setExpanded(expanded);
    this.#stale = true;
  }

  /** Hides the model's thinking, or shows it. */
  setHideThinking(hide: boolean): void {
    this.#hideThinking = hide;
    for (const answer of this.#answers) answer.setHideThinkingBlock(hide);
    this.#stale = true;
  }

  override render(width: number): string[] {
    if (this.#stale && this.#view !== undefined) {
      this.#stale = false;
      this.#live.clear();
      const partial = (this.#view.docs["pi.live"]?.generation as { message?: AssistantMessage } | undefined)?.message;
      if (partial !== undefined) for (const component of this.#answer(partial, false)) this.#live.addChild(component);
    }
    return super.render(width);
  }

  #startOver(): void {
    this.#committed.clear();
    this.#seen.clear();
    this.#calls.clear();
    this.#answers.length = 0;
    this.#summaries.length = 0;
    this.#commands.length = 0;
  }

  /** Stops what it animates, once it is no longer shown. */
  dispose(): void {
    this.#stopRunning();
  }

  #stopRunning(): void {
    // Done with, its spinner is stopped too.
    this.#run?.command.setComplete(undefined, true);
    this.#run = undefined;
    this.#running.clear();
  }

  /** A command the user ran, as pi draws one that ended. */
  #ran(run: ShellRun): BashExecutionComponent {
    const command = new BashExecutionComponent(printable(run.command), this.#tui, run.excluded);
    command.setExpanded(this.#expanded);
    if (run.output !== "") command.appendOutput(printable(run.output));
    // Whether the output was cut is all the component reads of how, as pi passes it for a run it draws again.
    command.setComplete(run.exitCode, run.cancelled, run.truncated ? ({ truncated: true } as TruncationResult) : undefined, run.fullOutputPath);
    return command;
  }

  /** What waits for the agent's next turn, as pi lists it: commands run meanwhile, then the messages queued. */
  #showQueued(inbox: InboxState | undefined): void {
    this.#queued.clear();
    const items = inbox?.items ?? [];
    this.#queuedCommands = items.flatMap((item) => (item.mode === "write" && item.entry.kind === ShellEntry.kind ? [this.#ran(item.entry.data as ShellRun)] : []));
    for (const command of this.#queuedCommands) this.#queued.addChild(command);
    const messages = items.flatMap((item) => (item.mode === "write" ? [] : [`${item.mode === "steer" ? "Steering" : "Follow-up"}: ${userText(item.content as UserInput)}`]));
    if (messages.length === 0) return;
    this.#queued.addChild(new Spacer(1));
    for (const message of messages) this.#queued.addChild(new TruncatedText(style("dim")(oneRow(message)), 1, 0));
    this.#queued.addChild(new TruncatedText(style("dim")("↳ alt+up to edit all queued messages"), 1, 0));
  }

  /**
   * A compaction's summary, unwrapped from what the model reads, with the context it replaced as the last answer it
   * kept measured it.
   */
  #summarized(entry: EntryRecord, entries: readonly EntryRecord[]): void {
    const message = entry.model?.find((each): each is UserMessage => each.role === "user");
    const text = message === undefined ? "" : userText(message.content);
    const last = entries.filter((kept) => kept.id < entry.id).flatMap((kept) => kept.model ?? [])
      .findLast((kept): kept is AssistantMessage => kept.role === "assistant" && kept.stopReason !== "aborted" && kept.stopReason !== "error");
    const summary = new CompactionSummaryMessageComponent({
      role: "compactionSummary",
      summary: printable(/<summary>\n?([\s\S]*?)\n?<\/summary>/.exec(text)?.[1] ?? text),
      tokensBefore: last === undefined ? 0 : calculateContextTokens(last.usage),
      timestamp: message?.timestamp ?? Date.now(),
    });
    summary.setExpanded(this.#expanded);
    this.#summaries.push(summary);
    if (this.#committed.children.length > 0) this.#committed.addChild(new Spacer(1));
    this.#committed.addChild(summary);
  }

  #commit(message: Message): void {
    if (message.role === "system") return;
    if (message.role === "toolResult") {
      this.#calls.get(message.toolCallId)?.updateResult(shown(message));
      return;
    }
    if (message.role === "user") {
      if (this.#committed.children.length > 0) this.#committed.addChild(new Spacer(1));
      this.#committed.addChild(new UserMessageComponent(printable(userText(message.content))));
      return;
    }
    for (const component of this.#answer(message, true)) this.#committed.addChild(component);
  }

  /** An answer, then each tool it calls; a call of an answer that failed ends with why. */
  #answer(message: AssistantMessage, committed: boolean): (AssistantMessageComponent | ToolExecutionComponent)[] {
    const answer = new AssistantMessageComponent(shown(message), this.#hideThinking);
    if (committed) this.#answers.push(answer);
    const calls = message.content.flatMap((block) => {
      if (block.type !== "toolCall") return [];
      const call = new ToolExecutionComponent(block.name, block.id, deepPrintable(block.arguments), undefined, this.#tools[block.name], this.#tui, this.#cwd);
      call.setExpanded(this.#expanded);
      if (message.stopReason === "aborted" || message.stopReason === "error") {
        call.updateResult({ content: [{ type: "text", text: printable(message.errorMessage ?? (message.stopReason === "aborted" ? "Operation aborted" : "Error")) }], isError: true });
      } else if (committed) {
        this.#calls.set(block.id, call);
      }
      return [call];
    });
    return [answer, ...calls];
  }
}

/** A message as the terminal may draw it: every text it holds made printable, a tool's details and error included. */
function shown<M extends AssistantMessage | ToolResultMessage>(message: M): M {
  return deepPrintable(message);
}

/** `value` with every string in it made printable. */
export function deepPrintable<T>(value: T): T {
  if (typeof value === "string") return printable(value) as T;
  if (Array.isArray(value)) return value.map(deepPrintable) as T;
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepPrintable(item)])) as T;
  return value;
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
