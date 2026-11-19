import { OutputBuffer, utf8ByteLength } from "@earendil-works/chord/output";
import { expect, it } from "vitest";
import { appendCommandOutput, commandOutput, commandOutputPrefix, emptyCommandOutput } from "../src/commands-output.js";

it("restores bounded output at byte boundaries with the native buffer's final text and truncation", () => {
  const samples = [
    Buffer.from(""), Buffer.from("hello\nworld\n"), Buffer.from("\ufeff€花😀\n"),
    Buffer.from("\u001b[31mred\u001b[0m\nplain\n"), Buffer.from([0, 255, 226, 130]),
    Buffer.from("one\ntwo\nthree\nfour\n"), Buffer.from("a".repeat(100) + "\nshort\n"),
  ];
  for (const bytes of samples) for (const chunk of new Set([1, 3, bytes.length || 1])) for (const maxBytes of [0, 4, 16]) {
    const limits = { maxBytes, maxLines: 2 };
    const native = new OutputBuffer({ ...limits, retain: "tail" });
    let state = emptyCommandOutput();
    for (let at = 0; at < bytes.length; at += chunk) {
      const part = bytes.subarray(at, at + chunk);
      native.push(part);
      state = structuredClone(state);
      appendCommandOutput(state, { stream: "stdout", data: part.toString("base64url"), cursor: String(at + part.length), complete: false }, limits);
      expect(utf8ByteLength(state.window)).toBeLessThanOrEqual(maxBytes + 4);
    }
    appendCommandOutput(state, { stream: null, data: "", cursor: "end", complete: true }, limits);
    native.end();
    const expected = native.snapshot();
    expect(commandOutput(state, limits), JSON.stringify({ bytes: bytes.toString("base64url"), chunk, maxBytes })).toEqual({ text: expected.text, truncated: expected.droppedBytes > 0 });
    const resumed = new OutputBuffer({ ...limits, retain: "tail" });
    resumed.push(state.window, commandOutputPrefix(state)); resumed.end();
    expect(resumed.snapshot()).toEqual(expected);
  }
});

it("preserves split UTF-8 independently across interleaved original output channels", () => {
  const state = emptyCommandOutput(); const limits = { maxBytes: 64, maxLines: 2 };
  for (const [stream, bytes] of [["stdout", Buffer.from([0xe2])], ["stderr", Buffer.from("between ")], ["stdout", Buffer.from([0x82, 0xac])]] as const) {
    appendCommandOutput(state, { stream, data: bytes.toString("base64url"), cursor: "cursor", complete: false }, limits);
  }
  appendCommandOutput(state, { stream: null, data: "", cursor: "end", complete: true }, limits);
  expect(commandOutput(state, limits)).toEqual({ text: "between €", truncated: false });
});
