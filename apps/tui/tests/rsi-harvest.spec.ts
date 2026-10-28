import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLASSIFIER_VERSION, type TranscriptEntry } from "@chopin-ai/core";
import { describe, expect, it } from "vitest";
import { Evidence, harvest, sessionSources } from "../src/rsi/harvest.js";

const at = new Date().toISOString();
const acp = (value: object): TranscriptEntry => ({ at, notification: { sessionId: "1", update: value as never } });
const lines = (values: readonly object[]) => values.map((value) => `${JSON.stringify(value)}\n`).join("");

/**
 * A fake model that names every failure the same way, except that a search finding nothing is no failure, and finds
 * one correction; it counts what it is asked.
 */
function model() {
  const asked: string[] = [];
  const complete = async (prompt: string) => {
    asked.push(prompt);
    if (prompt.startsWith("An agent's session may have gone wrong")) {
      const failure = prompt.split("\n").find((line) => line.startsWith("The signal:"))!;
      return failure.includes('"g1"') ? '{"failure":false}' : '{"cause":"wrong_command","behavior":"run_command","mechanism":"uses-npm-in-pnpm-repo"}';
    }
    return prompt.includes("this repo uses pnpm") ? `[{"line":${/user (\d+):.*this repo uses pnpm/.exec(prompt)![1]},"summary":"use pnpm"}]` : "[]";
  };
  return { asked, complete };
}

describe("kinds", () => {
  it("looks for other names of one mechanism once new kinds come in, and groups under them", async () => {
    const evidence = new Evidence(await mkdtemp(join(tmpdir(), "chopin-kinds-")));
    const failure = (session: string, mechanism: string) =>
      evidence.addFailure({ session, line: 1, signature: { cause: "wrong_command", behavior: "run_command", mechanism }, classifier: CLASSIFIER_VERSION });
    await failure("a", "unquoted-glob-no-matches");
    await failure("b", "glob-unquoted-in-zsh");
    let asked = 0;
    const merge = async () => ((asked += 1), '[["unquoted-glob-no-matches","glob-unquoted-in-zsh"]]');
    await evidence.mergeKinds(merge);
    await evidence.mergeKinds(merge);
    expect(asked).toBe(1);
    expect((await evidence.kinds()).map((found) => [found.key, found.sessions])).toEqual([["run_command/unquoted-glob-no-matches", ["a", "b"]]]);
    await failure("c", "forgets-quotes");
    // A later look that does not repeat the merge leaves it as it was.
    await evidence.mergeKinds(async () => ((asked += 1), "[]"));
    expect(asked).toBe(2);
    expect((await evidence.kinds()).map((found) => found.key).sort()).toEqual(["run_command/forgets-quotes", "run_command/unquoted-glob-no-matches"]);
  });
});

describe("corrections", () => {
  const signature = { cause: "wrong_command", behavior: "run_command", mechanism: "uses-npm-in-pnpm-repo" } as const;
  const correction = (session: string) => ({ session, line: 5, step: 3, summary: "use pnpm", signature, classifier: CLASSIFIER_VERSION });

  it("are asked about by kind, and a confirmed kind becomes failures at the steps its corrections answer", async () => {
    const evidence = new Evidence(await mkdtemp(join(tmpdir(), "chopin-corrections-")));
    for (const session of ["a", "b"]) await evidence.addCorrection(correction(session));
    const [kind, ...rest] = await evidence.correctionKinds();
    expect(rest).toEqual([]);
    expect(kind).toMatchObject({ key: "run_command/uses-npm-in-pnpm-repo", sessions: ["a", "b"] });
    await evidence.answerKind(kind!, true);
    expect((await evidence.failures()).map((failure) => [failure.session, failure.line, failure.signature])).toEqual([["a", 3, signature], ["b", 3, signature]]);
    expect(await evidence.correctionKinds()).toEqual([]);
  });

  it("leave out a message the classifier finds no failure of the agent's, such as the user changing course", async () => {
    const home = await mkdtemp(join(tmpdir(), "chopin-corrections-"));
    const exported = join(home, "projects", "p1", "rsi", "transcripts");
    await mkdir(exported, { recursive: true });
    await writeFile(join(exported, "1.jsonl"), lines([
      acp({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Write the report." } }),
      acp({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Writing it." } }),
      acp({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Actually, make it slides instead." } }),
    ]));
    const evidence = new Evidence(join(home, "rsi", "evidence"));
    const complete = async (prompt: string) => (prompt.startsWith("An agent's session may have gone wrong")
      ? '{"failure":false}' : '[{"line":2,"summary":"make slides, not a report"}]');
    expect(await harvest(evidence, await sessionSources(home, []), complete, [])).toMatchObject({ corrections: 0 });
    expect(await evidence.corrections()).toEqual([]);
  });

  it("turn into no failure when the user dismisses their kind", async () => {
    const evidence = new Evidence(await mkdtemp(join(tmpdir(), "chopin-corrections-")));
    for (const session of ["a", "b"]) await evidence.addCorrection(correction(session));
    await evidence.answerKind((await evidence.correctionKinds())[0]!, false);
    expect(await evidence.failures()).toEqual([]);
    expect(await evidence.pendingCorrections()).toEqual([]);
  });
});

describe("harvest", () => {
  it("reads a log again until every signal in it got an answer, asking only about the unanswered ones", async () => {
    const home = await mkdtemp(join(tmpdir(), "chopin-unanswered-"));
    const exported = join(home, "projects", "p1", "rsi", "transcripts");
    await mkdir(exported, { recursive: true });
    await writeFile(join(exported, "1.jsonl"), lines([
      acp({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Install deps." } }),
      acp({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", rawInput: { command: "npm install" } }),
      acp({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed" }),
      acp({ sessionUpdate: "tool_call", toolCallId: "c2", title: "bash", rawInput: { command: "npm ci" } }),
      acp({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "failed" }),
    ]));
    const evidence = new Evidence(join(home, "rsi", "evidence"));
    const named = '{"cause":"wrong_command","behavior":"run_command","mechanism":"uses-npm-in-pnpm-repo"}';
    const asked: string[] = [];
    const reply = (garbled: string) => async (prompt: string) => {
      if (!prompt.startsWith("An agent's session may have gone wrong")) return "[]";
      const signal = prompt.split("\n").find((line) => line.startsWith("The signal:"))!;
      asked.push(signal);
      return signal.includes(garbled) ? "I think it was npm." : named;
    };
    const sources = await sessionSources(home, []);
    expect(await harvest(evidence, sources, reply('"c2"'), [])).toMatchObject({ failures: 1 });
    asked.length = 0;
    expect(await harvest(evidence, sources, reply("nothing"), [])).toMatchObject({ read: 1, failures: 1 });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('"c2"');
    expect(await harvest(evidence, sources, reply("nothing"), [])).toMatchObject({ read: 0 });
  });

  it("counts only failures named by the current rules", async () => {
    const evidence = new Evidence(join(await mkdtemp(join(tmpdir(), "chopin-evidence-")), "evidence"));
    const signature = { cause: "other", behavior: "other", mechanism: "old-name" } as const;
    await evidence.addFailure({ session: "s", line: 1, signature });
    await evidence.addFailure({ session: "s", line: 2, signature, classifier: CLASSIFIER_VERSION });
    expect((await evidence.failures()).map((failure) => failure.line)).toEqual([2]);
  });

  it("gathers failures and corrections once, and asks again only about what is new", async () => {
    const home = await mkdtemp(join(tmpdir(), "chopin-harvest-"));
    const exported = join(home, "projects", "p1", "rsi", "transcripts");
    const logs = join(home, "other-agent");
    await mkdir(exported, { recursive: true });
    await mkdir(join(logs, "project"), { recursive: true });
    const chopinSession = join(exported, "1.jsonl");
    await writeFile(chopinSession, lines([
      acp({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Install deps." } }),
      acp({ sessionUpdate: "tool_call", toolCallId: "g1", title: "bash", rawInput: { command: "grep -r TODO src" } }),
      acp({ sessionUpdate: "tool_call_update", toolCallId: "g1", status: "failed" }),
      acp({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", rawInput: { command: "npm install" } }),
      acp({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed" }),
      acp({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "No, this repo uses pnpm." } }),
    ]));
    await writeFile(join(logs, "project", "s9.jsonl"), lines([
      { type: "user", sessionId: "s9", timestamp: at, promptSource: "typed", message: { role: "user", content: "Build it." } },
      { type: "assistant", sessionId: "s9", timestamp: at, message: { role: "assistant", content: [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm run build" } }] } },
      { type: "user", sessionId: "s9", timestamp: at, message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", is_error: true, content: "ERR_PNPM_ONLY" }] } },
    ]));
    const evidence = new Evidence(join(home, "rsi", "evidence"));
    const sources = await sessionSources(home, [logs]);
    expect(sources.map((source) => source.kind).sort()).toEqual(["acp", "messages"]);

    const first = model();
    expect(await harvest(evidence, sources, first.complete, [])).toEqual({ read: 2, failures: 2, corrections: 1 });
    // A correction is named on its own, not offered the failures' names to fall into.
    const correctionAsk = first.asked.find((prompt) => prompt.includes('"kind":"corrected"'))!;
    expect(correctionAsk).not.toContain("When it is the same failure as one already named");
    // The search that found nothing is not counted.
    expect((await evidence.failures()).map((failure) => [failure.session.endsWith("1.jsonl") ? "chopin" : "other", failure.line]).sort())
      .toEqual([["chopin", 3], ["other", 1]]);
    // The correction is named as a failure of the step it answers, the failed npm call.
    expect((await evidence.corrections()).map((correction) => [correction.line, correction.step, correction.summary, correction.signature.mechanism]))
      .toEqual([[5, 3, "use pnpm", "uses-npm-in-pnpm-repo"]]);

    const again = model();
    expect(await harvest(evidence, await sessionSources(home, [logs]), again.complete, [])).toEqual({ read: 0, failures: 0, corrections: 0 });
    expect(again.asked).toEqual([]);

    await appendFile(chopinSession, lines([
      acp({ sessionUpdate: "tool_call", toolCallId: "c2", title: "bash", rawInput: { command: "pnpm install" } }),
      acp({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "failed" }),
    ]));
    const grown = model();
    expect(await harvest(evidence, await sessionSources(home, [logs]), grown.complete, [])).toEqual({ read: 1, failures: 1, corrections: 0 });
    // Only the new failure is named, and with no new message from the user, nothing is asked about corrections.
    expect(grown.asked).toHaveLength(1);
    expect(grown.asked[0]).toMatch(/^An agent's session may have gone wrong/);
  });
});
