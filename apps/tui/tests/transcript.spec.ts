import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ConversationView } from "@earendil-works/pi-durable";
import { stripTerminalSequences, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { Transcript } from "../src/transcript.js";
import { ScriptedTerminal } from "./scripted-terminal.js";

initTheme();

const transcriptFor = () => new Transcript(new TuiMainScreen(new ScriptedTerminal()), "/project");
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

const view = (entries: unknown[], live?: unknown, inbox?: unknown[]) => ({
  conversation: { id: 1 },
  entries,
  docs: {
    ...(live !== undefined && { "pi.live": { generation: { attempt: 1, message: live } } }),
    ...(inbox !== undefined && { "pi.inbox": { items: inbox } }),
  },
}) as unknown as ConversationView;

const entry = (id: number, message: unknown) => ({ id, conversationId: 1, kind: "test", model: [message] });
const call = (id: number, command: string) =>
  entry(id, { role: "assistant", content: [{ type: "toolCall", id: `c${id}`, name: "bash", arguments: { command } }], stopReason: "toolUse" });
const ran = (command: string, output: string, more: object = {}) =>
  ({ command, output, cancelled: false, truncated: false, excluded: false, exitCode: 0, ...more });
const result = (id: number, call: number, text: string) =>
  entry(id, { role: "toolResult", toolCallId: `c${call}`, toolName: "bash", isError: false, content: [{ type: "text", text }] });

describe("Transcript", () => {
  it("draws each message as pi does, a tool's result in its call", () => {
    const transcript = transcriptFor();
    transcript.update(view([
      entry(1, { role: "user", content: "List the files.", timestamp: 0 }),
      call(2, "ls"),
      result(3, 2, "a.txt\nb.txt"),
      entry(4, { role: "assistant", content: [{ type: "thinking", thinking: "Count them." }, { type: "text", text: "There are **two** files." }], stopReason: "stop" }),
    ]));
    const text = plain(transcript.render(60));
    for (const shown of ["List the files.", "$ ls", "a.txt", "b.txt", "Count them.", "There are two files."]) expect(text).toContain(shown);

    transcript.setHideThinking(true);
    expect(plain(transcript.render(60))).not.toContain("Count them.");
  });

  it("shows what is being generated below what is committed, and drops it once committed", () => {
    const transcript = transcriptFor();
    transcript.update(view([entry(1, { role: "user", content: "Hi.", timestamp: 0 })], { role: "assistant", content: [{ type: "text", text: "Hel" }] }));
    expect(plain(transcript.render(40))).toMatch(/Hi\.[\s\S]*Hel/);
    transcript.update(view([
      entry(1, { role: "user", content: "Hi.", timestamp: 0 }),
      entry(2, { role: "assistant", content: [{ type: "text", text: "Hello." }], stopReason: "stop" }),
    ]));
    const text = plain(transcript.render(40));
    expect(text).toContain("Hello.");
    expect(text.match(/Hel/g)).toHaveLength(1);
  });

  it("draws a control sequence in what it shows as a mark, never sending it to the terminal", () => {
    const transcript = transcriptFor();
    transcript.update(view([
      entry(1, { role: "assistant", content: [{ type: "text", text: "Done \u001b]0;spoofed\u0007 exe.‮txt" }], stopReason: "stop" }),
      call(2, "cat x"),
      result(3, 2, "\u001b]52;c;aGk=\u0007copied\r\n\tindented"),
      entry(4, { role: "assistant", content: [], stopReason: "error", errorMessage: "gateway said \u001b]0;owned\u0007" }),
    ]));
    const drawn = transcript.render(60).join("\n");
    expect(drawn).not.toContain("\u001b]52");
    expect(drawn).not.toContain("\u001b]0;spoofed");
    expect(drawn).not.toContain("\u001b]0;owned");
    expect(drawn).toContain("gateway said");
    expect(drawn).toContain("�]0;spoofed� exe.�txt");
    expect(drawn).toContain("�]52;c;aGk=�copied");
    expect(plain(transcript.render(60))).toContain("   indented");
    expect(drawn).not.toMatch(/[\r\t]/);
  });

  it("draws the user's commands as pi does, and what waits in the queue below", () => {
    const transcript = transcriptFor();
    transcript.update(view([
      { id: 1, conversationId: 1, kind: "chopin.shell", data: ran("make", "built", { exitCode: 2 }) },
      { id: 2, conversationId: 1, kind: "chopin.shell", data: ran("cat .env", "hidden", { excluded: true }) },
    ], undefined, [
      { id: 7, mode: "write", entry: { kind: "chopin.shell", data: ran("ls", "a.txt") } },
      { id: 8, mode: "steer", content: "Look again." },
      { id: 9, mode: "followUp", content: [{ type: "text", text: "Then summarize." }] },
    ]));
    const text = plain(transcript.render(60));
    expect(text).toMatch(/\$ make[\s\S]*built[\s\S]*\(exit 2\)[\s\S]*\$ cat \.env[\s\S]*hidden/);
    expect(text).toMatch(/\$ ls[\s\S]*a\.txt[\s\S]*Steering: Look again\.[\s\S]*Follow-up: Then summarize\.[\s\S]*↳ alt\+up to edit all queued messages/);

    transcript.update(view([], undefined, []));
    expect(plain(transcript.render(60))).not.toContain("Steering:");
  });

  it("draws a command as it runs, its output growing, until it ends", () => {
    const transcript = transcriptFor();
    transcript.setRunning({ command: "make", output: "step 1\n", excluded: false });
    transcript.setRunning({ command: "make", output: "step 1\nstep 2\n", excluded: false });
    const text = plain(transcript.render(60));
    expect(text).toMatch(/\$ make[\s\S]*step 1[\s\S]*step 2[\s\S]*Running/);
    expect(text.match(/step 1/g)).toHaveLength(1);
    // Output that lost its head to the kept tail is drawn anew.
    transcript.setRunning({ command: "make", output: "step 3\n", excluded: false });
    expect(plain(transcript.render(60))).not.toContain("step 1");
    transcript.setRunning(null);
    expect(plain(transcript.render(60))).not.toContain("$ make");
  });

  it("keeps every line within the terminal's width", () => {
    const transcript = transcriptFor();
    transcript.update(view([call(1, "x".repeat(200)), result(2, 1, "1\n2\n3\n4\n5\n6")]));
    for (const width of [30, 12]) expect(transcript.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
  });
});
