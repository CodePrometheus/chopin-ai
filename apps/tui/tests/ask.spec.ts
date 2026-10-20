import { Container, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { stageIn } from "../src/ask.js";
import { ScriptedTerminal } from "./scripted-terminal.js";

describe("stageIn", () => {
  it("shows a dialog in place of what rests there, with the keys, and gives the place back", () => {
    const tui = new TuiMainScreen(new ScriptedTerminal());
    const slot = new Container();
    const editor = new Text("editor");
    const stage = stageIn(tui, slot, editor);
    stage.restore();
    expect(slot.children).toEqual([editor]);

    const dialog = new Text("dialog");
    stage.show(dialog);
    expect(slot.children).toEqual([dialog]);
    stage.restore();
    expect(slot.children).toEqual([editor]);
  });
});
