import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { localDaemon } from "@earendil-works/pi-env";
import { parseTranscript } from "@chopin-ai/core";
import { AgentService } from "@chopin-ai/harness-pi";
import { DirectoryWorkspaceProvider } from "@chopin-ai/workspace";
import { describe, expect, it } from "vitest";
import { exportTranscripts } from "../src/rsi/export.js";

describe("exportTranscripts", () => {
  it("writes changed conversations as ACP transcripts, once each change, without counting as activity", async () => {
    const root = await mkdtemp(join(tmpdir(), "chopin-export-"));
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    faux.setResponses([fauxAssistantMessage("Hi."), fauxAssistantMessage("Again.")]);
    const service = new AgentService({
      dataDir: join(root, "data"), workspaces: new DirectoryWorkspaceProvider(root), daemon: localDaemon(),
      models: () => models, agent: { model: { provider: model.provider, modelId: model.id } },
    });
    try {
      const conversation = await service.newConversation("local", context);
      await (await conversation.submit({ type: "input", content: "Hello." }, context)).wait(context);
      const directory = join(root, "transcripts");
      const active = service.lastActive("local");

      expect(await exportTranscripts(service, directory)).toBe(1);
      const written = parseTranscript(await readFile(join(directory, `${conversation.id}.jsonl`), "utf8"));
      const said = written.flatMap((entry) => "notification" in entry && "content" in entry.notification.update
        ? [(entry.notification.update.content as { text?: string }).text] : []);
      expect(said).toEqual(["Hello.", "Hi."]);
      expect(service.lastActive("local")).toBe(active);

      expect(await exportTranscripts(service, directory)).toBe(0);
      await sleep(5);
      await (await conversation.submit({ type: "input", content: "Once more." }, context)).wait(context);
      expect(await exportTranscripts(service, directory)).toBe(1);
    } finally {
      await service.close(context);
    }
  });
});
