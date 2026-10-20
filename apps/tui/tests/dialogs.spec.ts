import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ConversationView } from "@earendil-works/pi-durable";
import { Container, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { stageIn } from "../src/ask.js";
import { forkChoices, pickConversation } from "../src/dialogs.js";
import { ScriptedTerminal } from "./scripted-terminal.js";

initTheme();

const user = (id: number, text: string) => ({ id, kind: "pi.user", model: [{ role: "user", content: text, timestamp: 0 }] });
const answer = (id: number) => ({ id, kind: "pi.assistant", model: [{ role: "assistant", content: [], stopReason: "stop" }] });
const view = (...entries: unknown[]) => ({ conversation: { id: 1 }, entries, docs: {} }) as unknown as ConversationView;

describe("forkChoices", () => {
  it("forks at what was written just before a message, and from the first one into a new conversation", () => {
    expect(forkChoices(view(user(1, "First."), answer(2), user(3, "Second.")))).toEqual([
      { id: "1", text: "First." },
      { id: "3", text: "Second.", at: 2 },
    ]);
  });

  it("offers no message whose earlier history only a compaction's summary holds", () => {
    const summary = { id: 9, kind: "pi.compaction", model: [{ role: "user", content: "<summary>…</summary>", timestamp: 0 }] };
    expect(forkChoices(view(summary, user(5, "Kept."), answer(6), user(7, "Later.")))).toEqual([{ id: "7", text: "Later.", at: 6 }]);
    // One written after the compaction forks at its summary, which holds what came before.
    expect(forkChoices(view(summary, user(5, "Kept."), answer(6), user(10, "After.")))).toContainEqual({ id: "10", text: "After.", at: 9 });
  });
});

describe("pickConversation", () => {
  it("takes the selector's keys for deleting a session, which would delete a file by its path", async () => {
    const terminal = new ScriptedTerminal();
    const tui = new TuiMainScreen(terminal);
    const slot = new Container();
    tui.addChild(slot);
    tui.start();
    let loads = 0;
    const summaries = async () => {
      loads++;
      return [{ id: 4, name: "", first: "Hello.", messages: 2, created: 1, modified: 2 }];
    };
    const picked = pickConversation(stageIn(tui, slot), "/project", summaries);
    for (let i = 0; i < 100 && !terminal.screen().includes("Hello."); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    terminal.type("\x04");
    terminal.type("\r");
    expect(await picked).toBe(4);
    expect(loads).toBe(1);
    tui.stop();
  });
});
