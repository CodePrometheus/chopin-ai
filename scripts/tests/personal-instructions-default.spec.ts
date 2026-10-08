import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { loadPersonalInstructions } from "../../packages/evolution-runtime/src/instructions.js";

/** The `files` expression of the preset's personal-instructions row, exactly as the loader evaluates it. */
async function presetFiles(): Promise<() => string[]> {
  const text = await readFile(resolve("packages/bundle/presets/chopin/preset.patch.yml"), "utf8");
  let expression: string | undefined;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node === null || typeof node !== "object") return;
    const row = node as { id?: unknown; config?: { files?: unknown } };
    if (row.id === "personal-instructions" && typeof row.config?.files === "string") expression = row.config.files;
    Object.values(node).forEach(visit);
  };
  visit(parse(text, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (source: string) => source }] }));
  if (expression === undefined) throw new Error("preset has no personal-instructions files expression");
  return new Function(`return ${expression};`) as () => string[];
}

const saved = { home: process.env.HOME, rules: process.env.CHOPIN_USER_INSTRUCTIONS };
afterEach(() => {
  process.env.HOME = saved.home;
  if (saved.rules === undefined) delete process.env.CHOPIN_USER_INSTRUCTIONS;
  else process.env.CHOPIN_USER_INSTRUCTIONS = saved.rules;
});

describe("personal instruction files", () => {
  it("carries no personal rules when the default global file does not exist", async () => {
    process.env.HOME = await mkdtemp(join(tmpdir(), "instructions-home-"));
    delete process.env.CHOPIN_USER_INSTRUCTIONS;
    const files = (await presetFiles())();
    expect(files).toEqual([]);
    expect((await loadPersonalInstructions({ files })).text).toContain("No personal instruction files are currently active.");
  });

  it("carries the default global file when it exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "instructions-home-"));
    await mkdir(join(home, ".claude"));
    await writeFile(join(home, ".claude", "CLAUDE.md"), "Prefer small diffs.");
    process.env.HOME = home;
    delete process.env.CHOPIN_USER_INSTRUCTIONS;
    const files = (await presetFiles())();
    expect(files).toEqual([join(home, ".claude", "CLAUDE.md")]);
    expect((await loadPersonalInstructions({ files })).text).toContain("Prefer small diffs.");
  });

  it("refuses an explicitly listed file that cannot be read", async () => {
    const missing = join(await mkdtemp(join(tmpdir(), "instructions-home-")), "rules.md");
    process.env.CHOPIN_USER_INSTRUCTIONS = JSON.stringify([missing]);
    const files = (await presetFiles())();
    expect(files).toEqual([missing]);
    await expect(loadPersonalInstructions({ files })).rejects.toThrow("Cannot resolve personal instructions");
  });
});
