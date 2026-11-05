import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Workspace, WorkspaceProvider } from "@chopin-ai/workspace";
import { describe, expect, it } from "vitest";
import { AgentService, openSealedStore, seal, subkey, unseal, Unsealable } from "../src/index.js";

const nowhere: WorkspaceProvider = {
  open: (owner): Workspace => ({
    owner, root: "/", state: async () => "running",
    start: async () => {}, pause: async () => {}, stop: async () => {}, destroy: async () => {}, command: (argv, env = {}) => ({ argv: [...argv], env: { ...env } }),
  }),
  list: async () => [],
};
const KILLED = fileURLToPath(new URL("./fixtures/commit-until-killed.mjs", import.meta.url));

/** A service whose one store is sealed in `dir`, answering every message with `reply`. */
async function sealedService(dir: string, key: Uint8Array, reply = "a reply", report?: (error: Error) => void) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(reply)]);
  const model = faux.getModel();
  return new AgentService({
    dataDir: await mkdtemp(join(tmpdir(), "chopin-sealed-data-")), workspaces: nowhere, models: () => models,
    agent: { model: { provider: model.provider, modelId: model.id } },
    store: () => openSealedStore({ dir, key, ...(report !== undefined && { report }) }),
  });
}

/** Whether any file under `dir` holds `text` as it was written. */
async function holds(dir: string, text: string): Promise<boolean> {
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && (await readFile(join(entry.parentPath, entry.name))).includes(text)) return true;
  }
  return false;
}

/** The journal's records as its file holds them: header and sealed record each. */
function records(journal: Buffer): Buffer[] {
  const found: Buffer[] = [];
  for (let at = 0; at < journal.length;) {
    const length = 12 + journal.readUInt32BE(at);
    found.push(journal.subarray(at, at + length));
    at += length;
  }
  return found;
}

/** A store left as a stop leaves it, before any snapshot folded its journal: a copy of `dir` while its service runs. */
async function stoppedCopy(dir: string): Promise<string> {
  const copy = await mkdtemp(join(tmpdir(), "chopin-sealed-copy-"));
  await cp(dir, copy, { recursive: true });
  return copy;
}

async function names(service: AgentService): Promise<string[]> {
  return (await service.summaries("local", context)).map(({ first }) => first);
}

describe("sealing", () => {
  it("opens only under the key and for the context it was sealed with", () => {
    const key = randomBytes(32);
    const sealed = seal(key, "a context", Buffer.from("secret"));
    expect(unseal(key, "a context", sealed).toString()).toBe("secret");
    expect(sealed.includes("secret")).toBe(false);
    expect(() => unseal(key, "another context", sealed)).toThrow(Unsealable);
    expect(() => unseal(randomBytes(32), "a context", sealed)).toThrow(Unsealable);
    expect(() => unseal(key, "a context", Buffer.from([...sealed.subarray(0, 20), sealed[20]! ^ 1, ...sealed.subarray(21)]))).toThrow(Unsealable);
    expect(subkey(key, "store")).not.toEqual(subkey(key, "home"));
  });
});

describe("a sealed store", () => {
  it("keeps conversations sealed at rest, and opens them again with its key alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chopin-sealed-"));
    const key = randomBytes(32);
    const first = await sealedService(dir, key, "the sealed reply");
    const conversation = await first.newConversation("local", context);
    await (await conversation.submit({ type: "input", content: "the sealed question" }, context)).wait(context);
    // Durable before it is seen, and sealed on the way.
    expect((await readFile(join(dir, "journal"))).length).toBeGreaterThan(0);
    for (const text of ["the sealed question", "the sealed reply"]) expect(await holds(dir, text)).toBe(false);
    await first.close(context);
    // Closing folds the journal into the snapshot.
    expect((await readFile(join(dir, "journal"))).length).toBe(0);
    expect((await readdir(dir)).sort()).toEqual(["journal", "snapshot"]);

    const again = await sealedService(dir, key);
    try {
      expect(await names(again)).toEqual(["the sealed question"]);
      const reopened = await again.harness("local");
      const transcript = await again.transcript("local", (await reopened.conversation(conversation.id, context))!, context);
      expect(JSON.stringify(transcript)).toContain("the sealed reply");
    } finally {
      await again.close(context);
    }
    await expect(openSealedStore({ dir, key: randomBytes(32) })).rejects.toThrow("snapshot");
  });

  it("replays its journal after a stop that left no snapshot of its last commits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chopin-sealed-"));
    const key = randomBytes(32);
    const running = await sealedService(dir, key);
    try {
      await (await (await running.newConversation("local", context)).submit({ type: "input", content: "before the stop" }, context)).wait(context);
      const stopped = await stoppedCopy(dir);
      expect((await readFile(join(stopped, "journal"))).length).toBeGreaterThan(0);
      const reported: Error[] = [];
      const after = await sealedService(stopped, key, "a reply", (error) => reported.push(error));
      try {
        expect(await names(after)).toEqual(["before the stop"]);
        expect(reported).toEqual([]);
      } finally {
        await after.close(context);
      }
    } finally {
      await running.close(context);
    }
  });

  it("refuses a snapshot or journal changed, reordered or spliced, and drops a record a stop cut short", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chopin-sealed-"));
    const key = randomBytes(32);
    const running = await sealedService(dir, key);
    let stopped: string;
    try {
      await (await (await running.newConversation("local", context)).submit({ type: "input", content: "kept" }, context)).wait(context);
      await running.newConversation("local", context);
      stopped = await stoppedCopy(dir);
    } finally {
      await running.close(context);
    }
    const journal = await readFile(join(stopped, "journal"));
    const kept = records(journal);
    expect(kept.length).toBeGreaterThan(2);
    const variant = async (change: (dir: string) => Promise<void>) => {
      const copy = await stoppedCopy(stopped);
      await change(copy);
      return copy;
    };
    const swapped = await variant((at) => writeFile(join(at, "journal"), Buffer.concat([kept[1]!, kept[0]!, ...kept.slice(2)])));
    await expect(openSealedStore({ dir: swapped, key })).rejects.toThrow("holds record 1 where record 0 belongs");
    const removed = await variant((at) => writeFile(join(at, "journal"), Buffer.concat([kept[0]!, ...kept.slice(2)])));
    await expect(openSealedStore({ dir: removed, key })).rejects.toThrow("holds record 2 where record 1 belongs");
    const changed = await variant(async (at) => {
      const bytes = Buffer.from(journal);
      bytes[kept[0]!.length + 40]! ^= 1;
      await writeFile(join(at, "journal"), bytes);
    });
    await expect(openSealedStore({ dir: changed, key })).rejects.toThrow("record 1 of the store's journal does not open");
    const snapshot = await variant(async (at) => {
      const bytes = await readFile(join(at, "snapshot"));
      bytes[bytes.length - 1]! ^= 1;
      await writeFile(join(at, "snapshot"), bytes);
    });
    await expect(openSealedStore({ dir: snapshot, key })).rejects.toThrow("the store's snapshot");
    const orphan = await mkdtemp(join(tmpdir(), "chopin-sealed-"));
    await cp(join(stopped, "journal"), join(orphan, "journal"));
    await expect(openSealedStore({ dir: orphan, key })).rejects.toThrow("has a journal but no snapshot");

    // A last record cut short was never acknowledged: it is dropped and told, and the rest stands.
    const cut = await variant((at) => writeFile(join(at, "journal"), journal.subarray(0, journal.length - 5)));
    const reported: Error[] = [];
    const service = await sealedService(cut, key, "a reply", (error) => reported.push(error));
    try {
      expect(await names(service)).toContain("kept");
      expect(reported.map(({ message }) => message)).toEqual([expect.stringContaining(`ends within its record ${kept.length - 1}`)]);
    } finally {
      await service.close(context);
    }
  });

  it("loses no acknowledged commit, and applies none twice, however often it is killed midway", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chopin-sealed-"));
    const dataDir = await mkdtemp(join(tmpdir(), "chopin-sealed-data-"));
    await mkdir(dir, { recursive: true });
    const key = randomBytes(32);
    const acknowledged = new Set<number>();
    for (const after of [7, 23, 41]) {
      const child = spawn(process.execPath, [KILLED, dir, dataDir, key.toString("hex")], { stdio: ["ignore", "pipe", "inherit"] });
      let lines = "";
      await new Promise<void>((resolve, reject) => {
        child.once("exit", (code) => reject(new Error(`the child ended on its own with ${code}`)));
        child.stdout.on("data", (chunk: Buffer) => {
          lines += chunk.toString();
          const ids = lines.split("\n").slice(0, -1);
          if (ids.length >= after) {
            child.kill("SIGKILL");
            resolve();
          }
        });
      });
      await once(child, "exit");
      for (const id of lines.split("\n").slice(0, -1)) acknowledged.add(Number(id));
    }
    const reported: Error[] = [];
    const service = await sealedService(dir, key, "a reply", (error) => reported.push(error));
    try {
      const kept = await service.conversations("local");
      expect(new Set(kept).size).toBe(kept.length);
      for (const id of acknowledged) expect(kept).toContain(id);
      // Each kill may leave one commit flushed but not yet acknowledged; nothing beyond that appears.
      expect(kept.length).toBeLessThanOrEqual(acknowledged.size + 3);
      expect(reported.filter(({ message }) => message.includes("did not apply"))).toEqual([]);
    } finally {
      await service.close(context);
    }
  }, 60_000);
});
