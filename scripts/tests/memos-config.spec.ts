import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { disableMemosTelemetry, memosConfigPath } from "../../apps/cli/src/memos-config.js";

describe("memory plugin telemetry", () => {
  it("is turned off in a fresh install", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "memos-config-")), "memos-plugin", "config.yaml");
    expect(await disableMemosTelemetry(path)).toBe(true);
    expect(parse(await readFile(path, "utf8"))).toEqual({ telemetry: { enabled: false } });
    expect(await disableMemosTelemetry(path)).toBe(false);
  });

  it("keeps the user's comments and other settings", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "memos-config-")), "config.yaml");
    await writeFile(path, "# my notes\nrecall:\n  topK: 5\n");
    expect(await disableMemosTelemetry(path)).toBe(true);
    const text = await readFile(path, "utf8");
    expect(text).toContain("# my notes");
    expect(parse(text)).toEqual({ recall: { topK: 5 }, telemetry: { enabled: false } });
  });

  it("leaves an explicit choice alone", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "memos-config-")), "config.yaml");
    await writeFile(path, "telemetry:\n  enabled: true\n");
    expect(await disableMemosTelemetry(path)).toBe(false);
    expect(await readFile(path, "utf8")).toBe("telemetry:\n  enabled: true\n");
  });

  it("follows the plugin's own config location overrides", () => {
    expect(memosConfigPath("/h/.dsh", {})).toBe("/h/.dsh/memos-plugin/config.yaml");
    expect(memosConfigPath("/h/.dsh", { MEMOS_CONFIG_FILE: "/x/memos.yaml" })).toBe("/x/memos.yaml");
    expect(memosConfigPath("/h/.dsh", { MEMOS_HOME: "/m", MEMOS_CONFIG_FILE: "/x/memos.yaml" })).toBe("/m/config.yaml");
  });
});
