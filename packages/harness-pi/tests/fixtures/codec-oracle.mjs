import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { binaryCodec } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
const { DeflatedPart } = await import(new URL("./link/part.js", import.meta.resolve("@earendil-works/chord")));
const { checkMessage } = await import(new URL("./link/message.js", import.meta.resolve("@earendil-works/chord")));

export function mapParts(frame, convert) {
  switch (frame.kind) {
    case "hold": return { ...frame, params: convert(frame.params) };
    case "call": return { ...frame, ...(Object.hasOwn(frame, "args") && { args: convert(frame.args) }) };
    case "result": return { ...frame, ...(Object.hasOwn(frame, "value") && { value: convert(frame.value) }) };
    case "bound": return { ...frame, holds: frame.holds.map((hold) => ({ ...hold, members: hold.members.map((member) => ({ ...member, value: convert(member.value) })) })) };
    case "state": return { ...frame, holds: frame.holds.map((hold) => ({ ...hold, members: hold.members.map((member) => ({ ...member, ops: convert(member.ops) })) })) };
    default: return frame;
  }
}

export const encode = (frame) => binaryCodec.encode(mapParts(frame, JSON.stringify));
export function decode(bytes) {
  const message = checkMessage(binaryCodec.decode(bytes), BACKGROUND_CONTEXT);
  return mapParts(message, (part) => JSON.parse(typeof part === "string" ? part : Buffer.from(part instanceof DeflatedPart ? inflateRawSync(part.bytes) : part).toString("utf8")));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    const response = request.op === "encode" ? [...encode(request.frame)] : decode(Uint8Array.from(request.bytes));
    process.stdout.write(JSON.stringify(response) + "\n");
  }
}
