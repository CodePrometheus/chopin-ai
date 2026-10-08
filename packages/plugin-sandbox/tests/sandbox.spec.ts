import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PluginSandboxError, SandboxedPlugin, verifyCapabilityFixtures } from "../src/index.js";
import type { CapabilityFixtureSuite } from "@chopin/evolution";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chopin-plugin-sandbox-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function manifest() {
  return {
    schemaVersion: 1,
    id: "sandbox-echo",
    version: "1.0.0",
    kind: "plugin",
    runtime: "dsh-plugin",
    intendedEffect: "preventive",
    summary: "Exercise the sandboxed plugin ABI.",
    entry: "index.mjs",
    trigger: { repos: ["chopin"] },
    provides: {
      contexts: ["sandbox-context"],
      skills: [],
      guards: ["sandbox-guard"],
      tools: ["sandbox_echo"],
      services: [],
      workflows: [],
    },
    permissions: ["system-prompt:context", "tools:guard", "tools:register"],
    dependencies: [],
    conflicts: [],
    requires: { chopinPluginApi: "^1.0.0", dsh: "0.1.1-rc.2" },
    lineage: { candidateIds: ["sandbox-candidate"], proposalIds: ["sandbox-proposal"] },
  } as const;
}

async function entry(source: string): Promise<string> {
  const directory = await temporaryDirectory();
  await mkdir(directory, { recursive: true });
  const path = join(directory, "index.mjs");
  await writeFile(path, source, "utf8");
  return path;
}

function pluginSource(prefix = ""): string {
  return `${prefix}
import { defineChopinPlugin } from "@chopin/plugin-sdk";
const manifest = ${JSON.stringify(manifest())};
export default defineChopinPlugin({
  manifest,
  activate(context) {
    context.registerContext({
      name: "sandbox-context",
      order: 10,
      render(input) { return "approved:" + input.prompt; },
    });
    context.registerGuard({
      name: "sandbox-guard",
      tools: ["submit"],
      evaluate(input) { return input.successfulCalls.some((call) => call.name === "read") ? undefined : "read first"; },
    });
    context.registerTool({
      name: "sandbox_echo",
      description: "Echo one string.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      async execute(input) { return { echo: input.arguments.text }; },
    });
  },
});
`;
}

describe.runIf(process.platform === "darwin")("OS-isolated plugin sandbox", () => {
  it("runs context, guard and tool over the narrow RPC", async () => {
    const path = await entry(pluginSource(`
if (typeof process !== "undefined") throw new Error("process leaked into capability");
if (typeof fetch !== "undefined") throw new Error("network primitive leaked into capability");
`));
    const plugin = await SandboxedPlugin.inspect(path, "sandbox-echo", "1.0.0");

    expect(plugin.inspection.definitions.contexts).toEqual([{ name: "sandbox-context", order: 10 }]);
    expect(plugin.inspection.definitions.guards).toEqual([{ name: "sandbox-guard", tools: ["submit"] }]);
    expect(plugin.inspection.definitions.tools.map((tool) => tool.name)).toEqual(["sandbox_echo"]);
    expect(plugin.renderContext("sandbox-context", { workspace: "/repo", prompt: "start" })).toBe("approved:start");
    expect(plugin.evaluateGuard("sandbox-guard", { toolName: "submit", arguments: {}, successfulCalls: [] })).toBe("read first");
    expect(plugin.evaluateGuard("sandbox-guard", {
      toolName: "submit",
      arguments: {},
      successfulCalls: [{ name: "read", arguments: {} }],
    })).toBeUndefined();
    await expect(plugin.executeTool("sandbox_echo", { callId: "call-one", arguments: { text: "works" } }))
      .resolves.toEqual({ echo: "works" });

    const suite: CapabilityFixtureSuite = {
      schemaVersion: 1,
      cases: [
        {
          id: "context-one",
          kind: "context",
          name: "sandbox-context",
          input: { workspace: "/fixture", prompt: "start" },
          expect: { equals: "approved:start" },
        },
        {
          id: "guard-one",
          kind: "guard",
          name: "sandbox-guard",
          input: { toolName: "submit", arguments: {}, successfulCalls: [] },
          expect: { decision: "read first" },
        },
        {
          id: "tool-one",
          kind: "tool",
          name: "sandbox_echo",
          input: { callId: "fixture-call", arguments: { text: "fixture" } },
          expect: { equals: { echo: "fixture" } },
        },
      ],
    };
    const report = await verifyCapabilityFixtures(plugin, suite);
    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(3);
  });

  it("rejects Node and any third-party module imports", async () => {
    const path = await entry(`import fs from "node:fs";\n${pluginSource()}\nvoid fs;\n`);
    await expect(SandboxedPlugin.inspect(path, "sandbox-echo", "1.0.0")).rejects.toThrow(/import node:fs is not allowed/);
  });

  it("the runtime a plugin gets has only three registration entries and no path to lift any guard", async () => {
    const path = await entry(pluginSource(`
globalThis.__surface = (context) => {
  const keys = Object.keys(context).sort().join(",");
  if (keys !== "capabilityId,capabilityVersion,registerContext,registerGuard,registerTool,signal") {
    throw new Error("unexpected runtime surface: " + keys);
  }
  if ("tools" in context || "unregisterGuard" in context || "guards" in context) throw new Error("guard removal leaked into capability");
  if (!Object.isFrozen(context)) throw new Error("runtime context is mutable");
};
`).replace("activate(context) {", "activate(context) {\n    globalThis.__surface(context);"));
    const plugin = await SandboxedPlugin.inspect(path, "sandbox-echo", "1.0.0");
    expect(plugin.inspection.definitions.guards).toEqual([{ name: "sandbox-guard", tools: ["submit"] }]);
  });

  it("disables Function string code generation, blocking common VM escapes", async () => {
    const path = await entry(`
globalThis.constructor.constructor("return process")();
${pluginSource()}
`);
    await expect(SandboxedPlugin.inspect(path, "sandbox-echo", "1.0.0")).rejects.toBeInstanceOf(PluginSandboxError);
    await expect(SandboxedPlugin.inspect(path, "sandbox-echo", "1.0.0")).rejects.toThrow(/code generation|Code generation/i);
  });
});

describe("without an OS sandbox", () => {
  it("refuses an executable capability instead of running it unisolated", async () => {
    const path = await entry(pluginSource());
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      await expect(SandboxedPlugin.inspect(path, "sandbox-echo", "1.0.0")).rejects.toThrow("no supported OS network sandbox for linux");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
