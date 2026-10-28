import { signatureKey, type Complete, type FailureSignature } from "./classify.js";

/** One failure in one session, with its signature. */
export interface Failure {
  session: string;
  /** The transcript line where it happened. */
  line: number;
  signature: FailureSignature;
  /** The version of the rules it was named by. */
  classifier?: number;
}

/** Failures of one kind, and the distinct sessions they came from. */
export interface FailureClass {
  key: string;
  /** The signature most of its failures were named with. */
  signature: FailureSignature;
  failures: Failure[];
  sessions: string[];
}

/** How many distinct sessions a kind of failure must appear in before it starts a round. */
export const TRIGGER_SESSIONS = 2;

/**
 * The key failures of one kind share: what the agent did and how it failed. The cause is a judgement that differs
 * between sessions for the same mechanism, so it describes a kind without splitting it.
 */
export function kindKey(signature: FailureSignature): string {
  return `${signature.behavior}/${signature.mechanism}`;
}

/**
 * Failures grouped by kind, the kinds seen in the most sessions first. `aliases` maps a kind's key to the key of the
 * kind it is another name for, whose name the merged kind carries.
 */
export function groupFailures(failures: readonly Failure[], aliases: ReadonlyMap<string, string> = new Map()): FailureClass[] {
  const classes = new Map<string, FailureClass>();
  for (const failure of failures) {
    const own = kindKey(failure.signature);
    const key = aliases.get(own) ?? own;
    const found = classes.get(key) ?? { key, signature: failure.signature, failures: [], sessions: [] };
    found.failures.push(failure);
    if (!found.sessions.includes(failure.session)) found.sessions.push(failure.session);
    classes.set(key, found);
  }
  for (const found of classes.values()) {
    const signature = mostCommon(found.failures.map((failure) => failure.signature));
    found.signature = { ...signature, mechanism: found.key.slice(found.key.indexOf("/") + 1) };
  }
  return [...classes.values()].sort((a, b) => b.sessions.length - a.sessions.length);
}

/** The kinds looked at for other names before, and the aliases found among them. */
export interface KindNaming {
  reviewed: readonly string[];
  aliases: ReadonlyMap<string, string>;
}

/**
 * Which kinds are other names for one mechanism. Each behavior with a kind not looked at before is asked about once,
 * with every name given within it; a new kind joins the kind of an earlier name it is grouped with, or else the first
 * new name of its group, while kinds looked at before keep the names they were given, so grouping only ever settles.
 * A reply naming a kind that is not there, or one kind twice, is not taken.
 */
export async function kindAliases(
  kinds: readonly string[],
  complete: Complete,
  before: KindNaming = { reviewed: [], aliases: new Map() },
): Promise<Map<string, string>> {
  const aliases = new Map(before.aliases);
  const reviewed = new Set(before.reviewed);
  for (const [behavior, keys] of Map.groupBy(kinds, (key) => key.slice(0, key.indexOf("/")))) {
    if (keys.length < 2 || keys.every((key) => reviewed.has(key))) continue;
    const names = keys.map((key) => key.slice(behavior.length + 1));
    const reply = await complete([
      `Below are names an agent's failures were given, all from the behavior "${behavior}". Group the names that name`,
      "the same mechanism in other words, so a fix for one is a fix for all; names that are only related stay apart.",
      'Reply with only a JSON array of groups, each with the name to keep first, such as [["a-b","a-b-c"]], or [] for',
      "none.",
      ...names,
    ].join("\n"));
    const seen = new Set<string>();
    for (const group of parseGroups(reply)) {
      if (group.length < 2 || group.some((name) => !names.includes(name) || seen.has(name))) continue;
      for (const name of group) seen.add(name);
      const members = group.map((name) => `${behavior}/${name}`);
      const anchor = members.find((key) => reviewed.has(key)) ?? members[0]!;
      const target = aliases.get(anchor) ?? anchor;
      for (const key of members) if (!reviewed.has(key) && key !== target) aliases.set(key, target);
    }
  }
  return aliases;
}

function parseGroups(reply: string): string[][] {
  try {
    const value: unknown = JSON.parse(reply.slice(reply.indexOf("["), reply.lastIndexOf("]") + 1));
    if (!Array.isArray(value)) return [];
    return value.filter((group): group is string[] => Array.isArray(group) && group.every((name) => typeof name === "string"));
  } catch {
    return [];
  }
}

function mostCommon(signatures: readonly FailureSignature[]): FailureSignature {
  const counts = new Map<string, { signature: FailureSignature; count: number }>();
  for (const signature of signatures) {
    const key = signatureKey(signature);
    counts.set(key, { signature, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  return [...counts.values()].reduce((best, next) => (next.count > best.count ? next : best)).signature;
}

/** The kinds of failure that have recurred often enough to start a round. */
export function triggered(classes: readonly FailureClass[], sessions = TRIGGER_SESSIONS): FailureClass[] {
  return classes.filter((found) => found.sessions.length >= sessions);
}
