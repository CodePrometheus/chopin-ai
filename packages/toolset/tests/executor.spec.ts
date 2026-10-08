import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ToolsetExecutor } from "../src/executor.js";
import { loadToolsets } from "../src/loader.js";
import { validateToolset } from "../src/schema.js";
import type { ToolDef } from "../src/schema.js";

function toolset(command: string, params: ToolDef["params"]) {
  return { name: "inline", description: "inline", tools: [{ name: "probe", description: "probe", command, params }] };
}

describe("model-filled params", () => {
  it("refuses a value starting with a dash before the command runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "toolset-dash-"));
    const marker = join(dir, "ran");
    const tool: ToolDef = {
      name: "show",
      description: "show",
      command: "touch ${MARKER} && git show {{ref}}:README.md",
      params: { ref: { description: "ref" } },
    };
    await expect(new ToolsetExecutor({ MARKER: marker }).run(tool, { ref: `--output=${join(dir, "written")}` }))
      .rejects.toThrow('param ref must not start with "-"');
    await expect(access(marker)).rejects.toThrow();
  });

  it("passes a leading dash through as the argument of the option before it", async () => {
    const [tool] = validateToolset(
      toolset("printf '%s\\n' --flag plain | grep -e {{pattern}}", { pattern: { description: "p", allowLeadingDash: true } }),
      "inline",
    ).tools;
    const result = await new ToolsetExecutor().run(tool!, { pattern: "--flag" });
    expect(result.output).toBe("--flag\n");
  });

  it("delivers quotes, spaces and substitutions as one literal argument", async () => {
    const tool: ToolDef = { name: "echo", description: "echo", command: "printf '%s' {{value}}", params: { value: { description: "v" } } };
    const result = await new ToolsetExecutor().run(tool, { value: "it's a $(printf injected) `printf injected`" });
    expect(result.output).toBe("it's a $(printf injected) `printf injected`");
  });
});

describe("validateToolset", () => {
  const allowed = { p: { description: "p", allowLeadingDash: true } };

  it("accepts a leading-dash opt-in only where the param is an option's argument", () => {
    for (const command of ["grep -e {{p}} .", "gh issue list --search {{p}} --limit 10", "git log --grep={{p}}"]) {
      expect(() => validateToolset(toolset(command, allowed), "inline"), command).not.toThrow();
    }
    for (const command of ["find {{p}} -maxdepth 2", "git show {{p}}:README.md", "grep -e x {{p}}"]) {
      expect(() => validateToolset(toolset(command, allowed), "inline"), command).toThrow("must directly follow an option");
    }
  });

  it("loads every shipped toolset", async () => {
    expect((await loadToolsets([resolve("toolsets")])).length).toBeGreaterThan(0);
  });
});
