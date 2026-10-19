import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chopinMeta } from "@chopin-ai/core";
import type { Workspace } from "@chopin-ai/workspace";
import { describe, expect, it } from "vitest";
import { runTask } from "../src/run.js";

/** A workspace at `root` whose harness command is the given script; like every workspace, it runs commands in its root. */
function inRoot(root: string, dsh: string): Workspace {
  return {
    owner: "alice", root, state: async () => "running",
    start: async () => {}, pause: async () => {}, stop: async () => {}, destroy: async () => {},
    command: (argv) => ({ argv: ["sh", "-c", 'cd "$1" && shift && exec "$@"', "sh", root, ...(argv[0] === "dsh" ? [dsh, ...argv.slice(1)] : argv)], env: {} }),
  };
}

describe("runTask", () => {
  it("runs dsh headless in the workspace and returns the transcript its plugin recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "chopin-dsh-run-"));
    const transcripts = join(root, "transcripts");
    const dsh = join(root, "fake-dsh");
    // Stands in for the harness's JSON mode: opens with the session event and leaves the plugin's transcript behind.
    await writeFile(dsh, [
      "#!/bin/sh",
      '[ "$(cat)" = "Do it." ] || exit 9',
      "echo 'not an event'",
      `mkdir -p ${transcripts}`,
      `echo '{"at":"t","sessionId":"session-1","turnEnd":{"stopReason":"end_turn"}}' > ${transcripts}/session-1.jsonl`,
      `echo '{"type":"session","sessionId":"session-1","cwd":"${root}"}'`,
      `echo '{"type":"final","text":"done"}'`,
    ].join("\n"));
    await chmod(dsh, 0o755);
    const workspace = inRoot(root, dsh);
    const { transcript, diff } = await runTask(workspace, "Do it.", { profile: "chopin", transcripts });
    expect(transcript).toEqual([{ at: "t", sessionId: "session-1", turnEnd: { stopReason: "end_turn" } }]);
    expect(diff).toBeUndefined();
  });

  it("marks a run dsh did not finish as failed, keeping what it recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "chopin-dsh-run-"));
    const transcripts = join(root, "transcripts");
    const dsh = join(root, "fake-dsh");
    const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } };
    const said = JSON.stringify({ at: "t", notification: { sessionId: "session-2", update } });
    await writeFile(dsh, [
      "#!/bin/sh",
      "cat >/dev/null",
      `mkdir -p ${transcripts}`,
      `printf '%s\\n{"at":' '${said}' > ${transcripts}/session-2.jsonl`,
      `echo '{"type":"session","sessionId":"session-2","cwd":"${root}"}'`,
      "echo boom >&2",
      "exit 3",
    ].join("\n"));
    await chmod(dsh, 0o755);
    const workspace = inRoot(root, dsh);
    const { transcript } = await runTask(workspace, "Do it.", { profile: "chopin", transcripts });
    expect(transcript).toHaveLength(2);
    expect(transcript[0]).toEqual(JSON.parse(said));
    const end = transcript[1];
    expect(end !== undefined && "turnEnd" in end ? chopinMeta(end.turnEnd)?.error : undefined).toBe("dsh exited with 3: boom");
  });

  it("returns a run that stopped before recording anything as failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "chopin-dsh-run-"));
    const dsh = join(root, "fake-dsh");
    await writeFile(dsh, [
      "#!/bin/sh",
      `echo '{"type":"session","sessionId":"session-3","cwd":"${root}"}'`,
      "kill -9 $$",
    ].join("\n"));
    await chmod(dsh, 0o755);
    const workspace = inRoot(root, dsh);
    const { transcript } = await runTask(workspace, "Do it.", { profile: "chopin", transcripts: join(root, "none") });
    expect(transcript).toHaveLength(1);
    const end = transcript[0];
    expect(end !== undefined && "turnEnd" in end ? chopinMeta(end.turnEnd)?.error : undefined).toBe("dsh exited with 137: ");
  });
});
