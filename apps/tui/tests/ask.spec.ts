import { Container, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { Asker, Declined } from "../src/ask.js";
import { plain, ScriptedTerminal } from "./scripted-terminal.js";

async function until(test: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !test(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!test()) throw new Error("timed out");
}

function screen() {
  const terminal = new ScriptedTerminal();
  const tui = new TuiMainScreen(terminal);
  const slot = new Container();
  tui.addChild(slot);
  tui.start();
  return { terminal, tui, asker: new Asker(tui, slot, () => {}) };
}

describe("Asker", () => {
  it("narrows a list by every word typed and picks the item under the cursor", async () => {
    const { terminal, tui, asker } = screen();
    try {
      const picked = asker.choose("Pick the model", [
        { value: "faux/alpha", label: "Alpha", description: "Faux" },
        { value: "other/beta", label: "Beta 2", description: "Other" },
      ]);
      await until(() => terminal.screen().includes("Beta 2"));
      for (const key of "other b") terminal.type(key);
      terminal.type("\r");
      expect(await picked).toBe("other/beta");
    } finally {
      tui.stop();
    }
  });

  it("shows a secret as dots, takes it pasted, and is declined with escape", async () => {
    const { terminal, tui, asker } = screen();
    try {
      const key = asker.enter("Enter the key", true);
      await until(() => terminal.screen().includes("Enter the key"));
      terminal.type("\x1b[200~sk-s3cret\x1b[201~");
      await until(() => plain(terminal.output).includes("•••••••••"));
      expect(terminal.screen()).not.toContain("s3cret");
      terminal.type("\r");
      expect(await key).toBe("sk-s3cret");

      const declined = asker.enter("Enter the key", true);
      terminal.type("\x1b");
      await expect(declined).rejects.toBeInstanceOf(Declined);
    } finally {
      tui.stop();
    }
  });
});
