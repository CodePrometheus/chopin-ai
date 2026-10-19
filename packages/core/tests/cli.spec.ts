import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) }, out, err };
}

describe("runCli", () => {
  it("summarizes a valid layer", async () => {
    const root = await mkdtemp(join(tmpdir(), "chopin-cli-"));
    await mkdir(join(root, "skills/review-diff"), { recursive: true });
    await writeFile(join(root, "skills/review-diff/SKILL.md"), "---\nname: review-diff\ndescription: Reviews a diff.\n---\n");
    const { io, out } = capture();
    expect(await runCli(["layer", "check", root], io)).toBe(0);
    expect(out.join("\n")).toContain("skills: review-diff");
  });

  it("fails with the problems of an invalid layer", async () => {
    const root = await mkdtemp(join(tmpdir(), "chopin-cli-"));
    await writeFile(join(root, "gates.yaml"), "not: a list\n");
    const { io, err } = capture();
    expect(await runCli(["layer", "check", root], io)).toBe(1);
    expect(err.join("\n")).toContain("expected a list of gate rules");
  });

  it("prints usage for help and rejects unknown commands", async () => {
    expect(await runCli([], capture().io)).toBe(0);
    expect(await runCli(["nope"], capture().io)).toBe(2);
  });
});
