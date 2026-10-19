import type { Terminal } from "@earendil-works/pi-tui";

/** Terminal output without its control sequences. */
export const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b_[^\x1b]*\x1b\\/g, "");

/** A terminal that keeps what is drawn and lets the test type. */
export class ScriptedTerminal implements Terminal {
  output = "";
  #input?: (data: string) => void;
  start(onInput: (data: string) => void): void { this.#input = onInput; }
  type(data: string): void { this.#input?.(data); }
  screen(): string { return plain(this.output); }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  get columns(): number { return 80; }
  get rows(): number { return 24; }
  get kittyProtocolActive(): boolean { return false; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
}
