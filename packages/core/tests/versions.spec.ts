import { appendFile, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveLayer, LayerVersions, overLimits, type Layer, type LayerItem } from "../src/index.js";

const base: Layer = { instructions: "Hand-written rule.", skills: [], mcpServers: {}, gates: [] };
const item = (id: string, fields: Partial<LayerItem>): LayerItem => ({
  id, kind: "instruction", validated: { models: ["p/haiku"], harnesses: ["pi"] }, source: {}, pinned: false,
  archived: false, added: "2026-10-27T00:00:00.000Z", ...fields,
});
const skill = (name: string) => `---\nname: ${name}\ndescription: When releasing.\n---\nRun the release checklist.\n`;

async function store(): Promise<LayerVersions> {
  return new LayerVersions(join(await mkdtemp(join(tmpdir(), "chopin-versions-")), "layer"));
}

describe("layer versions", () => {
  it("publishes each change as a new current version and keeps the earlier ones as they were", async () => {
    const versions = await store();
    expect(await versions.current()).toBe(0);
    const v1 = await versions.commit((items) => [...items, item("a", { text: "Run the tests before saying done." })]);
    const v2 = await versions.commit((items) => items.map((i) => (i.id === "a" ? { ...i, archived: true } : i)));
    expect([v1, v2, await versions.current()]).toEqual([1, 2, 2]);
    expect((await versions.items(1))[0]?.archived).toBe(false);
    expect((await versions.items(2))[0]?.archived).toBe(true);
  });

  it("leaves no version and no staging behind when a change fails midway", async () => {
    const versions = await store();
    await versions.commit(() => [item("a", { text: "One." })]);
    await expect(versions.commit(() => {
      throw new Error("crashed");
    })).rejects.toThrow("crashed");
    expect(await versions.current()).toBe(1);
    expect((await readdir(versions.root)).filter((name) => name !== "current")).toEqual(["v1"]);
  });

  it("goes back to the newest intact version when the one in use was edited behind its back", async () => {
    const versions = await store();
    await versions.commit(() => [item("a", { text: "One." })]);
    await versions.commit((items) => [...items, item("b", { text: "Two." })]);
    await appendFile(join(versions.directory(2), "items.json"), " ");
    expect(await versions.intact(2)).toBe(false);
    expect(await versions.recover()).toEqual({ from: 2, to: 1 });
    expect(await versions.current()).toBe(1);
    expect(await versions.recover()).toBeUndefined();
  });

  it("gives a session the hand-written layer plus the items that passed the gate on its model and harness", async () => {
    const versions = await store();
    await versions.commit(() => [
      item("a", { text: "Run the tests before saying done." }),
      item("b", { text: "Only checked on another model.", validated: { models: ["p/opus"], harnesses: ["pi"] } }),
      item("c", { text: "Only checked on the other harness.", validated: { models: ["p/haiku"], harnesses: ["dsh"] } }),
      item("d", { text: "Archived.", archived: true }),
      item("e", { kind: "skill", skill: "release" }),
    ], { "skills/release/SKILL.md": skill("release") });
    const layer = await effectiveLayer(base, versions, 1, { model: "p/haiku", harness: "pi" });
    expect(layer.instructions).toBe("Hand-written rule.\n\nRun the tests before saying done.");
    expect(layer.skills.map((s) => s.name)).toEqual(["release"]);
    const anyModel = await effectiveLayer(base, versions, 1, { model: "p/opus", harness: "pi", anyModel: true });
    expect(anyModel.instructions).toContain("Only checked on another model.");
    expect(anyModel.instructions).not.toContain("other harness");
  });

  it("keeps a session pinned to its version unchanged when a newer one is published", async () => {
    const versions = await store();
    await versions.commit(() => [item("a", { text: "Old rule." })]);
    const pinned = await effectiveLayer(base, versions, 1, { model: "p/haiku", harness: "pi" });
    await versions.commit(() => [item("a", { text: "New rule." })]);
    expect(await effectiveLayer(base, versions, 1, { model: "p/haiku", harness: "pi" })).toEqual(pinned);
    expect((await effectiveLayer(base, versions, 2, { model: "p/haiku", harness: "pi" })).instructions).toContain("New rule.");
  });

  it("refuses paths that leave the version's directory", async () => {
    const versions = await store();
    await expect(versions.commit((items) => items, { "../escape.md": "x" })).rejects.toThrow("outside the layer");
  });

  it("reports what every session would carry beyond the limits", () => {
    expect(overLimits(base)).toEqual([]);
    expect(overLimits({ ...base, instructions: "x".repeat(20_000) })[0]).toContain("over 4000");
  });
});
