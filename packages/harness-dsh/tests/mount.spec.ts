import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import { runtime } from "./runtime.js";

describe("harness-dsh in a real dsh composition", () => {
  it("serves the layer's skills and gates its tools through dsh's own services", async () => {
    const layer = await mkdtemp(join(tmpdir(), "chopin-dsh-mount-"));
    await mkdir(join(layer, "skills", "review-diff"), { recursive: true });
    await writeFile(join(layer, "skills", "review-diff", "SKILL.md"), "---\nname: review-diff\ndescription: Review a diff.\n---\nCheck every hunk.\n");
    await writeFile(join(layer, "AGENTS.md"), "Prefer small diffs.\n");
    await writeFile(join(layer, "gates.yaml"), "- tool: deliver\n  requires: [run_tests]\n  reason: Run the tests first.\n");

    const { root, create, call } = await runtime({ layer });

    expect((await root.skills.get("review-diff"))?.content).toBe("Check every hunk.\n");

    const agent = await create();
    const session = agent.session;
    expect(root.sessionProjections.stateOf(session, "chopin.succeeded")).toEqual({ calls: {}, tools: [] });

    const tool = (name: string) => defineTool({
      name, description: name, parameters: {}, output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
      execute: async () => `${name} ran`,
    });
    root.tools.register(tool("run_tests"));
    root.tools.register(tool("deliver"));
    const refused = await call(agent, "deliver");
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("Run the tests first.");
    expect((await call(agent, "run_tests")).isError).toBeFalsy();
    expect((await call(agent, "deliver")).isError).toBeFalsy();
  });
});
