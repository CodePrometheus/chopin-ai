import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ContainerWorkspaceProvider } from "@chopin-ai/workspace";
import { describe, expect, it } from "vitest";
import { AgentService } from "../src/index.js";

const image = process.env.CHOPIN_TEST_PI_IMAGE;
const run = promisify(execFile);

/** Runs against the real container engine only when a workspace image with the daemon is named. */
describe.runIf(image)("AgentService", () => {
  it("runs the agent's tools in the owner's workspace and keeps the conversation across restarts", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const workspaces = new ContainerWorkspaceProvider({ image: image ?? "", prefix: "chopin-test" });
    const owner = `test-${process.pid}`;
    const dataDir = await mkdtemp(join(tmpdir(), "chopin-service-"));
    const options = { dataDir, workspaces, models: () => models, agent: { model: { provider: model.provider, modelId: model.id } } };

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo hello > hello.txt && cat hello.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Wrote hello.txt."),
    ]);
    const service = new AgentService(options);
    try {
      const root = await (await service.harness(owner)).root(context);
      const settled = await (await root.submit({ type: "input", content: "Write hello.txt" }, context)).wait(context);
      expect(settled.status).toBe("done");
      expect(service.lastActive(owner)).toBeTypeOf("number");

      const [binary, ...args] = workspaces.open(owner).command(["cat", "/workspace/hello.txt"]).argv;
      expect((await run(binary ?? "", args)).stdout).toBe("hello\n");
      await service.close(context);

      const reopened = new AgentService(options);
      faux.setResponses([fauxAssistantMessage("Nothing to do.")]);
      const other = `${owner}-quiet`;
      const quiet = await reopened.runTask(other, "Answer without tools.", context);
      expect(quiet.diff).toBeUndefined();
      await workspaces.open(other).destroy();

      const entries = (await (await (await reopened.harness(owner)).root(context)).context(context)).entries;
      expect(entries.map((entry) => entry.kind)).toContain("pi.tool-result");
      await reopened.close(context);
    } finally {
      await service.close(context);
      await workspaces.open(owner).destroy();
    }
  }, 120_000);
});
