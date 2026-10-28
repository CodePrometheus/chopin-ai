import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROPOSER_SKILL, loadLayer, parseProposal, proposalBrief, PROPOSER_SKILL, RECURRENCE, Rejections, type FailureClass,
  type TranscriptEntry,
} from "../src/index.js";

const at = "2026-10-27T00:00:00.000Z";
const update = (value: object): TranscriptEntry => ({ at, notification: { sessionId: "s1", update: value as never } });
const signature = { cause: "wrong_command", behavior: "run_command", mechanism: "uses-npm-in-pnpm-repo" } as const;
const failure: FailureClass = {
  key: "wrong_command/run_command/uses-npm-in-pnpm-repo", signature, sessions: ["s1", "s2"],
  failures: [{ session: "s1", line: 4, signature }, { session: "s2", line: 7, signature }],
};
const session: TranscriptEntry[] = [
  update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Run the build." } }),
  update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "read", rawInput: { path: "package.json" } }),
  update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed",
    content: [{ type: "content", content: { type: "text", text: '{"packageManager":"pnpm@9"}' } }] }),
  update({ sessionUpdate: "tool_call", toolCallId: "c2", title: "bash", rawInput: { command: "npm ci" } }),
  update({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "failed",
    content: [{ type: "content", content: { type: "text", text: "auth ghp_abcdefghijklmnopqrstuvwxyz0123456789 my-own-secret-value failed" } }] }),
];

const corrected: TranscriptEntry[] = [
  update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Add the lint step." } }),
  update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", rawInput: { command: "npm install eslint" } }),
  update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "This repo uses pnpm." } }),
];

describe("proposal brief", () => {
  const brief = proposalBrief({
    failure,
    sessions: [{ session: "s1", entries: session, lines: [4] }, { session: "s2", entries: corrected, lines: [1] }],
    corrections: new Map([["s2:1", "use pnpm, the repository's package manager"]]),
    secrets: ["my-own-secret-value"],
    rejections: [{ failure: failure.key, candidate: "x", text: "Always run npm ci.", reason: "no better than before", at }],
    existing: [{ id: "i1", text: "Run the tests before saying done." }],
  });

  it("shows every time the failure happened, the step to change, the user's correction, what was refused and the layer", () => {
    expect(brief).toContain("uses-npm-in-pnpm-repo");
    expect(brief).toContain(">>> 4:");
    expect(brief).toContain("packageManager");
    expect(brief).toContain(">>> 1:");
    expect(brief).toContain("npm install eslint");
    expect(brief).toContain("The user corrected this step: use pnpm, the repository's package manager");
    expect(brief).toContain("Always run npm ci.");
    expect(brief).toContain("i1:");
    expect(brief).toContain("Seen 2 times in 2 sessions");
  });

  it("never carries a secret, whether known by value or by its format", () => {
    expect(brief).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(brief).not.toContain("my-own-secret-value");
  });
});

describe("proposals", () => {
  it("reads one well-formed proposal", () => {
    expect(parseProposal('Here it is: {"kind":"instruction","text":"Use the lockfile\'s package manager.","scope":"global","revises":null,"prediction":"No more npm in pnpm repos."}'))
      .toEqual({ candidate: { kind: "instruction", text: "Use the lockfile's package manager." }, scope: "global", prediction: "No more npm in pnpm repos." });
    expect(parseProposal('{"kind":"skill","skill":"release-check","text":"---\\nname: release-check\\n---","scope":"project","revises":"i2","prediction":"p"}'))
      .toEqual({ candidate: { kind: "skill", text: "---\nname: release-check\n---", revises: "i2" }, skill: "release-check", scope: "project", prediction: "p" });
  });

  it("refuses anything it would have to guess at", () => {
    const base = { kind: "instruction", text: "t", scope: "global", prediction: "p" };
    expect(parseProposal(JSON.stringify({ ...base, prediction: "" }))).toBeUndefined();
    expect(parseProposal(JSON.stringify({ ...base, scope: "everywhere" }))).toBeUndefined();
    expect(parseProposal(JSON.stringify({ ...base, kind: "skill", skill: "Bad Name" }))).toBeUndefined();
    expect(parseProposal(`${JSON.stringify(base)} and also ${JSON.stringify(base)}`)).toBeUndefined();
    expect(parseProposal("I would add a rule about npm.")).toBeUndefined();
  });

  it("is written in a method the layer loads like any skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "chopin-proposer-"));
    await mkdir(join(root, "skills", PROPOSER_SKILL), { recursive: true });
    await writeFile(join(root, "skills", PROPOSER_SKILL, "SKILL.md"), DEFAULT_PROPOSER_SKILL);
    const loaded = await loadLayer(root);
    expect(loaded.ok && loaded.layer.skills.map((skill) => skill.name)).toEqual([PROPOSER_SKILL]);
  });
});

describe("rejections", () => {
  it("sets a kind of failure aside after three refusals, and no other kind with it", async () => {
    const rejections = new Rejections(join(await mkdtemp(join(tmpdir(), "chopin-rejections-")), "rejections.jsonl"));
    for (let refused = 0; refused < 3; refused += 1) {
      expect(await rejections.shelved(failure.key, "p/m", 2)).toBe(false);
      await rejections.record({ failure: failure.key, candidate: "c", text: "t", reason: "r" });
    }
    expect(await rejections.shelved(failure.key, "p/m", 2)).toBe(true);
    expect(await rejections.shelved("another/kind/of-failure", "p/m", 2)).toBe(false);
  });

  it("sets a kind aside at once on a model where it does not recur, until more of its failures come in", async () => {
    const rejections = new Rejections(join(await mkdtemp(join(tmpdir(), "chopin-rejections-")), "rejections.jsonl"));
    await rejections.record({ failure: failure.key, candidate: "", text: "", reason: "it does not recur", notRecurring: { model: "p/strong", failures: 5, tried: RECURRENCE.tries } });
    expect(await rejections.shelved(failure.key, "p/strong", 5)).toBe(true);
    expect(await rejections.shelved(failure.key, "p/weak", 5)).toBe(false);
    expect(await rejections.shelved(failure.key, "p/strong", 6)).toBe(false);
    // Judged by other criteria, such as the user's corrections, the kind is looked at again.
    expect(await rejections.shelved(failure.key, "p/strong", 5, "corrections-digest")).toBe(false);
  });

  it("does not set a kind aside on fewer continuations than a full measure", async () => {
    const rejections = new Rejections(join(await mkdtemp(join(tmpdir(), "chopin-rejections-")), "rejections.jsonl"));
    await rejections.record({ failure: failure.key, candidate: "", text: "", reason: "it does not recur", notRecurring: { model: "p/m", failures: 2, tried: 2 } });
    expect(await rejections.shelved(failure.key, "p/m", 2)).toBe(false);
  });
});
