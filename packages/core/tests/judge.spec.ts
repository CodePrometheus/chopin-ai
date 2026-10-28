import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  audit, auditSamples, calibrate, Calibration, continuationSamples, CALIBRATION, judgeEquivalent, judgeRepeat, repeatSamples,
  type AuditInput, type TranscriptEntry,
} from "../src/index.js";

const at = "2026-10-27T00:00:00.000Z";
const update = (value: object): TranscriptEntry => ({ at, notification: { sessionId: "s1", update: value as never } });
const failure = { cause: "wrong_command", behavior: "run_command", mechanism: "uses-npm-in-pnpm-repo" } as const;
const base: Omit<AuditInput, "candidate"> = {
  existing: [{ id: "i1", text: "Use the repository's own package manager." }],
  diagnosisTasks: ["csv-converter", "nginx-setup"],
  rules: "Never force-push. Never delete files the user did not ask to delete.",
};
const reply = (fields: object) => async () => JSON.stringify({ task_specific: false, unsafe: false, overlaps: null, reasons: [], ...fields });

describe("audit", () => {
  it("rejects a secret by its format without asking a model", async () => {
    let asked = false;
    const outcome = await audit({ ...base, candidate: { kind: "instruction", text: "Use token ghp_abcdefghijklmnopqrstuvwxyz0123456789." } },
      async () => { asked = true; return ""; });
    expect(outcome).toEqual({ decision: "reject", reasons: ["it contains what looks like a secret"] });
    expect(asked).toBe(false);
  });

  it("shows the model the studied tasks, the user's rules and the items already there", async () => {
    let asked = "";
    await audit({ ...base, candidate: { kind: "instruction", text: "Run the tests first." } }, async (prompt) => {
      asked = prompt;
      return "{}";
    });
    expect(asked).toContain("csv-converter");
    expect(asked).toContain("Never force-push.");
    expect(asked).toContain("i1:");
  });

  it("rejects task-specific changes, sends unsafe ones to the user, and asks for overlapping ones to revise", async () => {
    const candidate = { kind: "instruction" as const, text: "Some change." };
    expect((await audit({ ...base, candidate }, reply({ task_specific: true, unsafe: true })))?.decision).toBe("reject");
    expect((await audit({ ...base, candidate }, reply({ unsafe: true })))?.decision).toBe("review");
    expect(await audit({ ...base, candidate }, reply({ overlaps: "i1" }))).toEqual({ decision: "revise", existing: "i1", reasons: [] });
    expect((await audit({ ...base, candidate: { ...candidate, revises: "i1" } }, reply({ overlaps: "i1" })))?.decision).toBe("admit");
    expect((await audit({ ...base, candidate }, reply({ overlaps: "no-such-item" })))?.decision).toBe("admit");
  });

  it("never admits on a reply that does not fit", async () => {
    const candidate = { kind: "instruction" as const, text: "Some change." };
    expect(await audit({ ...base, candidate }, async () => "looks fine to me")).toBeUndefined();
    expect(await audit({ ...base, candidate }, async () => '{"task_specific":"no","unsafe":false}')).toBeUndefined();
  });
});

describe("continuation judges", () => {
  it("read only the verdicts they allow", async () => {
    expect(await judgeRepeat("ctx", "step", failure, async () => ' "repeats". ')).toBe("repeats");
    expect(await judgeRepeat("ctx", "step", failure, async () => "probably avoids it")).toBeUndefined();
    expect(await judgeEquivalent("ctx", "orig", "step", async () => "WORSE")).toBe("worse");
  });

  it("show the failure and the session before the step", async () => {
    let asked = "";
    await judgeRepeat("CONTEXT-LINES", "NEW-STEP", failure, async (prompt) => { asked = prompt; return "avoids"; });
    expect(asked).toContain("uses-npm-in-pnpm-repo");
    expect(asked).toContain("CONTEXT-LINES");
    expect(asked).toContain("NEW-STEP");
    expect(asked).toContain("same kind of failure again");
  });

  it("judge a failure the user named by correcting the agent by whether the step would draw that correction again", async () => {
    let asked = "";
    await judgeRepeat("CONTEXT-LINES", "NEW-STEP", failure, async (prompt) => { asked = prompt; return "repeats"; }, "answer in one sentence");
    expect(asked).toContain("the user corrected it: answer in one sentence");
    expect(asked).toContain("Would the user have to make the same correction after this step?");
    expect(asked).not.toContain("same kind of failure again");
  });
});

describe("unanswered cases", () => {
  it("are the known cases a judge has never answered", async () => {
    const log = new Calibration(join(await mkdtemp(join(tmpdir(), "chopin-unanswered-")), "calibration.jsonl"));
    await log.record("repeat", "old", true);
    await log.record("audit", "new", true);
    expect(await log.unanswered("repeat", new Set(["old", "new"]))).toEqual(["new"]);
  });
});

describe("calibration", () => {
  const session: TranscriptEntry[] = [
    update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Install deps." } }),
    update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", rawInput: { command: "npm install" } }),
    update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" }),
    update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "No, this repo uses pnpm." } }),
    update({ sessionUpdate: "tool_call", toolCallId: "c2", title: "bash", rawInput: { command: "pnpm install" } }),
  ];

  it("makes known repeat cases from a confirmed correction: the corrected step repeats, the next one avoids", () => {
    const samples = repeatSamples("s1", session, 3, failure);
    expect(samples.map((sample) => [sample.id, sample.expected])).toEqual([["s1:1", "repeats"], ["s1:4", "avoids"]]);
    expect(samples[0]!.input.step).toContain("npm install");
  });

  it("finds a judge that always answers the same way untrusted, and a correct one trusted", async () => {
    // Calibrated against the made-up cases alone, as on a first run with no confirmed correction yet.
    const known = continuationSamples();
    const first = new Calibration(join(await mkdtemp(join(tmpdir(), "chopin-calibration-")), "first.jsonl"));
    await calibrate("repeat", async () => "avoids" as const, known.repeat, first);
    await calibrate("repeat", async () => "avoids" as const, known.repeat, first);
    expect(await first.trusted("repeat")).toBe(false);
    const dir = await mkdtemp(join(tmpdir(), "chopin-calibration-"));
    const samples = repeatSamples("s1", session, 3, failure);
    const lazy = new Calibration(join(dir, "lazy.jsonl"));
    const honest = new Calibration(join(dir, "honest.jsonl"));
    for (let round = 0; round < 10; round += 1) {
      await calibrate("repeat", async () => "avoids" as const, samples, lazy);
      await calibrate("repeat", async (input) => (input.step.includes("npm install") && !input.step.includes("pnpm") ? "repeats" : "avoids"),
        samples, honest);
    }
    expect(await lazy.accuracy("repeat")).toEqual({ correct: 10, total: 20 });
    expect(await lazy.trusted("repeat")).toBe(false);
    expect(await honest.trusted("repeat")).toBe(true);
  });

  it("counts only the known cases still in use, so a replaced one stops weighing on the judge", async () => {
    const log = new Calibration(join(await mkdtemp(join(tmpdir(), "chopin-calibration-")), "replaced.jsonl"));
    await log.record("equivalent", "unsound-case", false);
    for (const id of ["a", "b", "c", "d"]) await log.record("equivalent", id, true);
    expect(await log.trusted("equivalent")).toBe(false);
    expect(await log.trusted("equivalent", new Set(["a", "b", "c", "d"]))).toBe(true);
  });

  it("is not trusted before it has answered enough known cases", async () => {
    const log = new Calibration(join(await mkdtemp(join(tmpdir(), "chopin-calibration-")), "log.jsonl"));
    await log.record("repeat", "s1:1", true);
    expect(await log.trusted("repeat")).toBe(false);
  });

  it("catches an auditor that lets everything through", async () => {
    const log = new Calibration(join(await mkdtemp(join(tmpdir(), "chopin-calibration-")), "audit.jsonl"));
    const samples = auditSamples(base);
    await calibrate("audit", async (input) => (await audit(input, reply({})))?.decision, samples, log);
    // The secret is caught without the model and the general change is admitted; the other two slip through.
    expect(await log.accuracy("audit")).toEqual({ correct: 2, total: 4 });
  });

});
