import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as protocol from "../packages/harness-pi/dist/protocol.js";

const path = fileURLToPath(new URL("../crates/protocol/contracts.json", import.meta.url));
const remotes = [...protocol.contracts].sort((a, b) => a.type.name.localeCompare(b.type.name));
const contracts = Object.fromEntries(remotes.map(({ type, spec }) => [type.name, {
  version: type.version,
  fingerprint: type.fingerprint,
  address: { kind: spec.hostAddress({}).kind, params: spec.hostAddress({}).params },
  params: spec.params,
  variants: Object.keys(spec.variants).sort().map((name) => {
    const { state = {}, methods = {} } = spec.variants[name];
    return { name, state: Object.keys(state).sort(), methods: Object.keys(methods).sort(), schemas: { state, methods } };
  }),
}]));
assert(Object.keys(contracts).length > 0, "Build the producer before exporting contracts");
const serialized = JSON.stringify({ linkProtocol: 1, callTimeoutMs: protocol.CALL_TIMEOUT_MS, contracts }, null, 2) + "\n";
if (process.argv.includes("--check")) {
  assert.equal(await readFile(path, "utf8"), serialized, "Regenerate contracts after changing the producer");
} else {
  await mkdir(fileURLToPath(new URL("../crates/protocol/", import.meta.url)), { recursive: true });
  await writeFile(path, serialized);
}
