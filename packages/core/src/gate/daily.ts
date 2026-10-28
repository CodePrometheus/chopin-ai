import type { FailureSignature } from "../evidence/classify.js";
import type { EquivalenceVerdict, RepeatVerdict } from "../judge/continuation.js";
import type { Certificate } from "./admission.js";
import type { AdmissionLedger } from "./ledger.js";
import { PairedComparison } from "./sequential.js";

/**
 * How many pairs at failures a candidate is first tried on alone. One that mends none of them is refused there: it
 * claims to mend that failure, and stopping a test early only ever keeps less.
 */
export const SCREEN_PAIRS = 6;

/** How many continuations a kind's failures are tried with for whether they recur, and how many repeats are enough. */
export const RECURRENCE = { tries: 8, enough: 3 } as const;

/**
 * How many distinct decision points where the agent failed a change must mend to be kept. More draws at one point
 * show only that the agent follows the change there, not that it carries over to another time the failure happened.
 */
export const MENDED_POINTS = 2;

/**
 * The smallest mean gain per pair worth testing on for: a change shown to fall short of it is refused there. Set
 * higher, it would stop sooner but begin to refuse changes that mend about four failures in ten.
 */
export const SMALLEST_GAIN = 0.2;

/** A decision point where the agent once failed. */
export interface FixPoint {
  id: string;
  context: string;
  failure: FailureSignature;
  /** What the user said to correct the step taken there, when the failure is known from that. */
  correction?: string;
}

/** A decision point where the agent went right, and the step it took there. */
export interface ProtectPoint {
  id: string;
  context: string;
  original: string;
}

/** Which version continues: the candidate or the incumbent. */
export type Arm = "candidate" | "incumbent";

/** One continued step, and whether it used the change under test. */
export interface Continued {
  step: string;
  used: boolean;
}

export interface DailyAdmission {
  candidate: string;
  kind: Certificate["kind"];
  scope: Certificate["scope"];
  incumbent: number;
  fixPoints: readonly FixPoint[];
  protectPoints: readonly ProtectPoint[];
  /** `undefined` when the point could not be continued, which leaves it out of the test. */
  continueAt: (arm: Arm, point: FixPoint | ProtectPoint) => Promise<Continued | undefined>;
  judgeRepeat: (point: FixPoint, step: string) => Promise<RepeatVerdict | undefined>;
  judgeEquivalent: (point: ProtectPoint, step: string) => Promise<EquivalenceVerdict | undefined>;
  ledger: AdmissionLedger;
  /** The most pairs the comparison may take. */
  limit: number;
  /** Whether the change must be seen in use before it is kept, as a skill must be read. */
  mustBeUsed: boolean;
  prediction: string;
  model: string;
  random?: () => number;
}

/**
 * Whether the failures recur at least at the rate of `enough` in `tries`, at which a screen of `SCREEN_PAIRS` pairs
 * almost always sees the incumbent make the failure; below it a screen mostly sees nothing a change could mend.
 */
export function recursOften(found: { repeats: number; tried: number }): boolean {
  return found.tried > 0 && found.repeats * RECURRENCE.tries >= RECURRENCE.enough * found.tried;
}

/**
 * The failures that recur when the incumbent continues their sessions: each point is continued in turn, and again
 * once all have been, until `tries` continuations are told or `enough` repeat, so a kind with few failures is
 * measured as fully as one with many. `recurs` gives `undefined` for a continuation it could not tell, which is not
 * counted. A change can be shown to mend a failure only where it still happens; the continuations that found it
 * serve no other purpose, so the test's own stay unbiased.
 */
export async function recurringPoints(
  points: readonly FixPoint[],
  recurs: (point: FixPoint, draw: number) => Promise<boolean | undefined>,
): Promise<{ recurring: FixPoint[]; repeats: number; tried: number }> {
  const recurring = new Set<FixPoint>();
  let repeats = 0;
  let tried = 0;
  const done = () => tried === RECURRENCE.tries || repeats === RECURRENCE.enough;
  for (let draw = 0; points.length > 0 && !done(); draw += 1) {
    const before = tried;
    for (const point of points) {
      if (done()) break;
      const recurred = await recurs(point, draw);
      if (recurred === undefined) continue;
      tried += 1;
      if (recurred) {
        repeats += 1;
        recurring.add(point);
      }
    }
    if (tried === before) break;
  }
  return { recurring: [...recurring], repeats, tried };
}

/**
 * Decides on a candidate from continued decision points: one paired, one-sided test of its net effect. After the
 * first pairs, all at failures, pairs come in turn from where the agent once failed (scored on not repeating the
 * failure) and from where it went right (scored on doing as well), so a fix that breaks other things does not pass.
 * The outcome goes in the ledger at the level it set, and the certificate says what was compared and how it came out.
 */
export async function admitDaily(input: DailyAdmission): Promise<Certificate> {
  const random = input.random ?? Math.random;
  const level = await input.ledger.nextLevel();
  const test = new PairedComparison({ margin: 0, futilityMargin: SMALLEST_GAIN, alpha: level, limit: input.limit });
  // A point is mended, or broken, by its net effect over all its pairs, not by one draw that went either way.
  const net = new Map<string, number>();
  const mended = () => [...net].filter(([, sum]) => sum > 0).map(([id]) => id);
  let used = 0;
  const pick = <T>(points: readonly T[]) => points[Math.floor(random() * points.length)]!;
  const fixPool: FixPoint[] = [...input.fixPoints];
  const pools: (FixPoint | ProtectPoint)[][] = [fixPool, [...input.protectPoints]];

  let screened = 0;
  let screenedOut = false;
  const atFailures = { pairs: 0, incumbentRepeated: 0, candidateRepeated: 0 };
  for (let round = 0; test.standing === "continue" && round < input.limit * 2; round += 1) {
    const live = pools.filter((pool) => pool.length > 0);
    const screening = screened < SCREEN_PAIRS && input.fixPoints.length > 0;
    // A screen needs failures to continue; with none left, nothing can be shown mended.
    if (live.length === 0 || (screening && fixPool.length === 0)) break;
    const point = screening ? pick(fixPool) : pick(live[round % live.length]!);
    const [mine, theirs] = await Promise.all([input.continueAt("candidate", point), input.continueAt("incumbent", point)]);
    if (mine === undefined || theirs === undefined) {
      const pool = pools.find((candidates) => candidates.includes(point))!;
      pool.splice(pool.indexOf(point), 1);
      continue;
    }
    if (mine.used) used += 1;
    let difference: number | undefined;
    if ("failure" in point) {
      const verdicts = await Promise.all([
        input.judgeRepeat(point, theirs.step),
        input.judgeRepeat(point, mine.step),
      ]);
      difference = scored(verdicts, "repeats");
      if (difference !== undefined) {
        atFailures.pairs += 1;
        atFailures.incumbentRepeated += Number(verdicts[0] === "repeats");
        atFailures.candidateRepeated += Number(verdicts[1] === "repeats");
      }
    } else {
      difference = scored(await Promise.all([
        input.judgeEquivalent(point, mine.step),
        input.judgeEquivalent(point, theirs.step),
      ]), "as_good");
    }
    if (difference === undefined) continue;
    test.add(difference);
    net.set(point.id, (net.get(point.id) ?? 0) + difference);
    if (screening && (screened += 1) === SCREEN_PAIRS && mended().length === 0) {
      screenedOut = true;
      break;
    }
  }

  const failures = new Set(input.fixPoints.map((point) => point.id));
  const fixed = mended();
  const broken = [...net].filter(([, sum]) => sum < 0).map(([id]) => id);
  const passed = test.standing === "accept" && fixed.filter((id) => failures.has(id)).length >= MENDED_POINTS && !(input.mustBeUsed && used === 0);
  // Every test is recorded, kept or not, so the levels of later ones stay valid.
  const { kept } = await input.ledger.record(input.candidate, passed ? test.evidence : Math.min(test.evidence, 1));
  return {
    candidate: input.candidate, kind: input.kind, scope: input.scope, incumbent: input.incumbent, pairs: test.for.count,
    evidence: test.evidence, level, kept, fixed, broken, used, screenedOut, atFailures, prediction: input.prediction,
    model: input.model, harness: "pi", at: new Date().toISOString(),
  };
}

/** The pair as a difference in [-1, 1]: 1 when only the first verdict is `hit`, -1 when only the second is. */
function scored<V>([first, second]: readonly [V | undefined, V | undefined], hit: V): number | undefined {
  return first === undefined || second === undefined ? undefined : Number(first === hit) - Number(second === hit);
}
