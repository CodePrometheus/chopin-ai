import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  AdmissionLedger, audit, auditSamples, calibrate, Calibration, CALIBRATION, continuationSamples, judgeEquivalent, judgeRepeat,
  LayerVersions, loadLayer, mcpSecrets, Rejections, secretValues, SHELVE_AFTER, TRIGGER_SESSIONS, triggered, type Command, type Layer, type LayerItem,
} from "@chopin-ai/core";
import { continueAt, layerExtension, stepText, transcriptMessages } from "@chopin-ai/harness-pi";
import { chopinModels } from "../credentials.js";
import { exclusive } from "../lock.js";
import { chopinHome, layerDirectory, readSettings, rsiDirectory } from "../home.js";
import { Budget, completer, namedModel, paidCall } from "./models.js";
import { Evidence, harvest, sessionSources, type Source } from "./harvest.js";
import { HeldProposals } from "./held.js";
import { archiveUnused } from "./lifecycle.js";
import { runRounds, type RoundSetup } from "./round.js";

const DAY_MS = 24 * 60 * 60_000;

/** How many of a kind's corrections the user is shown when asked about it. */
const CORRECTION_EXAMPLES = 3;

/** A configured path, with a leading `~/` meaning the home directory. */
function expand(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
const EMPTY: Layer = { instructions: undefined, skills: [], mcpServers: {}, gates: [] };

/** The loop's records, by where they are kept. */
function records() {
  const root = rsiDirectory();
  return {
    evidence: new Evidence(join(root, "evidence")),
    versions: new LayerVersions(join(root, "layer")),
    ledger: new AdmissionLedger(join(root, "ledger.jsonl")),
    rejections: new Rejections(join(root, "rejections.jsonl")),
    calibration: new Calibration(join(root, "calibration.jsonl")),
    certificates: join(root, "certificates"),
    spend: join(root, "spend.jsonl"),
    held: new HeldProposals(join(root, "held.jsonl")),
  };
}

/** What a round needs that costs money; refused until the models and the week's budget are set. */
async function paid() {
  const settings = await readSettings();
  const rsi = settings.rsi ?? {};
  const missing = [
    ...(rsi.regularModel === undefined ? ["rsi.regularModel"] : []),
    ...(rsi.strongModel === undefined ? ["rsi.strongModel"] : []),
    ...(rsi.weeklyBudgetUsd === undefined ? ["rsi.weeklyBudgetUsd"] : []),
    ...(settings.model === undefined ? ["model"] : []),
  ];
  if (missing.length > 0) throw new Error(`set ${missing.join(", ")} in ${join(chopinHome(), "config.json")} before the loop may spend anything`);
  const models = await chopinModels();
  const budget = new Budget(records().spend, rsi.weeklyBudgetUsd!);
  const sessionModel = namedModel(models, settings.model!);
  return {
    rsi, models, budget, sessionModel, modelName: settings.model!,
    regular: completer(models, namedModel(models, rsi.regularModel!), budget),
    strong: completer(models, namedModel(models, rsi.strongModel!), budget),
    own: completer(models, sessionModel, budget),
  };
}

async function handLayer(): Promise<Layer> {
  const directory = layerDirectory();
  const loaded = await stat(directory).then(() => loadLayer(directory), () => undefined);
  if (loaded?.ok === false) throw new Error(`invalid layer ${directory}:\n${loaded.problems.join("\n")}`);
  return loaded?.ok === true ? loaded.layer : EMPTY;
}

/** Runs the loop once now: calibrates the judges if they were not today, gathers evidence, and runs due rounds. */
export const evolveCommand: Command = {
  name: "evolve",
  args: "",
  summary: "improve the agent from its sessions once now: gather failures, propose changes, keep those that test better",
  run: async (_args, io) => {
    await mkdir(rsiDirectory(), { recursive: true, mode: 0o700 });
    const lock = exclusive(join(rsiDirectory(), "evolve.lock"));
    if (lock === undefined) {
      io.out("the loop is already running");
      return 0;
    }
    try {
      return await evolveOnce(io);
    } finally {
      lock.close();
    }
  },
};

async function evolveOnce(io: { out(text: string): void; err(text: string): void }): Promise<number> {
  const kept = records();
  const money = await paid();
  for (const recovered of [await kept.versions.recover(), await kept.ledger.recover()]) {
    if (recovered) io.err(`chopin: the loop's records were changed outside it and were put back: ${JSON.stringify(recovered)}`);
  }
  const judges = await calibrated(kept.calibration, money.strong, io);
  if (!judges) return 1;
  const base = await handLayer();
  // Sessions may hold what the user pasted, such as a token their MCP servers are configured with.
  const secrets = [...secretValues(process.env), ...mcpSecrets(base.mcpServers)];
  const sources = await sessionSources(chopinHome(), (money.rsi.transcriptSources ?? []).map(expand));
  io.out(`reading ${sources.length} recent sessions`);
  let done = 0;
  const gathered = await harvest(kept.evidence, sources, money.regular, secrets, (source, found) => {
    done += 1;
    io.out(`[${done}] ${source.path}: ${found.failures} failures, ${found.corrections} corrections`);
  });
  io.out(`read ${gathered.read} sessions: ${gathered.failures} new failures, ${gathered.corrections} corrections to confirm`);
  const projects = await projectsOf(sources);
  const setup: RoundSetup = {
    evidence: kept.evidence, sources, versions: kept.versions, base, ledger: kept.ledger,
    projectOf: (session) => {
      const key = projects.get(session);
      return key === undefined ? undefined : { key, versions: new LayerVersions(join(chopinHome(), "projects", key, "rsi", "layer")) };
    },
    rejections: kept.rejections, certificates: kept.certificates, propose: money.own, judge: money.strong,
    held: kept.held, holdForReview: money.rsi.holdForReview === true,
    report: (error) => io.err(`chopin: left out a decision point: ${error instanceof Error ? error.message : String(error)}`),
    rules: money.rsi.rulesFile === undefined ? "" : await readFile(expand(money.rsi.rulesFile), "utf8"),
    model: money.modelName, secrets,
    continueStep: async (layer, prefix) => stepText(await paidCall(money.budget, () => continueAt({
      messages: transcriptMessages(prefix, money.sessionModel), extensions: [CodingTools, layerExtension(layer, new Set())],
      model: money.sessionModel, models: money.models,
    }))),
  };
  await runRounds(setup, (outcome) => io.out(
    outcome.outcome === "kept" ? `kept a change for ${outcome.failure} as version ${outcome.version}`
      : outcome.outcome === "set_aside" ? `set aside ${outcome.failure}: ${outcome.reason}`
        : outcome.outcome === "held" ? `held a change for ${outcome.failure} for your review (chopin evolve review): ${outcome.reason}`
          : `refused a change for ${outcome.failure}: ${outcome.reason}`,
  ));
  const archived = await archiveUnused(kept.versions, sources, secrets);
  if (archived.length > 0) io.out(`archived ${archived.length} skills no session read for 30 days: ${archived.map((id) => id.slice(0, 8)).join(", ")}`);
  io.out(`spent $${(await money.budget.spent()).toFixed(2)} of $${money.budget.weeklyUsd.toFixed(2)} this week`);
  return 0;
}

/**
 * Measures each judge on cases whose answers are known, once a day or sooner while it has answered too few to count;
 * a judge that errs, or has not yet answered enough, decides nothing.
 */
async function calibrated(log: Calibration, strong: ReturnType<typeof completer>, io: { err(text: string): void }): Promise<boolean> {
  const known = continuationSamples();
  const audits = auditSamples({ existing: [], diagnosisTasks: [], rules: "" });
  const ids = (samples: readonly { id: string }[]) => new Set(samples.map((sample) => sample.id));
  const judges = [
    { name: "audit", ids: ids(audits), run: () => calibrate("audit", async (input) => (await audit(input, strong))?.decision, audits, log) },
    { name: "repeat", ids: ids(known.repeat), run: () => calibrate("repeat", (input) => judgeRepeat(input.context, input.step, input.failure, strong, input.correction), known.repeat, log) },
    { name: "equivalent", ids: ids(known.equivalent), run: () => calibrate("equivalent", (input) => judgeEquivalent(input.context, input.original, input.step, strong), known.equivalent, log) },
  ];
  const problems: string[] = [];
  for (const judge of judges) {
    const last = await log.lastAnswered(judge.name);
    const { total } = await log.accuracy(judge.name, judge.ids);
    const untried = await log.unanswered(judge.name, judge.ids);
    if (last === undefined || Date.now() - last >= DAY_MS || total < CALIBRATION.minimum || untried.length > 0) await judge.run();
    const { correct, total: answered } = await log.accuracy(judge.name, judge.ids);
    if (answered < CALIBRATION.minimum) problems.push(`the ${judge.name} judge has answered ${answered} of the ${CALIBRATION.minimum} known cases it needs`);
    else if (!(await log.trusted(judge.name, judge.ids))) problems.push(`the ${judge.name} judge got ${answered - correct} of ${answered} known cases wrong`);
  }
  for (const problem of problems) io.err(`chopin: ${problem}; no change is decided until it measures well`);
  return problems.length === 0;
}

/** What the loop holds now. */
export const evolveStatusCommand: Command = {
  name: "evolve status",
  args: "",
  summary: "show what the loop has learned, what it is waiting on, and what it has spent",
  run: async (_args, io) => {
    const kept = records();
    const version = await kept.versions.current();
    const items = await kept.versions.items(version);
    const kinds = await kept.evidence.kinds();
    const settings = await readSettings();
    let shelved = 0;
    for (const found of kinds) if (await kept.rejections.shelved(found.key, settings.model ?? "", found.failures.length, await kept.evidence.criteria(found))) shelved += 1;
    const pending = (await kept.evidence.correctionKinds()).filter((kind) => kind.sessions.length >= TRIGGER_SESSIONS).length;
    const budget = new Budget(kept.spend, settings.rsi?.weeklyBudgetUsd ?? 0);
    io.out([
      `layer version ${version}: ${items.filter((i) => !i.archived).length} items in use, ${items.filter((i) => i.archived).length} archived`,
      `failures: ${kinds.length} kinds, ${triggered(kinds).length} recurring, ${shelved} set aside: refused ${SHELVE_AFTER} times, or not recurring on this model`,
      `kinds of correction waiting for you: ${pending} (chopin evolve corrections)`,
      `changes held for your review: ${(await kept.held.waiting()).length} (chopin evolve review)`,
      `spent this week: $${(await budget.spent()).toFixed(2)}${settings.rsi?.weeklyBudgetUsd === undefined ? " (no budget set)" : ` of $${budget.weeklyUsd.toFixed(2)}`}`,
    ].join("\n"));
    return 0;
  },
};

/** Asks the user about each change the audit held; an approved one is tested in the next round, a refused one counts against its kind. */
export const evolveReviewCommand: Command = {
  name: "evolve review",
  args: "",
  summary: "approve or refuse the changes the audit held for you; approved ones are still tested before they are kept",
  run: async (_args, io) => {
    const kept = records();
    const waiting = await kept.held.waiting();
    if (waiting.length === 0) {
      io.out("no change is held for your review");
      return 0;
    }
    const ask = createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (const held of waiting) {
        const { candidate, prediction } = held.proposal;
        const question = [
          `For ${held.failure}, a ${candidate.kind}${held.proposal.skill === undefined ? "" : ` (${held.proposal.skill})`}:`,
          candidate.text.split("\n").map((line) => `  ${line}`).join("\n"),
          `It predicts: ${prediction}`,
          `The audit asks for you because: ${held.reasons.join("; ")}`,
          "Test it for keeping? [y/n/skip] ",
        ].join("\n");
        const answer = (await ask.question(question)).trim().toLowerCase();
        if (answer === "y") await kept.held.decide(held, "approved");
        if (answer === "n") {
          await kept.held.decide(held, "refused");
          await kept.rejections.record({ failure: held.failure, candidate: held.id, text: candidate.text, reason: "you refused it on review", prediction });
        }
      }
    } finally {
      ask.close();
    }
    return 0;
  },
};

/** The loop's changes, newest first. */
export const evolveLogCommand: Command = {
  name: "evolve log",
  args: "",
  summary: "list the changes the loop kept, newest first",
  run: async (_args, io) => {
    const kept = records();
    const items = await kept.versions.items(await kept.versions.current());
    if (items.length === 0) io.out("the loop has kept no change yet");
    for (const item of [...items].reverse()) {
      const what = (item.text ?? `skill ${item.skill}`).split("\n")[0];
      io.out(`${item.id.slice(0, 8)}  ${item.added.slice(0, 10)}  ${item.kind}${item.archived ? " (archived)" : ""}  ${what}`);
    }
    return 0;
  },
};

/** Takes a change back out; it stays in the history and can be restored by a later version. */
export const evolveUndoCommand: Command = {
  name: "evolve undo",
  args: "<id>",
  summary: "archive one change the loop kept, so new conversations run without it",
  run: async (args, io) => {
    const [id] = args;
    if (id === undefined || args.length > 1) {
      io.err("usage: chopin evolve undo <id>");
      return 2;
    }
    const kept = records();
    const items = await kept.versions.items(await kept.versions.current());
    const matches = items.filter((item) => item.id.startsWith(id) && !item.archived);
    if (matches.length !== 1) {
      io.err(matches.length === 0 ? `no change in use starts with ${id}` : `${id} names more than one change; give more of it`);
      return 1;
    }
    const [undone] = matches as [LayerItem];
    const version = await kept.versions.commit((all) => all.map((item) => (item.id === undone.id ? { ...item, archived: true } : item)));
    // The failure it answered is still there: the kind is taken up again, and its proposer is told this change was undone.
    if (undone.source.failure !== undefined) {
      await kept.rejections.record({
        failure: undone.source.failure, candidate: undone.id, text: undone.text ?? `the skill ${undone.skill}`, reason: "the user undid it after it was kept",
      });
      await kept.evidence.reopen(undone.source.failure);
    }
    io.out(`archived ${undone.id.slice(0, 8)}; new conversations use version ${version}`);
    return 0;
  },
};

/** Asks the user about each correction the loop found; a confirmed one becomes a failure to learn from. */
export const evolveCorrectionsCommand: Command = {
  name: "evolve corrections",
  args: "",
  summary: "confirm or dismiss, kind by kind, the corrections the loop found in your sessions",
  run: async (_args, io) => {
    const kept = records();
    const kinds = await kept.evidence.correctionKinds();
    const asking = kinds.filter((kind) => kind.sessions.length >= TRIGGER_SESSIONS);
    const later = kinds.filter((kind) => !asking.includes(kind)).reduce((sum, kind) => sum + kind.corrections.length, 0);
    if (later > 0) io.out(`${later} correction${later === 1 ? "" : "s"} wait until their kind comes up in another session`);
    if (asking.length === 0) {
      if (later === 0) io.out("no correction is waiting");
      return 0;
    }
    const ask = createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (const kind of asking) {
        const examples = kind.corrections.slice(0, CORRECTION_EXAMPLES).map((correction) => `  - ${correction.summary}`).join("\n");
        const question = `In ${kind.sessions.length} sessions you corrected the agent for ${kind.key}:\n${examples}\nLearn from these? [y/n/skip] `;
        const answer = (await ask.question(question)).trim().toLowerCase();
        if (answer === "y" || answer === "n") await kept.evidence.answerKind(kind, answer === "y");
      }
    } finally {
      ask.close();
    }
    return 0;
  },
};

/**
 * The project of each session, named as chopin names a project's directory: from where a chopin service wrote it, or
 * from the working directory another agent's log records.
 */
async function projectsOf(sources: readonly Source[]): Promise<Map<string, string>> {
  const projects = new Map<string, string>();
  const exported = join(chopinHome(), "projects");
  for (const source of sources) {
    if (source.kind === "acp" && source.path.startsWith(exported)) {
      projects.set(source.path, relative(exported, source.path).split(sep)[0]!);
      continue;
    }
    const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec((await readFile(source.path, "utf8")).slice(0, 200_000))?.[1];
    const root = cwd === undefined ? undefined : await realpath(JSON.parse(`"${cwd}"`) as string).catch(() => undefined);
    if (root !== undefined) projects.set(source.path, createHash("sha256").update(root).digest("hex").slice(0, 16));
  }
  return projects;
}
