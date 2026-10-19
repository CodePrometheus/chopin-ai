import { Container, fuzzyFilter, matchesKey, SelectList, Text, truncateToWidth, type Component, type Focusable, type SelectItem, type TUI } from "@earendil-works/pi-tui";
import { editorTheme, style } from "./theme.js";
import { oneRow, printable } from "./transcript.js";

/** What a question the user turned down ends with. */
export class Declined extends Error {
  constructor() {
    super("declined");
  }
}

/**
 * Questions put to the user in one part of the screen, one at a time, with what they need to know above them:
 * a list to choose from, narrowed as they type, or a line to enter, hidden when it is a secret. Escape declines.
 */
export class Asker {
  readonly #tui: TUI;
  readonly #slot: Container;
  readonly #told = new Container();
  readonly #restore: () => void;

  /** `restore` gives the screen back once the questions are over. */
  constructor(tui: TUI, slot: Container, restore: () => void) {
    this.#tui = tui;
    this.#slot = slot;
    this.#restore = restore;
  }

  /** Shows `text` above the questions until they are over. */
  tell(text: string): void {
    this.#told.addChild(new Text(printable(text), 1, 0));
    this.#tui.requestRender();
  }

  choose(title: string, items: readonly SelectItem[], signal?: AbortSignal): Promise<string> {
    return this.#ask((done) => new Choice(title, items, done), signal);
  }

  enter(message: string, secret: boolean, signal?: AbortSignal): Promise<string> {
    return this.#ask((done) => new Entry(message, secret, done), signal);
  }

  /** Clears what was told and asked, and gives the screen back. */
  close(): void {
    this.#told.clear();
    this.#slot.clear();
    this.#restore();
    this.#tui.requestRender();
  }

  #ask(make: (done: (answer: string | undefined) => void) => Component & Focusable, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const finish = (answer: string | undefined) => {
        signal?.removeEventListener("abort", aborted);
        this.#slot.clear();
        this.#slot.addChild(this.#told);
        this.#tui.requestRender();
        if (answer === undefined) reject(signal?.aborted === true ? signal.reason : new Declined());
        else resolve(answer);
      };
      // A question the flow no longer needs, such as a code the browser already delivered, goes away.
      const aborted = () => finish(undefined);
      if (signal?.aborted === true) return reject(signal.reason);
      signal?.addEventListener("abort", aborted, { once: true });
      const question = make(finish);
      this.#slot.clear();
      this.#slot.addChild(this.#told);
      this.#slot.addChild(question);
      this.#tui.setFocus(question);
      this.#tui.requestRender();
    });
  }
}

/** A list narrowed by what is typed: every word must match the item's name, details or value, best matches first. */
class Choice implements Component, Focusable {
  focused = false;
  readonly #title: string;
  readonly #items: readonly SelectItem[];
  readonly #done: (answer: string | undefined) => void;
  #filter = "";
  #list: SelectList;

  constructor(title: string, items: readonly SelectItem[], done: (answer: string | undefined) => void) {
    this.#title = title;
    this.#items = items.map((item) => ({ ...item, label: oneRow(item.label), ...(item.description && { description: oneRow(item.description) }) }));
    this.#done = done;
    this.#list = this.#narrowed();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "backspace")) this.#filter = this.#filter.slice(0, -1);
    else if (typed(data) !== undefined) this.#filter += typed(data);
    else return this.#list.handleInput(data);
    this.#list = this.#narrowed();
  }

  render(width: number): string[] {
    const filter = this.#filter === "" ? style("dim")("type to narrow, enter picks, esc goes back") : `› ${oneRow(this.#filter)}`;
    return [truncateToWidth(` ${style("bold")(oneRow(this.#title))}`, width), truncateToWidth(` ${filter}`, width), ...this.#list.render(width)];
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  #narrowed(): SelectList {
    const shown = this.#filter.trim() === ""
      ? [...this.#items]
      : fuzzyFilter([...this.#items], this.#filter, (item) => `${item.label} ${item.description ?? ""} ${item.value}`);
    const list = new SelectList(shown, 12, editorTheme.selectList, { maxPrimaryColumnWidth: 44 });
    list.onSelect = (item) => this.#done(item.value);
    list.onCancel = () => this.#done(undefined);
    return list;
  }
}

/** One line entered, shown as dots when it is a secret, such as a key. */
class Entry implements Component, Focusable {
  focused = false;
  readonly #message: string;
  readonly #secret: boolean;
  readonly #done: (answer: string | undefined) => void;
  #value = "";

  constructor(message: string, secret: boolean, done: (answer: string | undefined) => void) {
    this.#message = message;
    this.#secret = secret;
    this.#done = done;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "enter")) this.#done(this.#value.trim());
    else if (matchesKey(data, "escape")) this.#done(undefined);
    else if (matchesKey(data, "backspace")) this.#value = this.#value.slice(0, -1);
    else this.#value += typed(data) ?? "";
  }

  render(width: number): string[] {
    const shown = this.#secret ? "•".repeat(this.#value.length) : oneRow(this.#value);
    return [
      truncateToWidth(` ${style("bold")(oneRow(this.#message))}`, width),
      truncateToWidth(` › ${shown}${style("dim")(this.#value === "" ? "enter submits, esc goes back" : "")}`, width),
    ];
  }

  invalidate(): void {}
}

/** The text a key press or a paste puts in, without the markers a paste comes wrapped in; undefined for other keys. */
function typed(data: string): string | undefined {
  const text = data.replace(/\x1b\[20[01]~/g, "").replace(/[\r\n]+/g, "");
  return text !== "" && !/[\x00-\x1f\x7f]/.test(text) ? text : undefined;
}
