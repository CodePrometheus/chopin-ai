import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdmissionLedger, CLASSIFIER_VERSION, LayerVersions, LoopFault, RECURRENCE, Rejections, type Layer, type TranscriptEntry } from "@chopin-ai/core";
import { describe, expect, it } from "vitest";
import { Evidence, type Source } from "../src/rsi/harvest.js";
import { HeldProposals } from "../src/rsi/held.js";
import { runRounds, tripsBreaker, type RoundSetup } from "../src/rsi/round.js";

const at = new Date().toISOString();
const acp = (value: object): TranscriptEntry => ({ at, notification: { sessionId: "1", update: value as never } });
const lines = (values: readonly object[]) => values.map((value) => `${JSON.stringify(value)}\n`).join("");
const signature = { cause: "wrong_command", behavior: "run_command", mechanism: "uses-npm-in-pnpm-repo" } as const;
const base: Layer = { instructions: "Be brief.", skills: [], mcpServers: {}, gates: [] };
const RULE = "Use the package manager the lockfile names.";

/** A session that ran npm where pnpm was wanted, and one that went right. */
const failing = [
  acp({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Install deps." } }),
  acp({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", rawInput: { command: "npm install" } }),
  acp({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed" }),
];
const fine = [
  acp({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "List files." } }),
  acp({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", rawInput: { command: "ls" } }),
  acp({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" }),
];

async function setup(works: boolean, scope: "global" | "project" = "global"): Promise<RoundSetup> {
  const root = await mkdtemp(join(tmpdir(), "chopin-round-"));
  await mkdir(join(root, "sessions"));
  const sources: Source[] = [];
  for (const [name, entries] of [["a", failing], ["b", failing], ["c", fine], ["d", fine]] as const) {
    const path = join(root, "sessions", `${name}.jsonl`);
    await writeFile(path, lines(entries));
    sources.push({ path, kind: "acp" });
  }
  const evidence = new Evidence(join(root, "evidence"));
  await evidence.addFailure({ session: sources[0]!.path, line: 1, signature, classifier: CLASSIFIER_VERSION });
  await evidence.addFailure({ session: sources[1]!.path, line: 1, signature, classifier: CLASSIFIER_VERSION });
  const project = new LayerVersions(join(root, "project-layer"));
  return {
    evidence, sources, versions: new LayerVersions(join(root, "layer")), base,
    // Sessions a, b and c are of one project; d is of none that can be told.
    projectOf: (session) => (session.endsWith("d.jsonl") ? undefined : { key: "p1", versions: project }),
    ledger: new AdmissionLedger(join(root, "ledger.jsonl")), rejections: new Rejections(join(root, "rejections.jsonl")),
    held: new HeldProposals(join(root, "held.jsonl")),
    certificates: join(root, "certificates"), rules: "Never force-push.", model: "p/model", secrets: [],
    propose: async () => JSON.stringify({ kind: "instruction", text: RULE, scope, revises: null, prediction: "pnpm, not npm" }),
    judge: async (prompt) => {
      if (prompt.startsWith("You audit")) return '{"task_specific":false,"unsafe":false,"overlaps":null,"reasons":[]}';
      if (prompt.includes('Reply with only "repeats" or "avoids"')) return prompt.includes("npm install") && !prompt.includes("pnpm install") ? "repeats" : "avoids";
      return "as_good";
    },
    // The agent follows the rule only when it is in its layer, and only if the rule works at all.
    continueStep: async (layer, prefix) => {
      const at = JSON.stringify(prefix);
      if (!at.includes("Install deps.")) return JSON.stringify([{ call: "bash", arguments: { command: "ls" } }]);
      const follows = works && (layer.instructions ?? "").includes(RULE);
      return JSON.stringify([{ call: "bash", arguments: { command: follows ? "pnpm install" : "npm install" } }]);
    },
  };
}

describe("rounds", () => {
  it("keeps a change that stops the failure, publishes it, and does not take up that failure again", async () => {
    const round = await setup(true);
    const told: string[] = [];
    const [outcome] = await runRounds(round, (each) => told.push(each.outcome));
    expect(outcome?.outcome).toBe("kept");
    expect(told).toEqual(["kept"]);
    expect(await round.versions.current()).toBe(1);
    const [item] = await round.versions.items(1);
    expect(item).toMatchObject({ kind: "instruction", text: RULE, source: { failure: "run_command/uses-npm-in-pnpm-repo" } });
    expect(await readdir(round.certificates)).toHaveLength(1);
    expect(await runRounds(round)).toEqual([]);
  });

  it("reads every time the failure happened, tests the change at each, and checks for harm only in sessions it did not read", async () => {
    const round = await setup(true);
    // Each failing session now has a turn that went right before the one that failed.
    const [a, b] = round.sources.map((source) => source.path) as [string, string];
    const listedFirst = [
      acp({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "List the files first." } }),
      acp({ sessionUpdate: "tool_call", toolCallId: "c0", title: "bash", rawInput: { command: "ls" } }),
      acp({ sessionUpdate: "tool_call_update", toolCallId: "c0", status: "completed" }),
      ...failing,
    ];
    const evidence = new Evidence(join(await mkdtemp(join(tmpdir(), "chopin-round-")), "evidence"));
    for (const path of [a, b]) {
      await writeFile(path, lines(listedFirst));
      await evidence.addFailure({ session: path, line: 4, signature, classifier: CLASSIFIER_VERSION });
    }
    const asked: string[] = [];
    const prefixes: TranscriptEntry[][] = [];
    const watched: RoundSetup = {
      ...round, evidence,
      propose: async (prompt) => (asked.push(prompt), round.propose(prompt)),
      judge: async (prompt) => (asked.push(prompt), round.judge(prompt)),
      continueStep: async (layer, prefix) => (prefixes.push([...prefix]), round.continueStep(layer, prefix)),
    };
    const [outcome] = await runRounds(watched);
    expect(outcome).toMatchObject({ outcome: "kept", certificate: { fixed: expect.arrayContaining([`${a}:4`, `${b}:4`]) } });
    const proposal = asked.find((prompt) => prompt.includes("## Each time it happened"))!;
    expect(proposal).toContain("### Session 1, line 4");
    expect(proposal).toContain("### Session 2, line 4");
    expect(asked.find((prompt) => prompt.startsWith("You audit"))).toContain("Install deps.");
    // A step that went right in a session the proposer read is never one the change is checked against.
    expect(prefixes.filter((prefix) => prefix.length === 1 && JSON.stringify(prefix).includes("List the files first."))).toEqual([]);
  });

  it("sets a kind aside, before proposing, while it recurs at only one decision point", async () => {
    const round = await setup(true);
    // In session b the agent now does right where it once failed.
    await writeFile(round.sources[1]!.path, lines([
      acp({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Install the packages." } }), ...failing.slice(1),
    ]));
    let proposed = 0;
    const outcomes = await runRounds({ ...round, propose: async (prompt) => ((proposed += 1), round.propose(prompt)) });
    expect(outcomes).toMatchObject([{ outcome: "set_aside", reason: expect.stringContaining("recurs at 1 decision point") }]);
    expect(proposed).toBe(0);
  });

  it("keeps a change that holds in one project in that project's versions, tested on its sessions", async () => {
    const round = await setup(true, "project");
    const [outcome] = await runRounds(round);
    expect(outcome?.outcome).toBe("kept");
    expect(await round.versions.current()).toBe(0);
    const target = round.projectOf(round.sources[0]!.path)!;
    expect(await target.versions.current()).toBe(1);
    expect(outcome?.outcome === "kept" && outcome.certificate.scope).toEqual({ kind: "project", project: "p1" });
    expect(await runRounds(round)).toEqual([]);
  });

  it("sets a failure aside at once on a model where it no longer recurs, without asking for a change", async () => {
    const round = await setup(true);
    let proposed = 0;
    const nothingToMend: RoundSetup = {
      ...round,
      propose: async (prompt) => ((proposed += 1), round.propose(prompt)),
      continueStep: async () => JSON.stringify([{ call: "bash", arguments: { command: "pnpm install" } }]),
    };
    const [outcome] = await runRounds(nothingToMend);
    expect(outcome).toMatchObject({ outcome: "set_aside", reason: expect.stringContaining("seldom recurs") });
    expect(proposed).toBe(0);
    expect(await runRounds(nothingToMend)).toEqual([]);
    expect(await runRounds({ ...nothingToMend, model: "p/another" })).toHaveLength(1);
    // A new failure of the kind, such as a correction the user confirmed, is reason to look again.
    await round.evidence.addFailure({ session: round.sources[2]!.path, line: 1, signature, classifier: CLASSIFIER_VERSION });
    expect(await runRounds(nothingToMend)).toHaveLength(1);
  });

  it("leaves out a decision point a call failed on, and keeps testing the rest", async () => {
    const round = await setup(true);
    const reported: unknown[] = [];
    let refused: readonly TranscriptEntry[] | undefined;
    const [outcome] = await runRounds({
      ...round,
      report: (error) => reported.push(error),
      // The provider refuses one point's content every time; the others go on.
      continueStep: async (layer, prefix) => {
        if (refused === undefined && JSON.stringify(prefix).includes("List files.")) refused = prefix;
        if (prefix === refused) throw new Error("refused for its content");
        return round.continueStep(layer, prefix);
      },
    });
    expect(outcome?.outcome).toBe("kept");
    expect(new Set(reported.map(String))).toEqual(new Set(["Error: refused for its content"]));
  });

  it("probes the provider only once the lost points are several and half of those tried", () => {
    expect(tripsBreaker(3, 7)).toBe(false);
    expect(tripsBreaker(3, 6)).toBe(true);
    expect(tripsBreaker(2, 2)).toBe(false);
    expect(tripsBreaker(5, 9)).toBe(true);
  });

  it("tells content a provider will not take from a provider that answers nothing, once most points are lost", async () => {
    // Three of its failures can be continued, enough to tell the two apart.
    const withPoints = async () => {
      const round = await setup(true);
      for (const source of round.sources.slice(2)) {
        await round.evidence.addFailure({ session: source.path, line: 1, signature, classifier: CLASSIFIER_VERSION });
      }
      return round;
    };
    const probe = '"text":"List the files here."';
    const refusing = await withPoints();
    const content: RoundSetup = {
      ...refusing, report: () => {},
      continueStep: async (layer, prefix) => {
        if (!JSON.stringify(prefix).includes(probe)) throw new Error("refused for its content");
        return refusing.continueStep(layer, prefix);
      },
    };
    expect(await runRounds(content)).toMatchObject([{ outcome: "refused", reason: expect.stringContaining("keep failing to continue") }]);

    const down = await withPoints();
    await expect(runRounds({ ...down, report: () => {}, continueStep: async () => { throw new Error("bad request"); } })).rejects.toThrow("bad request");

    // A failure that tells nothing either way sets nothing aside.
    const unknown = { ...(await setup(true)), report: () => {}, continueStep: async () => { throw new Error("refused"); } };
    expect(await runRounds(unknown)).toMatchObject([{ outcome: "refused", reason: "none of its failures could be continued" }]);
    expect(await runRounds(unknown)).toHaveLength(1);
  });

  it("stops at once on a fault of its own making, rather than leaving the point out", async () => {
    const round = await setup(true);
    const reported: unknown[] = [];
    const broken: RoundSetup = { ...round, report: (error) => reported.push(error), continueStep: async () => { throw new LoopFault("malformed"); } };
    await expect(runRounds(broken)).rejects.toThrow("malformed");
    expect(reported).toEqual([]);
  });

  it("takes up first the kinds the user confirmed a correction of", async () => {
    const round = await setup(true);
    const listing = { cause: "user_preference", behavior: "run_command", mechanism: "lists-files-unasked" } as const;
    const [, , c, d] = round.sources.map((source) => source.path) as [string, string, string, string];
    for (const session of [c, d]) await round.evidence.addFailure({ session, line: 1, signature: listing, classifier: CLASSIFIER_VERSION });
    const correction = { session: d, line: 2, step: 1, summary: "do not list files unasked", signature: listing, classifier: CLASSIFIER_VERSION };
    await round.evidence.addCorrection(correction);
    await round.evidence.answerCorrection(correction, true);
    expect((await runRounds(round)).map((outcome) => outcome.failure)).toEqual(["run_command/lists-files-unasked", "run_command/uses-npm-in-pnpm-repo"]);
  });

  it("judges a failure the user corrected by the correction, apart from verdicts reached without it", async () => {
    const round = await setup(true);
    const judgeAsked: string[] = [];
    const watched: RoundSetup = { ...round, judge: async (prompt) => (judgeAsked.push(prompt), round.judge(prompt)) };
    // A verdict reached without the correction, and a kind set aside on it.
    const [, b] = round.sources.map((source) => source.path) as [string, string];
    await round.evidence.addRecurrence(`${b}:1`, 0, round.model, false);
    await round.rejections.record({ failure: "run_command/uses-npm-in-pnpm-repo", candidate: "", text: "", reason: "it seldom recurs", notRecurring: { model: round.model, failures: 2, tried: RECURRENCE.tries } });
    expect(await runRounds(watched)).toEqual([]);

    const correction = { session: b, line: 2, step: 1, summary: "use pnpm here, never npm", signature, classifier: CLASSIFIER_VERSION };
    await round.evidence.addCorrection(correction);
    await round.evidence.answerCorrection(correction, true);
    expect(await runRounds(watched)).toMatchObject([{ outcome: "kept" }]);
    expect(judgeAsked.some((prompt) => prompt.includes("the user corrected it: use pnpm here, never npm"))).toBe(true);
  });

  it("tries each continuation for recurrence once per layer version and model", async () => {
    const round = await setup(false);
    let continued = 0;
    const proposedAt: number[] = [];
    const counted: RoundSetup = {
      ...round,
      continueStep: async (layer, prefix) => ((continued += 1), round.continueStep(layer, prefix)),
      propose: async (prompt) => (proposedAt.push(continued), round.propose(prompt)),
    };
    await runRounds(counted);
    const afterFirst = continued;
    await runRounds(counted);
    // Its failures were continued until they had repeated enough; the second round already knew.
    expect(proposedAt).toEqual([RECURRENCE.enough, afterFirst]);
  });

  it("holds a change the audit asks a person about, proposes nothing more meanwhile, and tests it once approved", async () => {
    const round = await setup(true);
    const asked = { propose: 0, audit: 0 };
    const unsure: RoundSetup = {
      ...round,
      propose: async (prompt) => ((asked.propose += 1), round.propose(prompt)),
      judge: async (prompt) => {
        if (!prompt.startsWith("You audit")) return round.judge(prompt);
        asked.audit += 1;
        return '{"task_specific":false,"unsafe":true,"overlaps":null,"reasons":["it runs installs without asking"]}';
      },
    };
    // With review off, such a change is refused as before.
    expect(await runRounds(unsure)).toMatchObject([{ outcome: "refused", reason: expect.stringContaining("asks for your review") }]);

    const holding = { ...unsure, holdForReview: true };
    expect(await runRounds(holding)).toMatchObject([{ outcome: "held", reason: expect.stringContaining("runs installs without asking") }]);
    const [held] = await round.held.waiting();
    expect(held?.proposal.candidate.text).toBe(RULE);
    expect(await runRounds(holding)).toEqual([]);
    expect(asked).toEqual({ propose: 2, audit: 2 });

    // Approved, it skips the proposer and the audit, and still has to pass the gate.
    await round.held.decide(held!, "approved");
    expect(await runRounds(holding)).toMatchObject([{ outcome: "kept" }]);
    expect(asked).toEqual({ propose: 2, audit: 2 });
    expect(await round.held.approved(held!.failure)).toBeUndefined();
  });

  it("proposes again for a kind whose held change the user refused", async () => {
    const round = await setup(true);
    const holding: RoundSetup = {
      ...round, holdForReview: true,
      judge: async (prompt) => (prompt.startsWith("You audit")
        ? '{"task_specific":false,"unsafe":true,"overlaps":null,"reasons":["unsure"]}' : round.judge(prompt)),
    };
    await runRounds(holding);
    await round.held.decide((await round.held.waiting())[0]!, "refused");
    expect(await round.held.waiting()).toEqual([]);
    expect(await runRounds(holding)).toMatchObject([{ outcome: "held" }]);
  });

  it("refuses a change that changes nothing, says why, and sets the failure aside after three", async () => {
    const round = await setup(false);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [outcome] = await runRounds(round);
      expect(outcome?.outcome).toBe("refused");
    }
    expect(await round.versions.current()).toBe(0);
    expect((await round.rejections.for("run_command/uses-npm-in-pnpm-repo"))[0]?.reason).toContain("mended none of the first");
    expect(await runRounds(round)).toEqual([]);
  });
});
