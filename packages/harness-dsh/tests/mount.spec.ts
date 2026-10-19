import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Session from "@deepseek-ai/dsh-session";
import Projection from "@deepseek-ai/dsh-session-projection";
import Skills from "@deepseek-ai/dsh-skill";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools, { defineTool, type ToolExecutionInput } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import * as Harness from "../src/index.js";

describe("harness-dsh in a real dsh composition", () => {
  it("serves the layer's skills and gates its tools through dsh's own services", async () => {
    const layer = await mkdtemp(join(tmpdir(), "chopin-dsh-mount-"));
    await mkdir(join(layer, "skills", "review-diff"), { recursive: true });
    await writeFile(join(layer, "skills", "review-diff", "SKILL.md"), "---\nname: review-diff\ndescription: Review a diff.\n---\nCheck every hunk.\n");
    await writeFile(join(layer, "AGENTS.md"), "Prefer small diffs.\n");
    await writeFile(join(layer, "gates.yaml"), "- tool: deliver\n  requires: [run_tests]\n  reason: Run the tests first.\n");

    const root = new Context();
    for (const plugin of [Session, Projection, Tools, SystemPrompt, Skills]) await root.plugin(plugin);
    await root.plugin(Harness, { layer });

    expect((await root.skills.get("review-diff"))?.content).toBe("Check every hunk.\n");

    const session = root.sessions.create("s1" as never);
    expect(root.sessionProjections.stateOf(session, "chopin.succeeded")).toEqual({ calls: {}, tools: [] });

    const tool = (name: string) => defineTool({
      name, description: name, parameters: {}, output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
      execute: async () => `${name} ran`,
    });
    root.tools.register(tool("run_tests"));
    root.tools.register(tool("deliver"));
    const call = (name: string) => root.tools.execute({
      callId: `call-${name}`, name, arguments: {}, agent: { session }, signal: new AbortController().signal,
    } as unknown as ToolExecutionInput);
    const refused = await call("deliver");
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("Run the tests first.");
    expect((await call("run_tests")).isError).toBeFalsy();
  });
});
