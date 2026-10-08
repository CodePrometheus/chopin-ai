import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse, parseDocument } from "yaml";
import { describe, expect, it } from "vitest";

describe("terminal install app boundary", () => {
  it("uses the real prepare entry: enables only the selected app, updates defaults and keeps user overrides", async () => {
    const home = await mkdtemp(join(tmpdir(), "terminal-install-"));
    const profile = join(home, "profiles", "chopin-tui");
    await mkdir(profile, { recursive: true });
    const patch = join(profile, "cordis.patch.yml");
    await writeFile(patch, "# Keep this user comment.\n- id: custom-row\n  config:\n    setting: preserved\n- id: dsh-tui\n  config:\n    fullscreen: true\n- id: agent-presets\n  config:\n    default: standard\n- id: llm-pi-ai\n  config:\n    providers:\n      anthropic: {}\n");
    const run = () => promisify(execFile)(process.execPath, [resolve("apps/cli/dist/main.js"), "install", "--prepare-only"],
      { env: { ...process.env, DSH_HOME: home, MEMOS_HOME: "", MEMOS_CONFIG_FILE: "" }, maxBuffer: 1024 * 1024 });
    await run();
    const manifest = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
    const active = new Set(manifest.dsh.profile.bundles);
    expect(active.size).toBe(5);
    const runtime = resolve("node_modules");
    let checkedDependencies = 0;
    for (const [name, spec] of Object.entries(manifest.dependencies)) {
      if (typeof spec !== "string" || !spec.startsWith(`link:${runtime}`)) continue;
      checkedDependencies += 1;
      const dependency = JSON.parse(await readFile(join(spec.slice(5), "package.json"), "utf8"));
      if (dependency.dsh?.bundle) expect(active.has(name), name).toBe(true);
    }
    expect(checkedDependencies).toBeGreaterThan(0);
    const text = await readFile(patch, "utf8");
    const doc = parseDocument(text, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (s: string) => s }] });
    const rows = doc.toJS() as Array<{ id: string; config?: Record<string, unknown> }>;
    expect(text).toContain("Keep this user comment.");
    expect(rows.find((row) => row.id === "custom-row")?.config).toEqual({ setting: "preserved" });
    expect(rows.some((row) => row.id === "dsh-tui")).toBe(false);
    expect(rows.some((row) => row.id === "agent-presets")).toBe(false);
    expect(rows.find((row) => row.id === "agent-preset-registry")?.config?.default).toBe("chopin");
    expect(rows.filter((row) => row.id === "tui-app")).toHaveLength(1);
    expect(rows.find((row) => row.id === "llm-pi-ai")?.config?.providers).toEqual({ anthropic: {} });
    expect(parse(await readFile(join(home, "memos-plugin", "config.yaml"), "utf8"))).toEqual({ telemetry: { enabled: false } });
    await run();
    expect(await readFile(patch, "utf8")).toBe(text);
  }, 30_000);
});
