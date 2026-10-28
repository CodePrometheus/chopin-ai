import { describe, expect, it } from "vitest";
import {
  classify, continuationPrefix, correctedStep, failureStep, fromMessagesJsonl, isUserWritten, goodSteps, groupFailures, layerUsage, mcpSecrets, parseSignature, proposeCorrections, redactText, redactTranscript, secretValues,
  kindAliases, signals, triggered, withChopinMeta, type Failure, type TranscriptEntry,
} from "../src/index.js";

const at = "2026-10-27T00:00:00.000Z";
const update = (value: object): TranscriptEntry => ({ at, notification: { sessionId: "s1", update: value as never } });

describe("redaction", () => {
  it("masks known secret values and common secret formats", () => {
    const text = "key=sk-0123456789abcdefghijABCD token: ghp_abcdefghijklmnopqrstuvwxyz0123456789 value hunter2-hunter2";
    expect(redactText(text, ["hunter2-hunter2"])).toBe("key=[redacted] token: [redacted] value [redacted]");
  });

  it("takes only values of variables named like secrets, long enough to be one", () => {
    expect(secretValues({ API_KEY: "abcdefgh1234", HOME: "/home/someone", SHORT_TOKEN: "abc" })).toEqual(["abcdefgh1234"]);
  });

  it("takes the secrets MCP servers are configured with, so a pasted token is masked with or without its scheme", () => {
    const secrets = mcpSecrets({
      evaluation: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer zz_1234abcd5678", Accept: "application/json" } },
      local: { command: "server", env: { SERVICE_TOKEN: "tok-87654321", DATA_DIR: "/var/lib/data-dir" } },
    });
    expect(secrets).toEqual(["Bearer zz_1234abcd5678", "zz_1234abcd5678", "tok-87654321"]);
    expect(redactText("the header was Bearer zz_1234abcd5678, then zz_1234abcd5678 alone", secrets)).toBe("the header was [redacted], then [redacted] alone");
  });

  it("withholds what a tool read from a secret file, keeping that it read it", () => {
    const redacted = redactTranscript([
      update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "read", rawInput: { path: "app/.env.local" } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed",
        content: [{ type: "content", content: { type: "text", text: "DB_PASSWORD=plaintext" } }] }),
      update({ sessionUpdate: "tool_call", toolCallId: "c2", title: "read", rawInput: { path: "README.md" } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "completed",
        content: [{ type: "content", content: { type: "text", text: "Hello" } }] }),
    ], []);
    expect(JSON.stringify(redacted[1])).not.toContain("plaintext");
    expect(JSON.stringify(redacted[1])).toContain("secret file withheld");
    expect(JSON.stringify(redacted[3])).toContain("Hello");
  });
});

describe("signals", () => {
  it("finds failed and refused tool calls, interruptions and failed turns, at their lines", () => {
    const entries: TranscriptEntry[] = [
      update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", rawInput: { command: "npm test" } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed" }),
      update({ sessionUpdate: "tool_call", toolCallId: "c2", title: "write" }),
      update(withChopinMeta({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "failed" }, { diagnostics: ["blocked"] })),
      { at, sessionId: "s1", turnEnd: { stopReason: "cancelled" } },
      { at, sessionId: "s1", turnEnd: withChopinMeta({ stopReason: "end_turn" }, { error: "model_error" }) },
      { at, sessionId: "s1", turnEnd: { stopReason: "end_turn" } },
    ];
    expect(signals(entries)).toEqual([
      { kind: "tool_failed", line: 1, tool: "bash", toolCallId: "c1", blocked: false },
      { kind: "tool_failed", line: 3, tool: "write", toolCallId: "c2", blocked: true },
      { kind: "interrupted", line: 4 },
      { kind: "turn_failed", line: 5, error: "model_error" },
    ]);
  });
});

describe("layer usage", () => {
  it("counts skill reads, MCP calls by server and refused calls", () => {
    const used = layerUsage([
      update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "skill", rawInput: { name: "release" } }),
      update({ sessionUpdate: "tool_call", toolCallId: "c2", title: "skill", rawInput: { name: "release" } }),
      update({ sessionUpdate: "tool_call", toolCallId: "c3", title: "mcp__docs__search" }),
      update(withChopinMeta({ sessionUpdate: "tool_call_update", toolCallId: "c3", status: "failed" }, { diagnostics: ["blocked"] })),
    ], ["docs"]);
    expect(used).toEqual({ skills: new Map([["release", 2]]), mcpServers: new Map([["docs", 1]]), blocked: 1 });
  });
});

describe("failure signatures", () => {
  it("accepts only replies that fit the three fields", () => {
    expect(parseSignature('Here: {"cause":"skipped_verification","behavior":"answer","mechanism":"claims-done-untested"}'))
      .toEqual({ cause: "skipped_verification", behavior: "answer", mechanism: "claims-done-untested" });
    expect(parseSignature('{"cause":"bad luck","behavior":"answer","mechanism":"x"}')).toBeUndefined();
    expect(parseSignature('{"cause":"other","behavior":"answer","mechanism":"Not A Slug"}')).toBeUndefined();
    expect(parseSignature("no json")).toBeUndefined();
    expect(parseSignature('{"failure":false}')).toBe("not_a_failure");
  });

  it("asks the model with the failure, the lines before it and the mechanisms already named", async () => {
    let asked = "";
    const entries = [update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash" }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed" })];
    const known = { cause: "tool_error", behavior: "run_command", mechanism: "stops-at-truncated-output" } as const;
    const signature = await classify(entries, signals(entries)[0]!, [known], async (prompt) => {
      asked = prompt;
      return JSON.stringify(known);
    });
    expect(signature).toEqual(known);
    // The whole signature is offered, so the cause is reused along with the mechanism.
    expect(asked).toContain(JSON.stringify(known));
    expect(asked).toContain('"toolCallId":"c1"');
  });

  it("shows what came after up to the user's next message, marks the failure, and offers the most common names", async () => {
    const asked: string[] = [];
    const text = (sessionUpdate: string, words: string) => update({ sessionUpdate, content: { type: "text", text: words } });
    const entries = [
      text("user_message_chunk", "Show the notes."),
      update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", rawInput: { command: "grep -r notes ." } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed" }),
      text("agent_message_chunk", "Nothing matched, so there are no notes yet."),
      text("user_message_chunk", "Fine, thanks."),
      text("agent_message_chunk", "Glad to help."),
    ];
    const known = Array.from({ length: 40 }, (_, i) => ({ cause: "tool_error", behavior: "run_command", mechanism: `kind-${i}` } as const));
    const ask = async (prompt: string) => (asked.push(prompt), '{"failure":false}');
    expect(await classify(entries, signals(entries)[0]!, known, ask, true)).toBe("not_a_failure");
    await classify(entries, signals(entries)[0]!, known, ask);
    const [foreign, own] = asked as [string, string];
    const lines = foreign.split("\n");
    expect(lines.filter((line) => line.startsWith(">>> "))).toEqual([expect.stringContaining('"status":"failed"')]);
    expect(foreign).toContain("Nothing matched");
    expect(foreign).toContain("Fine, thanks.");
    expect(foreign).not.toContain("Glad to help.");
    expect(foreign).toContain("of at most 8 words");
    expect(foreign).toContain('"mechanism":"kind-29"');
    expect(foreign).not.toContain('"mechanism":"kind-30"');
    // Only another agent's session is told that its host's own refusals are not the agent's.
    expect(foreign).toContain("its host's rules are not this agent's");
    expect(own).not.toContain("host");
  });

  it("groups by what the agent did and how, whatever cause each was given, and triggers once a kind recurs in two sessions", () => {
    const signature = { cause: "wrong_command", behavior: "run_command", mechanism: "uses-npm-in-pnpm-repo" } as const;
    const judgedOtherwise = { ...signature, cause: "environment" } as const;
    const other = { ...signature, mechanism: "forgets-lockfile" };
    const failures: Failure[] = [
      { session: "a", line: 3, signature }, { session: "a", line: 9, signature },
      { session: "b", line: 2, signature: judgedOtherwise }, { session: "c", line: 5, signature: other },
    ];
    const classes = groupFailures(failures);
    expect(classes.map((found) => [found.key, found.sessions])).toEqual([
      ["run_command/uses-npm-in-pnpm-repo", ["a", "b"]], ["run_command/forgets-lockfile", ["c"]],
    ]);
    expect(classes[0]!.signature).toEqual(signature);
    expect(triggered(classes).map((found) => found.signature.mechanism)).toEqual(["uses-npm-in-pnpm-repo"]);
  });
});

describe("kind names", () => {
  it("brings kinds named in other words together under the first name of their group, within one behavior", async () => {
    const asked: string[] = [];
    const kinds = ["run_command/unquoted-glob-no-matches", "run_command/glob-unquoted-in-zsh", "run_command/uses-npm", "edit/stale-write", "read/huge-file"];
    const aliases = await kindAliases(kinds, async (prompt) => {
      asked.push(prompt);
      // A group naming a kind that is not there, or one already grouped, is not taken.
      return '[["unquoted-glob-no-matches","glob-unquoted-in-zsh"],["uses-npm","not-a-kind"],["glob-unquoted-in-zsh","uses-npm"]]';
    });
    expect([...aliases]).toEqual([["run_command/glob-unquoted-in-zsh", "run_command/unquoted-glob-no-matches"]]);
    // Only a behavior with more than one name is asked about, and never across behaviors.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('"run_command"');
    expect(asked[0]).not.toContain("stale-write");

    const signature = (cause: "wrong_command" | "environment", mechanism: string) => ({ cause, behavior: "run_command", mechanism } as const);
    const failures: Failure[] = [
      { session: "a", line: 1, signature: signature("environment", "glob-unquoted-in-zsh") },
      { session: "b", line: 1, signature: signature("wrong_command", "unquoted-glob-no-matches") },
      { session: "c", line: 1, signature: signature("environment", "glob-unquoted-in-zsh") },
    ];
    const [merged] = groupFailures(failures, aliases);
    expect(merged).toMatchObject({ key: "run_command/unquoted-glob-no-matches", sessions: ["a", "b", "c"] });
    expect(merged!.signature).toEqual(signature("environment", "unquoted-glob-no-matches"));
  });
});

describe("kind names over time", () => {
  it("keeps the names it settled on, and asks only where a new kind came in", async () => {
    const before = { reviewed: ["run_command/a", "run_command/b", "run_command/x", "edit/c"], aliases: new Map([["run_command/b", "run_command/a"]]) };
    const asked: string[] = [];
    const kinds = [...before.reviewed, "run_command/d", "run_command/e"];
    // The reply puts a new kind with an alias, another with two kinds settled apart, and repeats no earlier merge.
    const aliases = await kindAliases(kinds, async (prompt) => (asked.push(prompt), '[["d","b"],["x","a","e"]]'), before);
    expect(Object.fromEntries(aliases)).toEqual({ "run_command/b": "run_command/a", "run_command/d": "run_command/a", "run_command/e": "run_command/x" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toContain('"edit"');
  });
});

describe("decision points", () => {
  const user = (text: string) => update({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
  const call = (id: string, title = "bash") => update({ sessionUpdate: "tool_call", toolCallId: id, title });
  const done = (id: string, status: "completed" | "failed") => update({ sessionUpdate: "tool_call_update", toolCallId: id, status });
  const entries: TranscriptEntry[] = [
    user("Add the feature."), call("c1"), done("c1", "completed"), call("c2"), done("c2", "failed"),
    user("No, run the tests first."), call("c3"), done("c3", "completed"),
  ];

  it("continues from a message in the user's role, looking a little further back for one, and not without one", () => {
    const user = update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Go." } });
    const call = (id: string) => update({ sessionUpdate: "tool_call", toolCallId: id, title: "bash" });
    const result = (id: string) => update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
    const session = [user, call("a"), result("a"), user, call("b"), result("b"), call("c"), result("c"), call("d")];
    expect(continuationPrefix(session, 8, 6)).toEqual(session.slice(3, 8));
    expect(continuationPrefix(session, 8, 3)).toEqual(session.slice(3, 8));
    expect(continuationPrefix(session, 8, 2)).toBeUndefined();
  });

  it("goes back from a failure to its call, and from a correction to the step before it", () => {
    expect(failureStep(entries, signals(entries)[0]!)).toBe(3);
    expect(correctedStep(entries, 5)).toBe(3);
  });

  it("counts as good only completed calls with nothing wrong before the user speaks again", () => {
    expect(goodSteps(entries, [4, 5])).toEqual([6]);
    expect(goodSteps(entries, [])).toEqual([1, 6]);
  });
});

describe("message-log transcripts", () => {
  // Shaped like the logs it reads: what the user typed carries promptSource "typed"; reminders, command output and
  // task notifications arrive in the user's role with another source or none.
  const typed = (content: unknown) => ({ type: "user", sessionId: "s9", timestamp: at, promptSource: "typed",
    origin: { kind: "typed" }, userType: "external", message: { role: "user", content } });
  const system = (content: unknown) => ({ type: "user", sessionId: "s9", timestamp: at, promptSource: "system",
    origin: { kind: "system" }, userType: "external", message: { role: "user", content } });
  const assistant = (content: unknown[], stop?: string) => ({ type: "assistant", sessionId: "s9", timestamp: at,
    message: { role: "assistant", model: "model-a", ...(stop === undefined ? {} : { stop_reason: stop }), content } });
  const log = [
    typed("Install deps."),
    system("<system-reminder>Keep answers short.</system-reminder>"),
    assistant([{ type: "thinking", thinking: "Check the lockfile." },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm install" } }]),
    { type: "user", sessionId: "s9", timestamp: at, userType: "external", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: "lockfile mismatch" }] },
    ] } },
    { ...typed("side thread"), isSidechain: true },
    { type: "file-history-snapshot", messageId: "m1" },
    { type: "user", sessionId: "s9", timestamp: at, message: { role: "user", content: "[Request interrupted by user]" } },
    typed("No, this repo uses pnpm."),
    assistant([{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pnpm install" } }]),
    { type: "user", sessionId: "s9", timestamp: at, message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "t2", content: "Done in 2s" },
    ] } },
    assistant([{ type: "text", text: "Installed." }], "end_turn"),
  ].map((line) => JSON.stringify(line)).join("\n");
  const entries = fromMessagesJsonl(log);
  const kinds = entries.map((entry) => "notification" in entry ? entry.notification.update.sessionUpdate : `end:${entry.turnEnd.stopReason}`);

  it("keeps the session's own thread, with chopin's tool names, and leaves out side threads and bookkeeping", () => {
    expect(kinds).toEqual([
      "user_message_chunk", "user_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "end:cancelled",
      "user_message_chunk", "tool_call", "tool_call_update", "agent_message_chunk", "end:end_turn",
    ]);
    expect(signals(entries)).toEqual([
      { kind: "tool_failed", line: 4, tool: "bash", toolCallId: "t1", blocked: false },
      { kind: "interrupted", line: 5 },
    ]);
  });

  it("marks a call the user declined, which is no failure of the agent's", () => {
    const declined = fromMessagesJsonl([
      typed("Ship it."),
      assistant([{ type: "tool_use", id: "t3", name: "Bash", input: { command: "git push --tags" } }]),
      { type: "user", sessionId: "s9", timestamp: at, toolUseResult: "User rejected tool use", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "t3", is_error: true, content: "The user doesn't want to proceed with this tool use." },
      ] } },
      typed("Not yet, the notes are not written."),
    ].map((line) => JSON.stringify(line)).join("\n"));
    const result = declined[2] as Extract<TranscriptEntry, { notification: unknown }>;
    expect(result.notification.update).toMatchObject({ status: "failed", _meta: { "chopin-ai": { diagnostics: ["rejected"] } } });
    expect(signals(declined)).toEqual([]);
    expect(correctedStep(declined, 3)).toBe(1);
  });

  it("tells what the user wrote from what the harness injected in the user's role", () => {
    expect(entries.flatMap((entry, line) => (isUserWritten(entry) ? [line] : []))).toEqual([0, 6]);
  });

  it("asks about corrections with only the user's messages and the step before each, never a system line", async () => {
    let asked = "";
    const found = await proposeCorrections(entries, async (prompt) => {
      asked = prompt;
      return '[{"line":6,"summary":"use pnpm, not npm"},{"line":1,"summary":"keep answers short"}]';
    });
    expect(found).toEqual([{ line: 6, summary: "use pnpm, not npm" }]);
    expect(asked).toContain("No, this repo uses pnpm.");
    expect(asked).not.toContain("Keep answers short.");
    expect(asked).not.toContain("Done in 2s");
    expect(asked).toContain("frustration that names nothing");
    expect(asked).toContain("what the agent should do instead");
  });

  it("asks about a long session in bounded batches and keeps what every batch found", async () => {
    const long: TranscriptEntry[] = Array.from({ length: 300 }, (_, i) =>
      update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: `message ${i} ${"x".repeat(900)}` } }));
    const sizes: number[] = [];
    const found = await proposeCorrections(long, async (prompt) => {
      sizes.push(prompt.length);
      const first = Number(/user (\d+):/.exec(prompt)![1]);
      return JSON.stringify([{ line: first, summary: "first of batch" }]);
    });
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThan(62_000);
    expect(found).toHaveLength(sizes.length);
  });

  it("counts a step as good only up to the user's next own message", () => {
    expect(goodSteps(entries, signals(entries).map((signal) => signal.line))).toEqual([7]);
  });
});
