import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Workspace, WorkspaceProvider, WorkspaceState } from "@chopin-ai/workspace";
import { describe, expect, it } from "vitest";
import { AgentService } from "../src/index.js";

describe("AgentService idle reclaim", () => {
  it("stops the workspaces of idle owners on its own, and stops sweeping once closed", async () => {
    const states = new Map<string, WorkspaceState>([["alice", "running"], ["bob", "stopped"]]);
    const workspace = (owner: string): Workspace => ({
      owner, root: "/",
      state: async () => states.get(owner) ?? "absent",
      start: async () => void states.set(owner, "running"),
      pause: async () => {}, destroy: async () => {}, command: (argv, env = {}) => ({ argv: [...argv], env: { ...env } }),
      stop: async () => void states.set(owner, "stopped"),
    });
    const workspaces: WorkspaceProvider = { open: workspace, list: async () => [...states.keys()].map(workspace) };
    const service = new AgentService({ dataDir: tmpdir(), workspaces, models: () => createModels(), reclaimAfterMs: 20 });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(states.get("alice")).toBe("stopped");

    await service.close(context);
    states.set("alice", "running");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(states.get("alice")).toBe("running");
  });

  it("leaves an owner's workspace running while its agent still has work, however long it takes", async () => {
    const states = new Map<string, WorkspaceState>([["alice", "running"]]);
    const workspace = (owner: string): Workspace => ({
      owner, root: "/",
      state: async () => states.get(owner) ?? "absent",
      start: async () => void states.set(owner, "running"),
      pause: async () => {}, destroy: async () => {}, command: (argv, env = {}) => ({ argv: [...argv], env: { ...env } }),
      stop: async () => void states.set(owner, "stopped"),
    });
    const workspaces: WorkspaceProvider = { open: workspace, list: async () => [...states.keys()].map(workspace) };
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const asked = Promise.withResolvers<() => void>();
    faux.setResponses([() => new Promise((resolve) => asked.resolve(() => resolve(fauxAssistantMessage("Done."))))]);
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-reclaim-")), workspaces, models: () => models, reclaimAfterMs: 20,
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    try {
      const conversation = await service.newConversation("alice", context);
      const submission = await conversation.submit({ type: "input", content: "Think for a while." }, context);
      const answer = await asked.promise;
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(states.get("alice")).toBe("running");

      answer();
      await submission.wait(context);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(states.get("alice")).toBe("stopped");
    } finally {
      await service.close(context);
    }
  });

  it("closes an idle agent no client holds and opens it again on next use, but keeps one a client holds", async () => {
    const workspaces: WorkspaceProvider = { open: (owner) => ({
      owner, root: "/", state: async () => "stopped", start: async () => {}, pause: async () => {}, stop: async () => {},
      destroy: async () => {}, command: (argv, env = {}) => ({ argv: [...argv], env: { ...env } }),
    }), list: async () => [] };
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-reclaim-")), workspaces, models: () => createModels(), reclaimAfterMs: 20,
    });
    try {
      const loose = await service.harness("alice");
      const held = await service.hold("bob");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(await service.harness("alice")).not.toBe(loose);
      expect(await service.harness("bob")).toBe(held);
      service.release("bob");
    } finally {
      await service.close(context);
    }
  });
});
