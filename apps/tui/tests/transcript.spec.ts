import type { ConversationView } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { Transcript } from "../src/transcript.js";

const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

const view = (entries: unknown[], live?: unknown) =>
  ({ conversation: { id: 1 }, entries, docs: live === undefined ? {} : { "pi.live": { generation: { attempt: 1, message: live } } } }) as unknown as ConversationView;

const entry = (id: number, message: unknown) => ({ id, conversationId: 1, kind: "test", model: [message] });

describe("Transcript", () => {
  it("draws messages and folds a tool's result into its call", () => {
    const transcript = new Transcript();
    transcript.update(view([
      entry(1, { role: "user", content: "List the files.", timestamp: 0 }),
      entry(2, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] }),
    ]));
    expect(plain(transcript.render(60))).toContain('○ bash {"command":"ls"}');

    transcript.update(view([
      entry(1, { role: "user", content: "List the files.", timestamp: 0 }),
      entry(2, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] }),
      entry(3, { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "a.txt\nb.txt" }] }),
      entry(4, { role: "assistant", content: [{ type: "text", text: "There are **two** files." }] }),
    ]));
    const text = plain(transcript.render(60));
    expect(text).toContain("› List the files.");
    expect(text).toContain('● bash {"command":"ls"}');
    expect(text).toContain("⎿ a.txt");
    expect(text).toContain("There are two files.");
    expect(text.indexOf("○")).toBe(-1);
  });

  it("shows what is being generated below what is committed, and drops it once committed", () => {
    const transcript = new Transcript();
    transcript.update(view([entry(1, { role: "user", content: "Hi.", timestamp: 0 })], { role: "assistant", content: [{ type: "text", text: "Hel" }] }));
    expect(plain(transcript.render(40))).toMatch(/› Hi\.[\s\S]*Hel/);
    transcript.update(view([
      entry(1, { role: "user", content: "Hi.", timestamp: 0 }),
      entry(2, { role: "assistant", content: [{ type: "text", text: "Hello." }] }),
    ]));
    const text = plain(transcript.render(40));
    expect(text).toContain("Hello.");
    expect(text.match(/Hel/g)).toHaveLength(1);
  });

  it("draws a control sequence in what it shows as a mark, never sending it to the terminal", () => {
    const transcript = new Transcript();
    transcript.update(view([
      entry(1, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "cat x" } }] }),
      entry(2, { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "\x1b]52;c;aGk=\x07copied exe.\u202etxt\r\n\tindented\u2028separated" }] }),
    ]));
    const drawn = transcript.render(60).join("\n");
    expect(drawn).not.toContain("\x1b]52");
    expect(drawn).toContain("\ufffd]52;c;aGk=\ufffdcopied exe.\ufffdtxt");
    expect(drawn).toContain("⎿    indented");
    expect(drawn).toContain("⎿ separated");
    expect(drawn).not.toMatch(/[\r\t]/);
  });

  it("keeps every line within the terminal's width", () => {
    const transcript = new Transcript();
    transcript.update(view([
      entry(1, { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "x".repeat(200), text: "a\u2028b" } }] }),
      entry(2, { role: "toolResult", toolCallId: "c", toolName: "bash", isError: false, content: [{ type: "text", text: "1\n2\n3\n4\n5\n6" }] }),
    ]));
    for (const width of [30, 12]) {
      const lines = transcript.render(width).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
      expect(lines.every((line) => line.length <= width && !line.includes("\n"))).toBe(true);
    }
  });
});
