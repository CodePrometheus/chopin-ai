import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  classify, CLASSIFIER_VERSION, correctedStep, failureStep, fromMessagesJsonl, groupFailures, kindAliases, kindKey, parseTranscript,
  proposeCorrections, redactTranscript, signals, signatureKey, type Complete, type CorrectionCandidate, type Failure,
  type FailureClass, type FailureSignature, type TranscriptEntry,
} from "@chopin-ai/core";
import { writeWhole } from "../home.js";

/** A session log the loop reads: an ACP transcript a chopin service wrote, or another agent's message log. */
export interface Source {
  path: string;
  kind: "acp" | "messages";
}

const SEEN = `seen-v${CLASSIFIER_VERSION}.json`;
const CORRECTIONS_READ = "corrections-read.json";
const KINDS = `kinds-v${CLASSIFIER_VERSION}.json`;

/** The kinds the aliases were last looked for among, and the aliases found then. */
interface KindNames {
  reviewed: string[];
  aliases: Record<string, string>;
}

/** Sessions older than this are not read; what they would teach has been learned or no longer applies. */
const RECENT_MS = 30 * 24 * 60 * 60_000;

/** Every session log the loop may learn from: each chopin project's exported transcripts, and the configured logs. */
export async function sessionSources(chopinHome: string, logDirectories: readonly string[], now = Date.now()): Promise<Source[]> {
  const projects = join(chopinHome, "projects");
  const exported = (await names(projects)).map((project) => join(projects, project, "rsi", "transcripts"));
  const found = [
    ...(await Promise.all(exported.map((dir) => files(dir, "acp")))).flat(),
    ...(await Promise.all(logDirectories.map((dir) => files(dir, "messages")))).flat(),
  ];
  const dated = await Promise.all(found.map(async (source) => ({ source, at: (await stat(source.path)).mtimeMs })));
  // Newest first, so a pass cut short by the budget has learned from the latest work.
  return dated.filter(({ at }) => at > now - RECENT_MS).sort((a, b) => b.at - a.at).map(({ source }) => source);
}

/** A short digest of a criterion text, which keys the verdicts judged by it. */
export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** A user's correction found in a session, named as a failure of the agent step it answers, waiting for the user. */
export interface Correction extends CorrectionCandidate {
  session: string;
  /** The agent step it corrects. */
  step: number;
  signature: FailureSignature;
  /** The version of the rules it was named by. */
  classifier: number;
  confirmed?: boolean;
}

/** Corrections of one kind waiting for the user, and the distinct sessions they came from. */
export interface CorrectionKind {
  key: string;
  corrections: Correction[];
  sessions: string[];
}

/** What the loop has gathered: the failures found, the corrections proposed, and which logs it has read as they were. */
export class Evidence {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** The failures named by the current rules; ones named by earlier rules are kept but no longer counted. */
  async failures(): Promise<Failure[]> {
    return (await this.#lines<Failure>("failures.jsonl")).filter((failure) => failure.classifier === CLASSIFIER_VERSION);
  }

  async addFailure(failure: Failure): Promise<void> {
    await this.#append("failures.jsonl", failure);
  }

  /** Signals the current rules judged no failure, by session and line, so they are not asked about again. */
  async dismissed(): Promise<Set<string>> {
    return new Set((await this.#lines<{ at: string; classifier: number }>("dismissed.jsonl"))
      .filter((line) => line.classifier === CLASSIFIER_VERSION).map((line) => line.at));
  }

  async dismiss(session: string, line: number): Promise<void> {
    await this.#append("dismissed.jsonl", { at: `${session}:${line}`, classifier: CLASSIFIER_VERSION });
  }

  /** The kinds of failure, each under the name its other names are merged into. */
  async kinds(): Promise<FailureClass[]> {
    const { aliases } = await this.#kindNames();
    return groupFailures(await this.failures(), new Map(Object.entries(aliases)));
  }

  /** Looks for kinds that are other names for one mechanism again, once a kind not looked at before has come in. */
  async mergeKinds(complete: Complete): Promise<void> {
    const named = [...await this.failures(), ...await this.pendingCorrections()];
    const kinds = [...new Set(named.map((failure) => kindKey(failure.signature)))];
    const before = await this.#kindNames();
    if (kinds.every((kind) => before.reviewed.includes(kind))) return;
    const aliases = await kindAliases(kinds, complete, { reviewed: before.reviewed, aliases: new Map(Object.entries(before.aliases)) });
    const reviewed = [...new Set([...before.reviewed, ...kinds])];
    await this.#write(KINDS, { reviewed, aliases: Object.fromEntries(aliases) } satisfies KindNames);
  }

  corrections(): Promise<Correction[]> {
    return this.#lines<Correction>("corrections.jsonl");
  }

  async addCorrection(correction: Correction): Promise<void> {
    await this.#append("corrections.jsonl", correction);
  }

  /** Corrections named by the current rules that the user has not answered yet. */
  async pendingCorrections(): Promise<Correction[]> {
    const latest = new Map((await this.corrections()).map((correction) => [`${correction.session}:${correction.line}`, correction] as const));
    return [...latest.values()].filter((correction) => correction.confirmed === undefined && correction.classifier === CLASSIFIER_VERSION);
  }

  /** The pending corrections by kind, under the same names failures are merged into, the most sessions first. */
  async correctionKinds(): Promise<CorrectionKind[]> {
    const pending = await this.pendingCorrections();
    const byPoint = new Map(pending.map((correction) => [`${correction.session}:${correction.line}`, correction] as const));
    const { aliases } = await this.#kindNames();
    return groupFailures(pending, new Map(Object.entries(aliases))).map((found) => ({
      key: found.key, sessions: found.sessions, corrections: found.failures.map((failure) => byPoint.get(`${failure.session}:${failure.line}`)!),
    }));
  }

  /** Records the user's answer on a correction; the latest answer for a line wins. */
  async answerCorrection(correction: Correction, confirmed: boolean): Promise<void> {
    await this.#append("corrections.jsonl", { ...correction, confirmed });
  }

  /**
   * What the user said to correct each step they confirmed a correction of, by session and line: the strongest
   * evidence a failure has, and the criterion it is judged by.
   */
  async confirmedCorrections(): Promise<Map<string, string>> {
    const latest = new Map((await this.corrections()).map((correction) => [`${correction.session}:${correction.line}`, correction] as const));
    const byStep = new Map<string, string[]>();
    for (const correction of latest.values()) {
      if (correction.confirmed !== true) continue;
      const step = `${correction.session}:${correction.step}`;
      byStep.set(step, [...byStep.get(step) ?? [], correction.summary]);
    }
    return new Map([...byStep].map(([step, summaries]) => [step, summaries.join("; ")]));
  }

  /** The criteria a kind's failures are judged by, as a digest: empty when none was named by the user's correction. */
  async criteria(found: FailureClass): Promise<string> {
    const corrections = await this.confirmedCorrections();
    const named = found.failures.flatMap((failure) => corrections.get(`${failure.session}:${failure.line}`) ?? []).sort();
    return named.length === 0 ? "" : digest(named.join("\n"));
  }

  /** The user's answer on every correction of a kind; confirmed ones become failures at the steps they correct. */
  async answerKind(kind: CorrectionKind, confirmed: boolean): Promise<void> {
    for (const correction of kind.corrections) {
      await this.answerCorrection(correction, confirmed);
      if (confirmed) await this.addFailure({ session: correction.session, line: correction.step, signature: correction.signature, classifier: correction.classifier });
    }
  }

  /** Whether each failure recurred when the given layer version continued its session on `model`, by point. */
  async recurrence(version: number, model: string): Promise<Map<string, boolean>> {
    const lines = await this.#lines<{ point: string; version: number; model: string; recurred: boolean }>("recurrence.jsonl");
    return new Map(lines.filter((line) => line.version === version && line.model === model).map((line) => [line.point, line.recurred]));
  }

  async addRecurrence(point: string, version: number, model: string, recurred: boolean): Promise<void> {
    await this.#append("recurrence.jsonl", { point, version, model, recurred });
  }

  /** The kinds of failure a kept change answers, globally or in a project; a kind whose change was undone is open again. */
  async answered(): Promise<Set<string>> {
    const answered = new Set<string>();
    for (const line of await this.#lines<{ failure: string; reopened?: boolean }>("answered.jsonl")) {
      if (line.reopened === true) answered.delete(line.failure);
      else answered.add(line.failure);
    }
    return answered;
  }

  async addAnswered(failure: string): Promise<void> {
    await this.#append("answered.jsonl", { failure });
  }

  async reopen(failure: string): Promise<void> {
    await this.#append("answered.jsonl", { failure, reopened: true });
  }

  /** Which logs were read as they were, under the current rules; new rules read every log again. */
  seen(): Promise<Record<string, string>> {
    return this.#json(SEEN, {});
  }

  markSeen(seen: Record<string, string>): Promise<void> {
    return this.#write(SEEN, seen);
  }

  /** How many lines of each log were asked about corrections, which no change of rules asks about again. */
  correctionsRead(): Promise<Record<string, number>> {
    return this.#json(CORRECTIONS_READ, {});
  }

  markCorrectionsRead(read: Record<string, number>): Promise<void> {
    return this.#write(CORRECTIONS_READ, read);
  }

  #kindNames(): Promise<KindNames> {
    return this.#json(KINDS, { reviewed: [], aliases: {} });
  }

  /** A JSON file's value, or `fallback` until the file is written. */
  async #json<T>(file: string, fallback: T): Promise<T> {
    return readFile(join(this.root, file), "utf8").then((text) => JSON.parse(text) as T, () => fallback);
  }

  async #write(file: string, value: object): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeWhole(join(this.root, file), JSON.stringify(value), 0o600);
  }

  async #append(file: string, value: object): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await appendFile(join(this.root, file), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }

  async #lines<T>(file: string): Promise<T[]> {
    const text = await readFile(join(this.root, file), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as T);
  }
}

/** A session's entries as the loop reads them: converted to ACP when needed, and redacted. */
export async function readSession(source: Source, secrets: readonly string[]): Promise<TranscriptEntry[]> {
  const text = await readFile(source.path, "utf8");
  return redactTranscript(source.kind === "acp" ? parseTranscript(text) : fromMessagesJsonl(text), secrets);
}

/**
 * Reads every log that changed since it was last read: names each failure in it with the regular model, and asks it
 * which of the user's messages correct the agent, naming each as a failure too, so the user confirms them by kind. A
 * failure or correction already gathered is not asked about again.
 */
export async function harvest(
  evidence: Evidence,
  sources: readonly Source[],
  complete: Complete,
  secrets: readonly string[],
  onRead: (source: Source, found: { failures: number; corrections: number }) => void = () => {},
): Promise<{ read: number; failures: number; corrections: number }> {
  const seen = await evidence.seen();
  const correctionsRead = await evidence.correctionsRead();
  const failures = await evidence.failures();
  const known = new Map<string, { signature: FailureSignature; count: number }>();
  const count = (signature: FailureSignature) => {
    const key = signatureKey(signature);
    known.set(key, { signature, count: (known.get(key)?.count ?? 0) + 1 });
  };
  for (const failure of failures) count(failure.signature);
  const common = () => [...known.values()].sort((a, b) => b.count - a.count).map(({ signature }) => signature);
  const had = new Set([...failures.map((failure) => `${failure.session}:${failure.line}`), ...await evidence.dismissed()]);
  const asked = new Set((await evidence.corrections()).map((correction) => `${correction.session}:${correction.line}`));
  const found = { read: 0, failures: 0, corrections: 0 };
  for (const source of sources) {
    const info = await stat(source.path);
    const stamp = `${info.mtimeMs}:${info.size}`;
    if (seen[source.path] === stamp) continue;
    const entries = await readSession(source, secrets);
    const from = correctionsRead[source.path] ?? 0;
    const start = { failures: found.failures, corrections: found.corrections };
    // A log counts as read only once every signal in it got an answer, so an unreadable reply is asked again.
    let answeredAll = true;
    for (const signal of signals(entries)) {
      const line = failureStep(entries, signal) ?? signal.line;
      if (had.has(`${source.path}:${line}`)) continue;
      const signature = await classify(entries, signal, common(), complete, source.kind === "messages");
      if (signature === undefined) {
        answeredAll = false;
        continue;
      }
      had.add(`${source.path}:${line}`);
      if (signature === "not_a_failure") {
        await evidence.dismiss(source.path, line);
        continue;
      }
      count(signature);
      await evidence.addFailure({ session: source.path, line, signature, classifier: CLASSIFIER_VERSION });
      found.failures += 1;
    }
    for (const candidate of await proposeCorrections(entries, complete, from)) {
      if (asked.has(`${source.path}:${candidate.line}`)) continue;
      asked.add(`${source.path}:${candidate.line}`);
      // Named on its own; merging joins it to a failure's kind only when the mechanism is the same.
      const signal = { kind: "corrected", line: candidate.line, summary: candidate.summary } as const;
      const signature = await classify(entries, signal, [], complete, source.kind === "messages");
      if (signature === undefined || signature === "not_a_failure") continue;
      count(signature);
      const step = correctedStep(entries, candidate.line) ?? candidate.line;
      await evidence.addCorrection({ ...candidate, session: source.path, step, signature, classifier: CLASSIFIER_VERSION });
      found.corrections += 1;
    }
    correctionsRead[source.path] = entries.length;
    await evidence.markCorrectionsRead(correctionsRead);
    if (answeredAll) seen[source.path] = stamp;
    await evidence.markSeen(seen);
    found.read += 1;
    onRead(source, { failures: found.failures - start.failures, corrections: found.corrections - start.corrections });
  }
  await evidence.mergeKinds(complete);
  return found;
}

async function names(dir: string): Promise<string[]> {
  return readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

async function files(dir: string, kind: Source["kind"]): Promise<Source[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => ({ path: join(entry.parentPath, entry.name), kind }));
}
