import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Workspace, WorkspaceProvider } from "@chopin-ai/workspace";
import { describe, expect, it } from "vitest";
import { AgentService } from "../src/index.js";

const nowhere: WorkspaceProvider = {
  open: (owner): Workspace => ({
    owner, root: "/", state: async () => "running",
    start: async () => {}, pause: async () => {}, stop: async () => {}, destroy: async () => {}, command: (argv, env = {}) => ({ argv: [...argv], env: { ...env } }),
  }),
  list: async () => [],
};

describe("AgentService.submissions", () => {
  it("lists every input not settled yet, however many came after it, besides the latest", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const asked = Promise.withResolvers<() => void>();
    faux.setResponses([
      () => new Promise((resolve) => asked.resolve(() => resolve(fauxAssistantMessage("Done.")))),
      ...Array.from({ length: 5 }, () => fauxAssistantMessage("Queued, then done.")),
    ]);
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-store-")), workspaces: nowhere, models: () => models,
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    try {
      const conversation = await service.newConversation("alice", context);
      const running = await conversation.submit({ type: "input", content: "Think." }, context);
      const answer = await asked.promise;
      const queued = [];
      for (let i = 0; i < 5; i++) queued.push(await conversation.submit({ type: "input", content: `Then ${i}.` }, context));

      const listed = await service.submissions("alice", conversation.id, 2);
      const ids = listed.map((record) => Number(record.id));
      expect(ids).toContain(Number(running.id));
      for (const submission of queued) expect(ids).toContain(Number(submission.id));
      expect(listed.every((record) => record.type === "input")).toBe(true);

      answer();
      await running.wait(context);
    } finally {
      await service.close(context);
    }
  });
});
