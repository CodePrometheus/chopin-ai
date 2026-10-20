import {
  getSettingsListTheme,
  SessionSelectorComponent,
  ThemeSelectorComponent,
  ThinkingSelectorComponent,
  UserMessageSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { UserEntry, type ConversationView, type EntryRecord } from "@earendil-works/pi-durable";
import { matchesKey, SettingsList, type Component, type Focusable, type KeyId } from "@earendil-works/pi-tui";
import { userText } from "@chopin-ai/harness-pi";
import type { Summary } from "@chopin-ai/harness-pi/protocol";
import type { Stage } from "./ask.js";
import { printable } from "./transcript.js";

type ThinkingLevel = ConstructorParameters<typeof ThinkingSelectorComponent>[0];

/** What a dialog on `stage` is answered with, or undefined when the user backs out; the stage is given back either way. */
function answered<T>(stage: Stage, make: (done: (answer: T | undefined) => void) => Component): Promise<T | undefined> {
  return new Promise((resolve) => {
    stage.show(make((answer) => {
      stage.restore();
      resolve(answer);
    }));
  });
}

/** A thinking level picked in pi's selector among `levels`, the one in use marked. */
export function pickThinking(stage: Stage, current: string, levels: readonly string[]): Promise<string | undefined> {
  return answered(stage, (done) => new ThinkingSelectorComponent(current as ThinkingLevel, levels as ThinkingLevel[], done, () => done(undefined)));
}

/**
 * The user's messages a fork can start over from, each with the entry the fork holds up to: what was written just
 * before it. A message whose earlier history only a compaction's summary holds now has none; the first of all has
 * nothing before it, and starts over in a new conversation.
 */
export function forkChoices(view: ConversationView): { id: string; text: string; at?: number }[] {
  return view.entries.flatMap((entry, index) => {
    if (entry.kind !== UserEntry.kind) return [];
    // The view puts its head marker first, so what came just before is the latest entry written earlier.
    const before = view.entries.filter((each) => each.id < entry.id).reduce<EntryRecord | undefined>((latest, each) => (latest === undefined || each.id > latest.id ? each : latest), undefined);
    if (before === undefined && index > 0) return [];
    const text = (entry.model ?? []).map((message) => (message.role === "user" ? userText(message.content) : "")).join("");
    return [{ id: String(entry.id), text, ...(before !== undefined && { at: Number(before.id) }) }];
  });
}

/** One of the user's earlier messages, by its entry, picked in pi's message selector. */
export function pickMessage(stage: Stage, messages: readonly { id: string; text: string }[]): Promise<string | undefined> {
  return answered(stage, (done) => new UserMessageSelectorComponent(messages.map(({ id, text }) => ({ id, text: printable(text) })), done, () => done(undefined)));
}

/**
 * One of the owner's conversations, picked in pi's session selector as it lists sessions; `current` is marked. Its
 * keys for deleting a session are taken from it: it would delete a file by the session's path, and conversations
 * here have none.
 */
export function pickConversation(stage: Stage, cwd: string, load: () => Promise<readonly Summary[]>, current?: number): Promise<number | undefined> {
  // Both of its scopes list the same conversations, so they are asked for once.
  let loading: Promise<readonly Summary[]> | undefined;
  const sessions = async () => (await (loading ??= load())).map((line) => ({
    path: String(line.id),
    id: String(line.id),
    cwd,
    ...(line.name !== "" && { name: printable(line.name) }),
    created: new Date(line.created),
    modified: new Date(line.modified || line.created),
    messageCount: line.messages,
    firstMessage: printable(line.first),
    allMessagesText: printable(line.first),
  }));
  return answered(stage, (done) => new Without(["ctrl+d", "ctrl+backspace"], new SessionSelectorComponent(sessions, sessions, (path) => done(Number(path)),
    () => done(undefined), () => done(undefined), () => stage.tui.requestRender(), {}, current === undefined ? undefined : String(current))));
}

/** A component with some of its keys taken from it, everything else handed on. */
class Without implements Component, Focusable {
  readonly #keys: readonly KeyId[];
  readonly #inner: Component & Partial<Focusable>;

  constructor(keys: readonly KeyId[], inner: Component & Partial<Focusable>) {
    this.#keys = keys;
    this.#inner = inner;
  }

  get focused(): boolean {
    return this.#inner.focused ?? false;
  }

  set focused(focused: boolean) {
    this.#inner.focused = focused;
  }

  handleInput(data: string): void {
    if (!this.#keys.some((key) => matchesKey(data, key))) this.#inner.handleInput?.(data);
  }

  render(width: number): string[] {
    return this.#inner.render(width);
  }

  invalidate(): void {
    this.#inner.invalidate();
  }
}

/** The terminal's settings as /settings changes them, each kept as soon as it is picked. */
export interface SettingsChoices {
  theme: string;
  hideThinking: boolean;
  /** Draws with a theme for a look, without keeping it. */
  drawWith(theme: string): void;
  setTheme(theme: string): void;
  setHideThinking(hidden: boolean): void;
}

/** pi's settings list, with those of its settings this terminal has; resolves once the user leaves it. */
export async function editSettings(stage: Stage, settings: SettingsChoices): Promise<void> {
  await answered<void>(stage, (done) => new SettingsList([
    {
      id: "theme",
      label: "Theme",
      description: "Color theme for the interface",
      currentValue: settings.theme,
      submenu: (current, close) => new ThemeSelectorComponent(current, close, () => {
        settings.drawWith(current);
        close();
      }, settings.drawWith),
    },
    {
      id: "hide-thinking",
      label: "Hide thinking",
      description: "Hide thinking blocks in assistant responses",
      currentValue: String(settings.hideThinking),
      values: ["true", "false"],
    },
  ], 10, getSettingsListTheme(), (id, value) => {
    if (id === "theme") settings.setTheme(value);
    else settings.setHideThinking(value === "true");
  }, () => done(undefined)));
}
