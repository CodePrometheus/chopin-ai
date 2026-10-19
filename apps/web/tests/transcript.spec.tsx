import type { ConversationView } from "@earendil-works/pi-durable";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fold, Transcript } from "../src/transcript";

const entry = (id: number, message: unknown) => ({ id, conversationId: 1, kind: "test", model: [message] });
const view = (entries: unknown[], live?: unknown) =>
  ({ conversation: { id: 1 }, entries, docs: live === undefined ? {} : { "pi.live": { generation: { attempt: 1, message: live } } } }) as unknown as ConversationView;

const conversation = view([
  entry(1, { role: "user", content: "List the files.", timestamp: 0 }),
  entry(2, { role: "assistant", content: [{ type: "thinking", thinking: "Use ls." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] }),
  entry(3, { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "a.txt" }] }),
], { role: "assistant", content: [{ type: "text", text: "There is **one** file" }] });

describe("the web transcript", () => {
  it("folds each tool's result into its call and puts what is being generated last", () => {
    expect(fold(conversation).map((item) => [item.kind, item.kind === "tool" ? item.status : item.text])).toEqual([
      ["user", "List the files."],
      ["thought", "Use ls."],
      ["tool", "completed"],
      ["agent", "There is **one** file"],
    ]);
  });

  it("keeps a tool's latest result when it reports more than once", () => {
    const twice = view([
      entry(1, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] }),
      entry(2, { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "first" }] }),
      entry(3, { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: true, content: [{ type: "text", text: "second" }] }),
    ]);
    const items = fold(twice);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", status: "failed", output: "second" });
  });

  it("renders the agent's markdown as elements, never as raw HTML", () => {
    const html = renderToStaticMarkup(<Transcript view={view([entry(1, { role: "assistant", content: [{ type: "text", text: "**bold** <img src=x onerror=alert(1)>" }] })])} />);
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain("<img");
    const pictured = renderToStaticMarkup(<Transcript view={view([entry(1, { role: "assistant", content: [{ type: "text", text: "[![leak](https://example.test/p?d=1)](https://example.test/run) exe.\u202etxt" }] })])} />);
    expect(pictured).not.toContain("<img");
    expect(pictured).toContain('<a href="https://example.test/run" target="_blank" rel="noreferrer noopener"><span class="image" title="https://example.test/p?d=1">[image: leak]</span></a>');
    expect(pictured).toContain("exe.\ufffdtxt");
  });
});
