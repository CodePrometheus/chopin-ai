import { Text, type Component } from "@earendil-works/pi-tui";
import type { Loaded } from "@chopin-ai/harness-pi/protocol";
import { homeShortened } from "./footer.js";
import { style } from "./theme.js";

/** The keys the header names before it is expanded, as pi names them. */
const MAIN_KEYS = [["esc", "interrupt"], ["ctrl+c", "exit"], ["/", "commands"], ["!", "bash"], ["ctrl+o", "more"]] as const;

/**
 * What the terminal says first, as pi does: its version and the main keys; expanded, every key and what the agent
 * loaded besides its tools, which is the service's to say.
 */
export class Header implements Component {
  readonly #text = new Text("", 1, 1);
  readonly #version: string;
  readonly #keys: readonly (readonly [string, string])[];
  /** Where the layer's instructions are kept. */
  readonly #instructions: string;
  #loaded: Loaded | undefined;
  #expanded = false;

  constructor(version: string, keys: readonly (readonly [string, string])[], instructions: string) {
    this.#version = version;
    this.#keys = keys;
    this.#instructions = instructions;
    this.#draw();
  }

  setLoaded(loaded: Loaded): void {
    this.#loaded = loaded;
    this.#draw();
  }

  setExpanded(expanded: boolean): void {
    this.#expanded = expanded;
    this.#draw();
  }

  render(width: number): string[] {
    return this.#text.render(width);
  }

  invalidate(): void {
    this.#text.invalidate();
  }

  #draw(): void {
    const title = `${style("bold")("chopin")} ${style("dim")(`v${this.#version}`)}`;
    if (!this.#expanded) {
      const hints = MAIN_KEYS.map(([key, what]) => `${key} ${style("dim")(what)}`).join(style("dim")(" · "));
      this.#text.setText(`${title}\n${hints}\n${style("dim")("Press ctrl+o to show every key and what the agent loaded.")}`);
      return;
    }
    const width = Math.max(...this.#keys.map(([key]) => key.length));
    const keys = this.#keys.map(([key, what]) => `${key.padEnd(width)}  ${style("dim")(what)}`);
    const loaded = this.#loaded;
    const section = (name: string, lines: readonly string[]) => (lines.length === 0 ? [] : ["", style("cyan")(`[${name}]`), ...lines.map((line) => style("dim")(`  ${line}`))]);
    const resources = loaded === undefined ? [] : [
      ...section("Context", [...(loaded.instructions ? [this.#instructions] : []), ...loaded.projectInstructions].map(homeShortened)),
      ...section("Skills", loaded.skills.length === 0 ? [] : [[...loaded.skills].sort().join(", ")]),
      ...section("MCP servers", loaded.mcpServers.length === 0 ? [] : [[...loaded.mcpServers].sort().join(", ")]),
    ];
    this.#text.setText([title, ...keys, ...resources].join("\n"));
  }
}
