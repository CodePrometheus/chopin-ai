// Run from a copy in the installed consumer, never through the source workspace's resolution tree.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { DirectoryWorkspaceProvider } from "@chopin-ai/workspace";
import { AgentService, launchToken, listen, openSealedStore } from "@chopin-ai/harness-pi";
import { connect, Conversation, Conversations } from "@chopin-ai/harness-pi/protocol";

const root = await realpath(process.cwd());
assert.equal(dirname(fileURLToPath(import.meta.url)), root);
const packages = ["@chopin-ai/workspace", "@chopin-ai/core", "@chopin-ai/harness-pi", "@chopin-ai/harness-dsh"];
for (const name of packages) {
  const entry = await realpath(fileURLToPath(import.meta.resolve(name)));
  assert(entry.startsWith(join(root, "node_modules") + sep), `${name} escaped the installed consumer`);
  await import(name);
}
await import("@chopin-ai/harness-dsh/run");
await import("@chopin-ai/harness-pi/keys");
await import("@chopin-ai/harness-pi/acp");
const cli = join(root, "node_modules/chopin-ai/dist/bin.js");
const { stdout } = await promisify(execFile)(process.execPath, [cli, "help"], {
  env: { ...process.env, CHOPIN_HOME: join(root, "home") },
});
assert.match(stdout, /usage: chopin/);

const data = join(root, "data");
const sealed = join(data, "sealed");
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });
const key = randomBytes(32);
const token = randomUUID();
const marker = `private-package-check-${randomUUID()}`;
const failures = [];
async function open() {
  const service = new AgentService({ dataDir: data, workspaces: new DirectoryWorkspaceProvider(workspace),
    models: () => createModels({ credentials: new InMemoryCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } }),
    store: () => openSealedStore({ dir: sealed, key: Buffer.from(key), report: (error) => failures.push(error) }),
    report: (error) => failures.push(error),
  });
  const server = await listen(service, { authenticate: launchToken(token) });
  const client = connect(`ws://127.0.0.1:${server.port}/`, { token });
  return { service, client, server, close: async () => { await client.close(); await server.close(); await service.close(context); } };
}

let conversationId;
let entryId;
const first = await open();
try {
  const unauthorized = await fetch(`http://127.0.0.1:${first.server.port}/status`);
  assert.equal(unauthorized.status, 401);
  await unauthorized.text();
  const list = await first.client.get(Conversations, {});
  conversationId = await first.client.root((ctx) => list.create(ctx));
  const harness = await first.service.harness("local");
  const conversation = await harness.conversation(conversationId, context);
  assert(conversation);
  const entry = await conversation.commit((tx) => tx.appendEntry(conversationId, { kind: "package-check", data: { marker } }), context);
  entryId = entry.id;
  const remote = await first.client.get(Conversation, { conversation: conversationId });
  const page = await first.client.root((ctx) => remote.entries({ limit: 1 }, ctx));
  assert.equal(page.entries[0]?.id, entryId);
  assert.equal(page.entries[0]?.data.marker, marker);
} finally { await first.close(); }

for (const file of await readdir(sealed, { withFileTypes: true })) {
  if (file.isFile()) assert(!(await readFile(join(sealed, file.name))).includes(Buffer.from(marker)), "committed content appeared unencrypted");
}
await assert.rejects(openSealedStore({ dir: sealed, key: randomBytes(32) }));

const reopened = await open();
try {
  const remote = await reopened.client.get(Conversation, { conversation: conversationId });
  const page = await reopened.client.root((ctx) => remote.entries({ limit: 1 }, ctx));
  assert.equal(page.entries[0]?.id, entryId);
  assert.equal(page.entries[0]?.data.marker, marker);
  assert.deepEqual(failures, []);
} finally { await reopened.close(); }
console.log(JSON.stringify({ packages: true, cli: true, authenticated_transport: true, encrypted_commit: true, store_reopen: true, wrong_key_refused: true, model_quality: "not_evaluated" }));
