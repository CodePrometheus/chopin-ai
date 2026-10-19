import { describe, expect, it } from "vitest";
import { ContainerWorkspaceProvider } from "../src/index.js";

const image = process.env.CHOPIN_TEST_WORKSPACE_IMAGE;

/** Runs against the real engine only when an image that keeps running on its own is named. */
describe.runIf(image)("ContainerWorkspaceProvider on the real engine", () => {
  it("goes through the whole lifecycle and keeps files across a stop", async () => {
    const provider = new ContainerWorkspaceProvider({ image: image ?? "", prefix: "chopin-test" });
    const workspace = provider.open(`test-${process.pid}`);
    const run = async (script: string, env?: Record<string, string>) => {
      const { argv: [binary, ...args], env: carried } = workspace.command(["sh", "-c", script], env);
      const { execFile } = await import("node:child_process");
      return new Promise<string>((resolve, reject) =>
        execFile(binary ?? "", args, { env: { ...process.env, ...carried } }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
    };
    try {
      await workspace.start();
      expect(await workspace.state()).toBe("running");
      await run("echo kept > note.txt");
      // A variable reaches the command under its own name, PATH included, and the launcher keeps its own.
      expect(await run('echo "$TOKEN|$CHOPIN_ENV_TOKEN|$PATH"', { TOKEN: "a b", PATH: "/usr/bin:/bin" })).toBe("a b||/usr/bin:/bin\n");

      await workspace.pause();
      expect(await workspace.state()).toBe("paused");
      await workspace.stop();
      expect(await workspace.state()).toBe("stopped");

      await workspace.start();
      expect(await run("cat note.txt")).toBe("kept\n");
      expect((await provider.list()).map((w) => w.owner)).toContain(workspace.owner);
    } finally {
      await workspace.destroy();
    }
    expect(await workspace.state()).toBe("absent");
  }, 60_000);
});
