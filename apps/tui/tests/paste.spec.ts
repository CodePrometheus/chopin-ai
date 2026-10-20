import { Editor, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { insertApart, shellWord } from "../src/paste.js";
import { editorTheme } from "../src/theme.js";
import { ScriptedTerminal } from "./scripted-terminal.js";

describe("insertApart", () => {
  it("sets pasted text apart from the words around the cursor, and only from words", () => {
    const editor = new Editor(new TuiMainScreen(new ScriptedTerminal()), editorTheme);
    editor.setText("lookat");
    for (const _ of "at") editor.handleInput("\x1b[D");
    insertApart(editor, "/tmp/a.png");
    expect(editor.getText()).toBe("look /tmp/a.png at");
    editor.setText("see ");
    insertApart(editor, "/tmp/b.png");
    expect(editor.getText()).toBe("see /tmp/b.png");
  });
});

describe("shellWord", () => {
  it("leaves a plain path as it is and quotes any other for the shell", () => {
    expect(shellWord("/tmp/a.png")).toBe("/tmp/a.png");
    expect(shellWord("/tmp/my shot.png")).toBe("'/tmp/my shot.png'");
    expect(shellWord("/tmp/it's.png")).toBe("'/tmp/it'\\''s.png'");
  });
});
