import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LayerVersions, type LayerItem } from "@chopin-ai/core";
import { describe, expect, it } from "vitest";
import { archiveUnused } from "../src/rsi/lifecycle.js";

const day = 24 * 60 * 60_000;
const skill = (id: string, name: string, ageDays: number, pinned = false): LayerItem => ({
  id, kind: "skill", skill: name, validated: { models: ["p/m"], harnesses: ["pi"] }, source: {}, pinned, archived: false,
  added: new Date(Date.now() - ageDays * day).toISOString(),
});

describe("archiveUnused", () => {
  it("archives old skills no recent session read, keeping read, young, pinned ones and every instruction", async () => {
    const root = await mkdtemp(join(tmpdir(), "chopin-lifecycle-"));
    const versions = new LayerVersions(join(root, "layer"));
    await versions.commit(() => [
      skill("read", "release-check", 40), skill("unread", "old-habit", 40), skill("young", "new-habit", 5),
      skill("pinned", "kept-habit", 40, true),
      { ...skill("rule", "", 40), kind: "instruction", text: "Run the tests first." },
    ]);
    const session = join(root, "s.jsonl");
    await writeFile(session, `${JSON.stringify({ at: "", notification: { sessionId: "1", update: {
      sessionUpdate: "tool_call", toolCallId: "c1", title: "skill", rawInput: { name: "release-check" } } } })}\n`);
    expect(await archiveUnused(versions, [{ path: session, kind: "acp" }], [])).toEqual(["unread"]);
    const items = await versions.items(await versions.current());
    expect(items.filter((item) => item.archived).map((item) => item.id)).toEqual(["unread"]);
    expect(await archiveUnused(versions, [{ path: session, kind: "acp" }], [])).toEqual([]);
  });
});
