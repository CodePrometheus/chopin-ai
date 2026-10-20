import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { chopinMeta } from "@chopin-ai/core";
import { describe, expect, it } from "vitest";
import { AgentService } from "../src/index.js";
import { localWorkspace } from "./local-workspace.js";

const exec = promisify(execFile);
const git = async (args: string[]) => (await exec("git", args)).stdout;

describe("AgentService.runTask", () => {
  it("returns the run as ACP updates and the change it made as a patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "chopin-task-"));
    await git(["-C", root, "init", "--quiet"]);
    await git(["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "--allow-empty", "-m", "base"]);

    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "answer.txt", content: "42\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Wrote the answer."),
    ]);
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-task-data-")), workspaces: localWorkspace(root), models: () => models,
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    try {
      const { transcript, diff } = await service.runTask("alice", "Write the answer.", context);
      const updates = transcript.flatMap((entry) => ("notification" in entry ? [entry.notification.update.sessionUpdate] : []));
      expect(updates).toEqual(["user_message_chunk", "tool_call", "tool_call_update", "agent_message_chunk"]);

      const end = transcript.at(-1);
      if (end === undefined || !("turnEnd" in end)) throw new Error("the transcript must end with the turn's end");
      expect(end.turnEnd.stopReason).toBe("end_turn");
      expect(end.turnEnd.usage?.totalTokens).toBeGreaterThan(0);
      expect(chopinMeta(end.turnEnd)).toMatchObject({ model: { provider: model.provider, id: model.id } });

      expect(Buffer.from(diff ?? []).toString("utf8")).toContain("+++ b/answer.txt");
      expect(Buffer.from(diff ?? []).toString("utf8")).toContain("+42");
      expect(await git(["-C", root, "status", "--porcelain"])).toBe("?? answer.txt\n");
    } finally {
      await service.close(context);
    }
  });
});
