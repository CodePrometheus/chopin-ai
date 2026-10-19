import { describe, expect, it } from "vitest";
import { ContainerWorkspaceProvider, reclaimIdle, type ContainerCli, type Workspace, type WorkspaceProvider } from "../src/index.js";

/** A container engine reduced to the calls the provider makes. */
function fakeEngine() {
  const containers = new Map<string, { state: string; owner: string; provider: string }>();
  const volumes = new Set<string>();
  const calls: string[][] = [];
  const label = (args: readonly string[], key: string) =>
    args.flatMap((arg, i) => (args[i - 1] === "--label" && arg.startsWith(`${key}=`) ? [arg.slice(key.length + 1)] : []))[0] ?? "";
  const cli: ContainerCli = async (args) => {
    calls.push([...args]);
    const [command, ...rest] = args;
    const name = rest.at(-1) ?? "";
    switch (command) {
      case "ps": {
        const filter = rest[rest.indexOf("--filter") + 1] ?? "";
        if (filter.startsWith("name=")) return containers.get(filter.slice("name=^".length, -1))?.state ?? "";
        const provider = filter.split("=").at(-1);
        return [...containers.values()].filter((c) => c.provider === provider).map((c) => c.owner).join("\n");
      }
      case "volume":
        if (rest[0] === "create") volumes.add(name);
        if (rest[0] === "rm") volumes.delete(name);
        return "";
      case "create":
        containers.set(rest[rest.indexOf("--name") + 1] ?? "", {
          state: "created", owner: label(rest, "chopin.owner"), provider: label(rest, "chopin.provider"),
        });
        return "";
      case "rm":
        containers.delete(name);
        return "";
      default: {
        const next = { start: "running", unpause: "running", pause: "paused", stop: "exited" }[command ?? ""];
        const container = containers.get(name);
        if (next === undefined || container === undefined) throw new Error(`unexpected: ${args.join(" ")}`);
        container.state = next;
        return "";
      }
    }
  };
  return { cli, calls, containers, volumes };
}

describe("ContainerWorkspaceProvider", () => {
  it("creates the container and volume on first start and keeps the volume when stopped", async () => {
    const engine = fakeEngine();
    const workspace = new ContainerWorkspaceProvider({ image: "img", cli: engine.cli }).open("alice");
    expect(await workspace.state()).toBe("absent");

    await workspace.start();
    expect(await workspace.state()).toBe("running");
    expect(engine.volumes.size).toBe(1);

    await workspace.stop();
    expect(await workspace.state()).toBe("stopped");
    expect(engine.volumes.size).toBe(1);

    await workspace.start();
    expect(engine.calls.filter(([command]) => command === "create")).toHaveLength(1);
  });

  it("resumes a paused workspace instead of booting it", async () => {
    const engine = fakeEngine();
    const workspace = new ContainerWorkspaceProvider({ image: "img", cli: engine.cli }).open("alice");
    await workspace.start();
    await workspace.pause();
    expect(await workspace.state()).toBe("paused");
    await workspace.start();
    expect(engine.calls.at(-1)?.[0]).toBe("unpause");
    expect(await workspace.state()).toBe("running");
  });

  it("removes the volume only on destroy", async () => {
    const engine = fakeEngine();
    const workspace = new ContainerWorkspaceProvider({ image: "img", cli: engine.cli }).open("alice");
    await workspace.start();
    await workspace.destroy();
    expect(await workspace.state()).toBe("absent");
    expect(engine.volumes.size).toBe(0);
  });

  it("gives each owner its own container and lists only its own provider's workspaces", async () => {
    const engine = fakeEngine();
    const ours = new ContainerWorkspaceProvider({ image: "img", cli: engine.cli });
    const theirs = new ContainerWorkspaceProvider({ image: "img", prefix: "other", cli: engine.cli });
    await ours.open("alice").start();
    await ours.open(" bob ").start();
    await theirs.open("carol").start();
    expect(engine.containers.size).toBe(3);
    expect((await ours.list()).map((w) => w.owner).sort()).toEqual([" bob ", "alice"]);
  });

  it("starts a workspace once when several callers start it at the same time", async () => {
    const engine = fakeEngine();
    const provider = new ContainerWorkspaceProvider({ image: "img", cli: engine.cli });
    await Promise.all([provider.open("alice").start(), provider.open("alice").start(), provider.open("alice").start()]);
    expect(engine.calls.filter(([command]) => command === "create")).toHaveLength(1);
    expect(await provider.open("alice").state()).toBe("running");
  });

  it("runs commands inside the workspace with stdio attached", () => {
    const workspace = new ContainerWorkspaceProvider({ image: "img", cli: fakeEngine().cli }).open("alice");
    const [binary, exec, interactive, name, ...argv] = workspace.command(["daemon", "serve"]).argv;
    expect([binary, exec, interactive]).toEqual(["docker", "exec", "--interactive"]);
    expect(name).toMatch(/^chopin-[0-9a-f]{16}$/);
    expect(argv).toEqual(["daemon", "serve"]);
    expect(workspace.root).toBe("/workspace");
    // A variable travels under a name of its own, its value in the launcher's environment, and is renamed inside.
    const launch = workspace.command(["server"], { PATH: "/opt/bin", TOKEN: "s3cret" });
    expect(launch.argv.join(" ")).not.toContain("s3cret");
    expect(launch.env).toEqual({ CHOPIN_ENV_PATH: "/opt/bin", CHOPIN_ENV_TOKEN: "s3cret" });
    expect(launch.argv.slice(3, 7)).toEqual(["--env", "CHOPIN_ENV_PATH", "--env", "CHOPIN_ENV_TOKEN"]);
    expect(() => workspace.command(["server"], { "-i": "x" })).toThrow("is not a variable name");
    expect(() => workspace.command(["server"], { CHOPIN_ENV_X: "x" })).toThrow("is not a variable name");
    expect(() => workspace.command([], { A: "x" })).toThrow("no command");
  });
});

describe("reclaimIdle", () => {
  it("stops idle and unknown owners and leaves active or stopped ones alone", async () => {
    const engine = fakeEngine();
    const provider = new ContainerWorkspaceProvider({ image: "img", cli: engine.cli });
    for (const owner of ["active", "idle", "unknown", "stopped"]) await provider.open(owner).start();
    await provider.open("stopped").stop();

    const lastActive = { active: 9_500, idle: 1_000 } as Record<string, number>;
    const { stopped, failed } = await reclaimIdle(provider, (owner) => lastActive[owner], 5_000, 10_000);

    expect(stopped.sort()).toEqual(["idle", "unknown"]);
    expect(failed).toEqual([]);
    expect(await provider.open("active").state()).toBe("running");
  });

  it("reclaims every other idle workspace when one cannot be stopped, and says whose failed", async () => {
    const stuck = (owner: string): Workspace => ({
      owner, root: "/", state: async () => "running", start: async () => {}, pause: async () => {},
      stop: async () => { if (owner === "stuck") throw new Error("the engine did not answer"); stoppedOwners.push(owner); },
      destroy: async () => {}, command: (argv, env = {}) => ({ argv: [...argv], env: { ...env } }),
    });
    const stoppedOwners: string[] = [];
    const provider: WorkspaceProvider = { open: stuck, list: async () => ["first", "stuck", "last"].map(stuck) };
    const { stopped, failed } = await reclaimIdle(provider, () => undefined, 5_000, 10_000);
    expect(stopped.sort()).toEqual(["first", "last"]);
    expect(failed).toEqual([{ owner: "stuck", error: expect.objectContaining({ message: "the engine did not answer" }) }]);
    expect(stoppedOwners.sort()).toEqual(["first", "last"]);
  });

  it("asks again right before stopping, so an owner who got to work meanwhile keeps the workspace", async () => {
    const engine = fakeEngine();
    const provider = new ContainerWorkspaceProvider({ image: "img", cli: engine.cli });
    await provider.open("alice").start();
    let asked = 0;
    // Idle when the sweep lists, at work by the time it would stop.
    const { stopped } = await reclaimIdle(provider, () => (asked++ === 0 ? undefined : 9_999), 5_000, 10_000);
    expect(stopped).toEqual([]);
    expect(await provider.open("alice").state()).toBe("running");
  });
});
