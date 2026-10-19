import { ContainerWorkspaceProvider } from "@chopin-ai/workspace";
import { describe, expect, it } from "vitest";
import { runTask } from "../src/run.js";

const image = process.env.CHOPIN_TEST_DSH_IMAGE;

/** Runs the harness for real inside the workspace image, without model credentials: the run fails, the record does not. */
describe.runIf(image)("runTask in the dsh workspace image", () => {
  it("returns what the plugin recorded, even for a run the model never answered", async () => {
    const workspace = new ContainerWorkspaceProvider({ image: image ?? "", prefix: "chopin-test" }).open(`dsh-${process.pid}`);
    try {
      const { transcript, diff } = await runTask(workspace, "Say hi.", { profile: "chopin", transcripts: "/tmp/chopin-transcripts" });
      const updates = transcript.flatMap((entry) => ("notification" in entry ? [entry.notification.update] : []));
      expect(updates).toEqual([{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Say hi." } }]);
      const end = transcript.at(-1);
      expect(end !== undefined && "turnEnd" in end && end.turnEnd._meta).toMatchObject({ "chopin-ai": { error: expect.stringContaining("no API key") } });
      expect(diff).toBeUndefined();
    } finally {
      await workspace.destroy();
    }
  }, 180_000);
});
