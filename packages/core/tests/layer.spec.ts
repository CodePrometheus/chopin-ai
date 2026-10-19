import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkGates, isMcpToolOf, loadLayer, mcpToolName, unmetGates } from "../src/index.js";

async function layer(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chopin-layer-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const skill = (name: string, description = "Does a thing. Use when the thing comes up.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`;

describe("loadLayer", () => {
  it("treats an empty directory as an empty layer", async () => {
    expect(await loadLayer(await layer({}))).toEqual({
      ok: true,
      layer: { instructions: undefined, skills: [], mcpServers: {}, gates: [] },
    });
  });

  it("loads every part of a layer", async () => {
    const root = await layer({
      "AGENTS.md": "Run the tests before delivering.\n",
      "skills/review-diff/SKILL.md": skill("review-diff"),
      "mcp.json": JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } } }),
      "gates.yaml": "- tool: submit_delivery\n  requires: [run_tests]\n  reason: Run the tests first.\n",
    });
    const result = await loadLayer(root);
    if (!result.ok) throw new Error(result.problems.join("\n"));
    expect(result.layer.instructions).toBe("Run the tests before delivering.\n");
    expect(result.layer.skills).toEqual([
      { name: "review-diff", description: "Does a thing. Use when the thing comes up.", directory: join(root, "skills/review-diff") },
    ]);
    expect(Object.keys(result.layer.mcpServers)).toEqual(["docs"]);
    expect(result.layer.gates).toEqual([{ tool: "submit_delivery", requires: ["run_tests"], reason: "Run the tests first." }]);
  });

  it("reports every problem at once instead of stopping at the first", async () => {
    const result = await loadLayer(await layer({
      "skills/Bad--Name/SKILL.md": skill("Bad--Name"),
      "skills/elsewhere/SKILL.md": skill("other-name"),
      "skills/no-front/SKILL.md": "Just a body.\n",
      "skills/empty/.keep": "",
      "mcp.json": JSON.stringify({ mcpServers: { broken: { url: "https://example.test" } } }),
      "gates.yaml": "- tool: submit_delivery\n  requires: []\n",
    }));
    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems).toHaveLength(6);
    expect(problems.join("\n")).toMatch(/Bad--Name.*name must be/);
    expect(problems.join("\n")).toMatch(/must match its directory "elsewhere"/);
    expect(problems.join("\n")).toMatch(/no-front.*no YAML frontmatter/);
    expect(problems.join("\n")).toMatch(/empty.*SKILL\.md: missing/);
    expect(problems.join("\n")).toMatch(/server broken needs/);
    expect(problems.join("\n")).toMatch(/gates\.yaml\[0\]/);
  });

  it("refuses an SSE server, which not every harness speaks", async () => {
    const result = await loadLayer(await layer({ "mcp.json": JSON.stringify({ mcpServers: { old: { type: "sse", url: "https://example.test/sse" } } }) }));
    expect(result.ok ? [] : result.problems).toEqual([expect.stringContaining("server old uses SSE")]);
  });

  it("reports a skill whose frontmatter is not YAML, next to every other problem", async () => {
    const result = await loadLayer(await layer({
      "skills/broken/SKILL.md": "---\nname: foo: bar\n---\n",
      "gates.yaml": "not: a list\n",
    }));
    expect(result.ok ? [] : result.problems).toEqual([
      expect.stringContaining("frontmatter is not valid YAML"),
      expect.stringContaining("expected a list of gate rules"),
    ]);
  });

  it("refuses MCP servers a harness could not start or name unambiguously", async () => {
    const mcpServers = {
      "code.search": { command: "x" },
      ["s".repeat(33)]: { command: "x" },
      a__b: { command: "x" },
      a_: { command: "x" },
      flags: { command: "x", args: "--port 3000" },
      env: { command: "x", env: { "A=B": "c" } },
      flag_env: { command: "x", env: { "-i": "c" } },
      nul: { command: "x", args: ["a\u0000b"] },
      shell_names: { command: "x", env: { UID: "0", _: "u" } },
      empty: { command: "" },
      file_url: { type: "http", url: "file:///x" },
      bad_header: { type: "http", url: "https://example.test/mcp", headers: { "Bad Name": "v" } },
      bad_value: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer x\n" } },
      wide_value: { type: "http", url: "https://example.test/mcp", headers: { "X-User": "Zoë" } },
      remote: { type: "http", url: "https://example.test/mcp", headers: { retries: 3 } },
      ok_name: { command: "x", args: ["--stdio"], env: { A: "b" } },
    };
    const result = await loadLayer(await layer({ "mcp.json": JSON.stringify({ mcpServers }) }));
    expect(result.ok ? [] : result.problems.map((problem) => problem.replace(/^.*mcp\.json: /, ""))).toEqual([
      expect.stringMatching(/^server code\.search needs a name/),
      expect.stringMatching(/^server s{33} needs a name/),
      expect.stringMatching(/^server a__b needs a name/),
      expect.stringMatching(/^server a_ needs a name/),
      "server flags needs args as a list of strings",
      'server env needs env names of letters, digits and "_", not starting with a digit, other than "_" and those starting with CHOPIN_ENV_, which "A=B" is not',
      'server flag_env needs env names of letters, digits and "_", not starting with a digit, other than "_" and those starting with CHOPIN_ENV_, which "-i" is not',
      "server nul holds a NUL character, which no program can be given",
      'server shell_names needs env names of letters, digits and "_", not starting with a digit, other than "_" and those starting with CHOPIN_ENV_, which "_" is not',
      "server empty needs a command",
      "server file_url needs an http or https url, not file:///x",
      'server bad_header needs header names an HTTP request can carry, which "Bad Name" is not',
      'server bad_value needs header values an HTTP request can carry, which that of "Authorization" is not',
      'server wide_value needs header values an HTTP request can carry, which that of "X-User" is not',
      "server remote needs headers as an object of string values",
    ]);
  });

  it("reports malformed files instead of throwing", async () => {
    const result = await loadLayer(await layer({ "mcp.json": "{", "gates.yaml": "- [" }));
    expect(result.ok ? [] : result.problems).toHaveLength(2);
  });
});

describe("gates", () => {
  const rules = [{ tool: "submit_delivery", requires: ["run_tests", "review_diff"], reason: "Check first." }];

  it("refuses until every required tool has succeeded", () => {
    expect(unmetGates(rules, "submit_delivery", new Set(["run_tests"]))).toEqual(rules);
    expect(unmetGates(rules, "submit_delivery", new Set(["run_tests", "review_diff"]))).toEqual([]);
    expect(unmetGates(rules, "read", new Set())).toEqual([]);
  });

  it("treats a gate nobody can satisfy as a configuration error", () => {
    expect(checkGates(rules, new Set(["submit_delivery", "run_tests"]))).toEqual([
      "gate on submit_delivery: requires review_diff, which no tool provides",
    ]);
    expect(checkGates(rules, new Set(["run_tests", "review_diff"]))).toEqual(["gate on submit_delivery: no such tool"]);
  });
});

describe("mcpToolName", () => {
  it("spells MCP tools as both harnesses do, hashing any name it had to change", () => {
    expect(mcpToolName("github", "search")).toBe("mcp__github__search");
    expect(mcpToolName("code.search", "x")).toBe("mcp__code_search__x_8b7d17cd4801");
    const long = mcpToolName("svc", "t".repeat(80));
    expect(long).toHaveLength(64);
    expect(long).not.toBe(mcpToolName("svc", `${"t".repeat(79)}u`));
    expect(isMcpToolOf("svc", long)).toBe(true);
  });
});
