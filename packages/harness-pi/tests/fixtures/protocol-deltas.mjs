import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { applyImmutable, decoder, encoder } from "@earendil-works/chord/delta";
import { binaryCodec } from "@earendil-works/chord";
import { encode as encodeFrame, decode as decodeFrame } from "./codec-oracle.mjs";
import { constants, deflateRawSync, inflateRawSync } from "node:zlib";

const base = { text: String.fromCodePoint(0x20000) + "prefix", count: 0, entries: [{ id: 1 }, { id: 2 }], obsolete: true };
const encode = encoder();
const decode = decoder();
let value = base;
const batches = [
  [["a", ["text"], " first"], ["s", ["count"], 1], ["a", ["text"], " second"]],
  [["t", ["text"], 2], ["a", ["text"], " end"], ["s", ["entries", 0, "id"], 3]],
  [["p", ["entries"], 1, 1, [{ id: 4 }, { id: 5 }]], ["m", ["entries"], [2, 0, 1]], ["d", ["obsolete"]]],
  [["s", ["count"], 2], ["a", ["text"], " final"], ["d", ["entries", 1]]],
  [["r", { text: "new", entries: [] }], ["a", ["text"], " epoch"], ["s", ["entries", 0], { id: 9 }]],
  [["r", [1, 2, 3]], ["p", [], 1, 1, [4, 5]], ["m", [], [3, 0, 1, 2]]],
].map((ops) => {
  const wire = encode.encode(ops);
  value = applyImmutable(value, decode.decode(wire));
  return { wire, expected: value };
});
const malformed = [
  [["s", "not-a-path", true]],
  [["s", ["__proto__", "polluted"], true]],
  [["s", ["entries", 10], true]],
  [["a", "missing prior path"]],
  [["a", 99, "unknown path id"]],
  [["m", ["entries"], [0, 0]]],
  [["p", ["entries"], -1, 0, []]],
  [["future-op", ["text"]]],
  [["s", [], "cannot set the root"]],
  [["r", base], ["a", 0, "dictionary was reset"]],
  [["#", 0, ["text"]], ["a", 0, "old epoch"], ["r", base], ["a", 0, "stale dictionary"]],
].map((wire) => {
  assert.throws(() => applyImmutable(base, decoder().decode(wire)));
  return wire;
});
const file = new URL("../../../../crates/protocol/tests/fixtures/deltas.json", import.meta.url);
const serialized = JSON.stringify({ base, batches, malformed }, null, 2) + "\n";
const { COMPRESS_ABOVE, DeflatedPart } = await import(new URL("./link/part.js", import.meta.resolve("@earendil-works/chord")));
const frame = { kind: "result", call: 1, value: { text: "a".repeat(COMPRESS_ABOVE + 1) } };
const compressed = deflateRawSync(JSON.stringify(frame.value), { level: 1 });
const message = binaryCodec.encode({ ...frame, value: new DeflatedPart(compressed) });
assert.deepEqual(decodeFrame(message), frame);
const unfinishedPayload = deflateRawSync(JSON.stringify(frame.value), { finishFlush: constants.Z_SYNC_FLUSH });
assert.throws(() => inflateRawSync(unfinishedPayload));
const unfinished = binaryCodec.encode({ ...frame, value: new DeflatedPart(unfinishedPayload) });
const packed = JSON.stringify({ message: [...message], unfinished: [...unfinished], expected: frame.value }, null, 2) + "\n";
const failure = { kind: "chord", error: { code: "invalid", reason: "args", message: "refused" } };
const frames = [
  { kind: "hello", protocol: 1, incarnation: "00000000-0000-0000-0000-000000000001", calls: 256 },
  { kind: "bound", holds: [{ hold: 0, variant: 0, members: [{ member: 0, value: base }], failed: [] }] },
  { kind: "state", holds: [{ hold: 0, members: [{ member: 0, ops: batches[0].wire }], failed: [], retired: [0] }] },
  { kind: "state", holds: [{ hold: 0, members: [], failed: [{ member: 0, error: failure }], retired: [] }] },
  { kind: "failed", hold: 1, cause: { kind: "waiting", error: failure }, retryIn: 0 },
  { kind: "result", call: Number.MAX_SAFE_INTEGER },
  { kind: "result", call: 1, value: null },
  { kind: "result", call: 2, value: { text: "中".repeat(COMPRESS_ABOVE) } },
  { kind: "error", call: 1, error: { kind: "plugin", code: "business.refused", message: "refused", details: { retry: false } } },
  { kind: "gone", hold: 1, error: failure },
  { kind: "loading", hold: 1 },
  { kind: "ack" }, { kind: "ping" }, { kind: "pong" },
];
const wire = JSON.stringify(frames.map((expected) => {
  const bytes = encodeFrame(expected);
  assert.deepEqual(decodeFrame(bytes), expected);
  return { bytes: [...bytes], expected };
}), null, 2) + "\n";
const invalidFrames = [
  { kind: "hello", protocol: 1, incarnation: "00000000-0000-0000-0000-000000000001", calls: 0 },
  ...[
    null, "invalid", { kind: "chord", error: { code: "future-error", message: "unsupported" } },
    { kind: "chord", error: { code: "invalid", message: "missing reason" } },
    { kind: "chord", error: { code: "gone", reason: "args", message: "invalid reason" } },
    { kind: "plugin", code: "failure", message: 42 },
  ].map((error) => ({ kind: "error", call: 1, error })),
];
const invalid = JSON.stringify(invalidFrames.map((frame) => [...encodeFrame(frame)]), null, 2) + "\n";
for (const [path, content] of [[file, serialized], [new URL("./packed.json", file), packed], [new URL("./invalid-frames.json", file), invalid], [new URL("./wire.json", file), wire]]) {
  if (process.argv.includes("--check")) {
    assert.equal(await readFile(path, "utf8"), content, "Regenerate the shared wire fixtures");
  } else {
    await mkdir(new URL("./", path), { recursive: true });
    await writeFile(path, content);
  }
}
