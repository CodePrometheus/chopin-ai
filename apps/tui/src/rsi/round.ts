import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitDaily, audit, continuationPrefix, DEFAULT_PROPOSER_SKILL, LoopFault, MENDED_POINTS, recurringPoints, recursOften, effectiveLayer, goodSteps, isUserWritten, judgeContext, judgeEquivalent, judgeRepeat,
  loadSkills, overLimits, parseProposal, proposalBrief, PROPOSER_SKILL, SCREEN_PAIRS, signals, skillBody, triggered,
  type AdmissionLedger, type Certificate, type Complete, type FailureClass, type FixPoint, type Layer, type LayerItem,
  type LayerVersions, type ProtectPoint, type Rejections, type TranscriptEntry,
} from "@chopin-ai/core";
import { writeWhole } from "../home.js";
import { digest, readSession, type Evidence, type Source } from "./harvest.js";
import type { HeldProposal, HeldProposals } from "./held.js";
import { BudgetSpent } from "./models.js";

/** How much of a session before a decision point a continuation carries, and how many points a test draws from. */
const PREFIX = 40;
const PROTECT_POINTS = 20;

/** How much of each request the proposer read the audit is shown. */
const REQUEST_CHARS = 300;

/**
 * How many points a round may lose to failed calls, such as points a provider refuses for their content, before the
 * provider is probed to tell content it will not take from a fault that stops the loop, once they are also half of
 * the points tried; a point lost once is not tried again in the round.
 */
const POINT_FAILURES = 3;

/** Whether a round has lost enough of the points it tried, and so many of them, to probe the provider. */
export function tripsBreaker(lost: number, attempted: number): boolean {
  return lost >= POINT_FAILURES && lost * 2 >= attempted;
}

/** A session any model continues without objection, to tell a provider that fails from content it will not take. */
const PROBE: readonly TranscriptEntry[] = [{
  at: "", notification: { sessionId: "probe", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "List the files here." } } },
}];

/** Calls on one kind's sessions kept failing while the provider answered others: it will not take their content. */
class ContentRefused extends Error {}

/** Everything a round works with; the models and the continuation are passed in, so a test can stand in for them. */
export interface RoundSetup {
  evidence: Evidence;
  sources: readonly Source[];
  versions: LayerVersions;
  /** The versions of the project a session belongs to, for changes that hold only there; none when it cannot be told. */
  projectOf: (session: string) => { key: string; versions: LayerVersions } | undefined;
  /** The hand-written layer the loop's items are laid over. */
  base: Layer;
  ledger: AdmissionLedger;
  rejections: Rejections;
  /** Where certificates are written. */
  certificates: string;
  propose: Complete;
  judge: Complete;
  /** The agent's next step at a decision point, with `layer`, from the session up to it. */
  continueStep: (layer: Layer, prefix: readonly TranscriptEntry[]) => Promise<string>;
  /** Practices the user has ruled out, for the auditor. */
  rules: string;
  /** The model continuations run on, as `provider/model`. */
  model: string;
  secrets: readonly string[];
  limit?: number;
  random?: () => number;
  /** Told of each decision point a round leaves out because a call on it failed. */
  report?: (error: unknown) => void;
  held: HeldProposals;
  /** Whether a proposal the audit cannot settle waits for the user, rather than being refused. */
  holdForReview?: boolean;
}

export type RoundOutcome =
  | { failure: string; outcome: "kept"; version: number; certificate: Certificate }
  | { failure: string; outcome: "refused"; reason: string; certificate?: Certificate }
  | { failure: string; outcome: "set_aside"; reason: string }
  | { failure: string; outcome: "held"; reason: string };

/**
 * Runs a round for every kind of failure that recurred, has no change kept for it yet, and is not set aside: first
 * the kinds the user confirmed a correction of, then the rest, each in order of how many sessions it came from.
 */
export async function runRounds(setup: RoundSetup, onOutcome: (outcome: RoundOutcome) => void = () => {}): Promise<RoundOutcome[]> {
  const answered = await setup.evidence.answered();
  const waiting = new Set((await setup.held.waiting()).map((held) => held.failure));
  const corrections = await setup.evidence.confirmedCorrections();
  const corrected = (found: FailureClass) => Number(found.failures.some((failure) => corrections.has(`${failure.session}:${failure.line}`)));
  const outcomes: RoundOutcome[] = [];
  for (const found of triggered(await setup.evidence.kinds()).sort((a, b) => corrected(b) - corrected(a))) {
    if (answered.has(found.key) || waiting.has(found.key)) continue;
    const criteria = await setup.evidence.criteria(found);
    if (await setup.rejections.shelved(found.key, setup.model, found.failures.length, criteria)) continue;
    const approved = await setup.held.approved(found.key);
    const outcome = await runRound(setup, found, approved, corrections, criteria).catch((error: unknown) => {
      if (!(error instanceof ContentRefused)) throw error;
      return recordRefusal(setup, found, `its sessions keep failing to continue: ${error.message}`);
    });
    if (approved !== undefined) await setup.held.decide(approved, "tested");
    onOutcome(outcome);
    outcomes.push(outcome);
  }
  return outcomes;
}

interface Refusal {
  text?: string;
  prediction?: string;
  certificate?: Certificate;
  notRecurring?: { model: string; failures: number; criteria: string; tried: number };
}

/** Records why a round kept nothing; one that found the failure no longer happens sets the kind aside. */
async function recordRefusal(setup: RoundSetup, found: FailureClass, reason: string, refusal: Refusal = {}): Promise<RoundOutcome> {
  const { text = "", prediction, certificate, notRecurring } = refusal;
  await setup.rejections.record({
    failure: found.key, candidate: certificate?.candidate ?? "", text, reason, ...(prediction && { prediction }), ...(notRecurring && { notRecurring }),
  });
  if (notRecurring !== undefined) return { failure: found.key, outcome: "set_aside", reason };
  return { failure: found.key, outcome: "refused", reason, ...(certificate && { certificate }) };
}

/**
 * One round for one kind of failure. Its failures are first continued with the incumbent to find where it still
 * happens; a failure that no longer does leaves nothing to mend on this model. Then the proposer reads every time it
 * happened and proposes one change, which must fit the layer's limits and pass the audit, and is tested where the
 * failure recurs and on steps that went right in sessions the proposer did not read, kept as a new version only if
 * it is better there.
 */
async function runRound(
  setup: RoundSetup,
  found: FailureClass,
  approved: HeldProposal | undefined,
  corrections: ReadonlyMap<string, string>,
  criteria: string,
): Promise<RoundOutcome> {
  const refuse = (reason: string, refusal?: Refusal) => recordRefusal(setup, found, reason, refusal);
  const sessions = new Map<string, TranscriptEntry[]>();
  const read = async (path: string) => {
    let entries = sessions.get(path);
    if (entries === undefined) {
      const source = setup.sources.find((candidate) => candidate.path === path);
      entries = source === undefined ? [] : await readSession(source, setup.secrets);
      sessions.set(path, entries);
    }
    return entries;
  };
  const random = setup.random ?? Math.random;
  const current = await setup.versions.current();
  const items = await setup.versions.items(current);
  const runner = { model: setup.model, harness: "pi", anyModel: true };
  const incumbent = await effectiveLayer(setup.base, setup.versions, current, runner);
  const attempted = new Set<string>();
  const lost = new Set<string>();
  const guarded = async <T>(point: string, call: () => Promise<T>): Promise<T | undefined> => {
    if (lost.has(point)) return undefined;
    attempted.add(point);
    try {
      return await call();
    } catch (error) {
      if (error instanceof BudgetSpent || error instanceof ContentRefused || error instanceof LoopFault) throw error;
      lost.add(point);
      if (!tripsBreaker(lost.size, attempted.size)) {
        setup.report?.(error);
        return undefined;
      }
      if (await answers()) throw new ContentRefused(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  // Whether the provider answers a continuation and a judge at all.
  const answers = async () => {
    try {
      await judgeRepeat("", await setup.continueStep(incumbent, PROBE), found.signature, setup.judge);
      return true;
    } catch (error) {
      if (error instanceof BudgetSpent) throw error;
      return false;
    }
  };

  const prefixes = new Map<string, readonly TranscriptEntry[]>();
  const sessionOf = new Map<string, string>();
  const failurePoints: FixPoint[] = [];
  for (const failure of found.failures) {
    const entries = await read(failure.session);
    const prefix = continuationPrefix(entries, failure.line, PREFIX);
    if (prefix === undefined) continue;
    const id = `${failure.session}:${failure.line}`;
    prefixes.set(id, prefix);
    sessionOf.set(id, failure.session);
    const correction = corrections.get(id);
    failurePoints.push({ id, context: judgeContext(entries, failure.line), failure: found.signature, ...(correction !== undefined && { correction }) });
  }
  if (failurePoints.length === 0) return refuse("none of its failures has a conversation before it to continue from");
  const known = await setup.evidence.recurrence(current, setup.model);
  // A verdict holds for the criterion it was judged by, so a point judged by a correction keeps its own.
  const judged = (point: FixPoint) => (point.correction === undefined ? point.id : `${point.id}#${digest(point.correction)}`);
  const drawn = (point: FixPoint, draw: number) => (draw === 0 ? judged(point) : `${judged(point)}@${draw}`);
  const draws = (point: FixPoint) => {
    let count = 0;
    while (known.has(drawn(point, count))) count += 1;
    return count;
  };
  // Draws already made cost nothing to make again, so the points with the most come first.
  const order = shuffled(failurePoints, random).sort((a, b) => draws(b) - draws(a));
  const { recurring, repeats, tried } = await recurringPoints(order, async (point, draw) => {
    const key = drawn(point, draw);
    const cached = known.get(key);
    if (cached !== undefined) return cached;
    const step = await guarded(point.id, () => setup.continueStep(incumbent, prefixes.get(point.id) ?? []));
    const verdict = step === undefined ? undefined : await guarded(point.id, () => judgeRepeat(point.context, step, point.failure, setup.judge, point.correction));
    if (verdict === undefined) return undefined;
    await setup.evidence.addRecurrence(key, current, setup.model, verdict === "repeats");
    return verdict === "repeats";
  });
  if (tried === 0) return refuse("none of its failures could be continued");
  if (!recursOften({ repeats, tried })) {
    return refuse(`it seldom recurs when its sessions are continued: ${repeats} of the ${tried} continuations`, { notRecurring: { model: setup.model, failures: found.failures.length, criteria, tried } });
  }
  // No change could be kept until it recurs at enough points; the checks are cached per layer version, so retrying is free.
  if (recurring.length < MENDED_POINTS) {
    return { failure: found.key, outcome: "set_aside", reason: `it recurs at ${recurring.length} decision point, and a change must mend ${MENDED_POINTS}` };
  }

  // A proposal the user approved after the audit held it is tested as it was; a new one is asked for otherwise.
  const proposal = approved?.proposal ?? parseProposal(await setup.propose(await proposerPrompt(setup, found, corrections, items, incumbent, read)));
  if (proposal === undefined) return refuse("the proposer's reply was not one well-formed proposal");
  const { candidate, prediction } = proposal;
  const proposed = { text: candidate.text, prediction };

  const changed = await withCandidate(incumbent, items, proposal);
  if (changed === undefined) return refuse("the skill it proposed does not load", proposed);
  const over = overLimits(changed);
  if (over.length > 0) return refuse(`it would put the layer over its limits: ${over.join("; ")}`, proposed);
  if (approved === undefined) {
    const audited = await audit({
      candidate, rules: setup.rules,
      existing: items.filter((item) => !item.archived).map((item) => ({ id: item.id, text: item.text ?? item.skill ?? "" })),
      diagnosisTasks: await requests(found, read),
    }, setup.judge);
    if (audited === undefined) return refuse("the audit could not be read", proposed);
    if (audited.decision === "review" && setup.holdForReview === true) {
      await setup.held.hold({ id: randomUUID(), failure: found.key, proposal, reasons: audited.reasons });
      return { failure: found.key, outcome: "held", reason: `the audit asks for your review: ${audited.reasons.join("; ")}` };
    }
    if (audited.decision !== "admit") {
      const why = audited.decision === "revise" ? `it overlaps ${audited.existing}; revise that item instead` : audited.reasons.join("; ") || audited.decision;
      return refuse(`the audit ${audited.decision === "review" ? "asks for your review" : "refused it"}: ${why}`, proposed);
    }
  }

  const project = proposal.scope === "project" ? setup.projectOf(found.failures[0]!.session) : undefined;
  if (proposal.scope === "project" && project === undefined) return refuse("it holds only in one project, and the session's project cannot be told", proposed);
  const target = project?.versions ?? setup.versions;
  const targetVersion = await target.current();
  const before = project === undefined ? incumbent : await effectiveLayer(incumbent, project.versions, targetVersion, runner);
  const after = project === undefined ? changed : await withCandidate(before, await target.items(targetVersion), proposal);
  if (after === undefined) return refuse("the skill it proposed does not load", proposed);
  const sameScope = (path: string) => project === undefined || setup.projectOf(path)?.key === project.key;
  const fixPoints = recurring.filter((point) => sameScope(sessionOf.get(point.id) ?? ""));
  if (fixPoints.length < MENDED_POINTS) return refuse(`it recurs at fewer than ${MENDED_POINTS} decision points in the project it holds in`, proposed);

  const protectPoints = await protect(setup, read, new Set(found.sessions), prefixes, sameScope);
  const id = randomUUID();
  const certificate = await admitDaily({
    candidate: id, kind: candidate.kind, scope: project === undefined ? { kind: "global" } : { kind: "project", project: project.key },
    incumbent: targetVersion, fixPoints, protectPoints,
    continueAt: async (arm, point) => {
      const step = await guarded(point.id, () => setup.continueStep(arm === "candidate" ? after : before, prefixes.get(point.id) ?? []));
      if (step === undefined) return undefined;
      const used = proposal.skill === undefined || step.includes(`"call":"skill"`) && step.includes(`"${proposal.skill}"`);
      return { step, used: arm === "candidate" && used };
    },
    judgeRepeat: async (point, step) => guarded(point.id, () => judgeRepeat(point.context, step, point.failure, setup.judge, point.correction)),
    judgeEquivalent: async (point, step) => guarded(point.id, () => judgeEquivalent(point.context, point.original, step, setup.judge)),
    ledger: setup.ledger, limit: setup.limit ?? 120, mustBeUsed: proposal.skill !== undefined, prediction, model: setup.model,
    random,
  });
  await mkdir(setup.certificates, { recursive: true });
  await writeWhole(join(setup.certificates, `${id}.json`), `${JSON.stringify(certificate, null, 2)}\n`, 0o600);
  if (certificate.pairs === 0 && lost.size > 0) return refuse(`none of its decision points could be continued: ${lost.size} lost`, { ...proposed, certificate });
  const { pairs, incumbentRepeated, candidateRepeated } = certificate.atFailures;
  const atFailures = `at failures it repeated ${candidateRepeated} of ${pairs} times, the incumbent ${incumbentRepeated}`;
  if (certificate.screenedOut) return refuse(`it mended none of the first ${SCREEN_PAIRS} failures it was tried on; ${atFailures}`, { ...proposed, certificate });
  if (!certificate.kept) {
    const short = `evidence ${certificate.evidence.toFixed(2)} short of ${(1 / certificate.level).toFixed(0)}`;
    return refuse(`not better where tested: ${certificate.pairs} pairs, ${short}; ${atFailures}`, { ...proposed, certificate });
  }
  const item: LayerItem = {
    id, kind: candidate.kind, ...(candidate.kind === "instruction" ? { text: candidate.text } : { skill: proposal.skill }),
    validated: { models: [setup.model], harnesses: ["pi"] }, source: { failure: found.key, certificate: id },
    pinned: false, archived: false, added: new Date().toISOString(),
  };
  const files = proposal.skill === undefined ? {} : { [`skills/${proposal.skill}/SKILL.md`]: candidate.text };
  const version = await target.commit((all) => [...all.map((old) => (old.id === candidate.revises ? { ...old, archived: true } : old)), item], files);
  await setup.evidence.addAnswered(found.key);
  return { failure: found.key, outcome: "kept", version, certificate };
}

/** What the proposer is asked: its method, the instructions in use, and the brief on the failure. */
async function proposerPrompt(
  setup: RoundSetup,
  found: FailureClass,
  corrections: ReadonlyMap<string, string>,
  items: readonly LayerItem[],
  incumbent: Layer,
  read: (path: string) => Promise<TranscriptEntry[]>,
): Promise<string> {
  const sessions = [];
  for (const session of found.sessions) {
    sessions.push({ session, entries: await read(session), lines: found.failures.filter((f) => f.session === session).map((f) => f.line) });
  }
  const brief = proposalBrief({
    failure: found, sessions, corrections,
    secrets: setup.secrets,
    rejections: await setup.rejections.for(found.key),
    existing: items.filter((item) => !item.archived).map((item) => ({ id: item.id, text: item.text ?? item.skill ?? "" })),
  });
  const own = incumbent.skills.find((skill) => skill.name === PROPOSER_SKILL);
  const method = own === undefined ? DEFAULT_PROPOSER_SKILL : await readFile(join(own.directory, "SKILL.md"), "utf8");
  return [skillBody(method), "## Your instructions now", incumbent.instructions ?? "(none)", brief].join("\n\n");
}

/** `items` in a random order, every order equally likely. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const order = [...items];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/** The layer with the proposal applied, the item it revises taking its place; `undefined` when a skill does not load. */
async function withCandidate(layer: Layer, items: readonly LayerItem[], proposal: NonNullable<ReturnType<typeof parseProposal>>): Promise<Layer | undefined> {
  const revised = items.find((item) => item.id === proposal.candidate.revises);
  if (proposal.skill === undefined) {
    const kept = revised?.text === undefined ? layer.instructions ?? "" : (layer.instructions ?? "").replace(revised.text, "");
    return { ...layer, instructions: [kept.trim(), proposal.candidate.text].filter((text) => text !== "").join("\n\n") };
  }
  const root = await mkdtemp(join(tmpdir(), "chopin-candidate-"));
  await mkdir(join(root, proposal.skill), { recursive: true });
  await writeFile(join(root, proposal.skill, "SKILL.md"), proposal.candidate.text);
  const problems: string[] = [];
  const [skill] = await loadSkills(root, problems);
  if (skill === undefined || problems.length > 0) return undefined;
  return { ...layer, skills: [...layer.skills.filter((s) => s.name !== skill.name && s.name !== revised?.skill), skill] };
}

/**
 * What the user had asked before each failure: the tasks the proposer read, which a general change must not be keyed
 * to.
 */
async function requests(found: FailureClass, read: (path: string) => Promise<TranscriptEntry[]>): Promise<string[]> {
  const asked = new Set<string>();
  for (const failure of found.failures) {
    const entry = (await read(failure.session)).slice(0, failure.line).findLast(isUserWritten);
    const update = entry !== undefined && "notification" in entry ? entry.notification.update : undefined;
    if (update?.sessionUpdate === "user_message_chunk" && update.content.type === "text") asked.add(update.content.text.slice(0, REQUEST_CHARS));
  }
  return [...asked];
}

/** Steps that went right in sessions the proposer did not read, each with the session before it. */
async function protect(
  setup: RoundSetup,
  read: (path: string) => Promise<TranscriptEntry[]>,
  seen: ReadonlySet<string>,
  prefixes: Map<string, readonly TranscriptEntry[]>,
  inScope: (path: string) => boolean,
): Promise<ProtectPoint[]> {
  const random = setup.random ?? Math.random;
  const points: ProtectPoint[] = [];
  const others = setup.sources.filter((source) => !seen.has(source.path) && inScope(source.path)).map((source) => source.path);
  for (const path of shuffled(others, random)) {
    if (points.length >= PROTECT_POINTS) break;
    const entries = await read(path);
    const good = goodSteps(entries, signals(entries).map((signal) => signal.line));
    const line = good[Math.floor(random() * good.length)];
    const prefix = line === undefined ? undefined : continuationPrefix(entries, line, PREFIX);
    if (line === undefined || prefix === undefined) continue;
    const id = `${path}:${line}`;
    prefixes.set(id, prefix);
    points.push({ id, context: judgeContext(entries, line), original: JSON.stringify(entries[line]) });
  }
  return points;
}

