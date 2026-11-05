import { timingSafeEqual } from "node:crypto";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Workspace, WorkspaceProvider } from "@chopin-ai/workspace";
import { describe, expect, it } from "vitest";
import { AgentService, launchToken, listen, WrongKey, type Sealed } from "../src/index.js";
import { createDataKey, serviceKey } from "../src/keys.js";
import { connect, Conversations, Loop, Mcp, unlock, Vault } from "../src/protocol.js";

const nowhere: WorkspaceProvider = {
  open: (owner): Workspace => ({
    owner, root: "/", state: async () => "running",
    start: async () => {}, pause: async () => {}, stop: async () => {}, destroy: async () => {}, command: (argv, env = {}) => ({ argv: [...argv], env: { ...env } }),
  }),
  list: async () => [],
};

async function agentService(dataDir: string, keepClientMcp = false): Promise<AgentService> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return new AgentService({
    dataDir, workspaces: nowhere, models: () => models, keepClientMcp,
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
}

function until<T>(subscribe: (listener: (value: T) => void) => () => void, test: (value: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    const stop = subscribe((value) => {
      if (test(value)) {
        queueMicrotask(() => stop());
        resolve(value);
      }
    });
  });
}

describe("a sealed service", () => {
  it("serves the vault alone until a client unlocks it with the key it was first unlocked with", async () => {
    const owner = await createDataKey("passphrase");
    const expected = Buffer.from(await serviceKey(owner.key), "base64url");
    const dataDir = await mkdtemp(join(tmpdir(), "chopin-sealed-"));
    let service: AgentService | undefined;
    const sealed: Sealed = {
      get service() {
        return service;
      },
      unlock: async (key) => {
        if (!timingSafeEqual(Buffer.from(key), expected)) throw new WrongKey();
        service ??= await agentService(dataDir);
      },
    };
    const server = await listen(sealed, { authenticate: launchToken("secret") });
    const status = async () => (await fetch(`http://127.0.0.1:${server.port}/status`, { headers: { authorization: "Bearer secret" } })).json();
    const client = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    const other = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    try {
      const vault = await client.get(Vault, {});
      const theirs = await other.get(Vault, {});
      expect(vault.locked.value).toBe(true);
      expect(await status()).toEqual({ busy: false, locked: true });
      // Nothing of the owner's is served before, the loop's records included.
      await expect(client.get(Conversations, {})).rejects.toThrow("locked");
      await expect(client.get(Loop, {})).rejects.toThrow("locked");
      const stranger = await createDataKey("another passphrase");
      await expect(unlock(client, stranger.key)).rejects.toThrow("wrong_key");
      expect(service).toBeUndefined();

      await unlock(client, owner.key);
      // Every client holding the vault learns it is open.
      await until(theirs.locked.subscribe.bind(theirs.locked), (locked) => !locked);
      expect(vault.locked.value).toBe(false);
      expect(await status()).toEqual({ busy: false, locked: false });
      const conversations = await client.get(Conversations, {});
      expect(await client.root((ctx) => conversations.create(ctx))).toBeTypeOf("number");
      // Unlocking again once open does no harm; a wrong key is refused still.
      await client.root(async (ctx) => vault.unlock({ key: await serviceKey(owner.key) }, ctx));
      await expect(client.root(async (ctx) => vault.unlock({ key: await serviceKey(stranger.key) }, ctx))).rejects.toThrow("wrong_key");
    } finally {
      await client.close();
      await other.close();
      await server.close();
      await service?.close(context);
    }
  });

  it("is never locked when it seals nothing, and takes no key", async () => {
    const service = await agentService(await mkdtemp(join(tmpdir(), "chopin-unsealed-")));
    const server = await listen(service, { authenticate: launchToken("secret") });
    const client = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    try {
      const vault = await client.get(Vault, {});
      expect(vault.locked.value).toBe(false);
      // The helper asks nothing of a service that is open.
      await unlock(client, (await createDataKey("passphrase")).key);
      await expect(client.root(async (ctx) => vault.unlock({ key: "A".repeat(43) }, ctx))).rejects.toThrow("not_sealed");
    } finally {
      await client.close();
      await server.close();
      await service.close(context);
    }
  });
});

describe("an agent service's store", () => {
  it("keeps the MCP servers clients set beside the store only when told to, so they outlast a restart", async () => {
    const kept = await mkdtemp(join(tmpdir(), "chopin-kept-mcp-"));
    const first = await agentService(kept, true);
    const server = await listen(first, { authenticate: launchToken("secret") });
    const client = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    try {
      const mcp = await client.get(Mcp, {});
      await client.root((ctx) => mcp.set({ name: "tools", url: "http://127.0.0.1:9/mcp", headers: { authorization: "Bearer kept" } }, ctx));
      await until(mcp.servers.subscribe.bind(mcp.servers), (servers) => servers.some(({ name }) => name === "tools"));
    } finally {
      await client.close();
      await server.close();
      await first.close(context);
    }
    const again = await agentService(kept, true);
    try {
      expect((await again.mcpServers("local")).map(({ name, url }) => ({ name, url }))).toEqual([{ name: "tools", url: "http://127.0.0.1:9/mcp" }]);
      await again.removeMcpServer("local", "tools");
    } finally {
      await again.close(context);
    }
    expect(await (await agentService(kept, true)).mcpServers("local")).toEqual([]);

    // In memory alone otherwise: nothing beside the store names the server.
    const memory = await mkdtemp(join(tmpdir(), "chopin-memory-mcp-"));
    const service = await agentService(memory);
    try {
      expect(await service.setMcpServer("local", "tools", "http://127.0.0.1:9/mcp", { authorization: "Bearer kept" })).toBeUndefined();
      expect((await readdir(memory)).filter((name) => name.endsWith(".mcp.json"))).toEqual([]);
    } finally {
      await service.close(context);
    }
  });

  it("says a file of kept MCP servers it cannot read holds none, without quoting its headers", async () => {
    const kept = await mkdtemp(join(tmpdir(), "chopin-kept-mcp-"));
    const service = await agentService(kept, true);
    try {
      await service.setMcpServer("local", "tools", "http://127.0.0.1:9/mcp", { authorization: "Bearer cut-short" });
      const [file] = (await readdir(kept)).filter((name) => name.endsWith(".mcp.json"));
      await writeFile(join(kept, file ?? ""), "Bearer cut-short");
      const refused = await (await agentService(kept, true)).mcpServers("local").then(() => undefined, (error: Error) => error.message);
      expect(refused).toBe(`${join(kept, file ?? "")} holds no MCP servers`);
    } finally {
      await service.close(context);
    }
  });
});
