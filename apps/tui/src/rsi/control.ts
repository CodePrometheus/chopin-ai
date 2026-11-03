import { TRIGGER_SESSIONS, triggered, type LayerItem } from "@chopin-ai/core";
import type { CorrectionKind, HeldChange, LoopChange, LoopControl, LoopSettings, LoopStanding } from "@chopin-ai/harness-pi/protocol";
import { changeSettings, readSettings, type RsiSettings } from "../home.js";
import { Budget } from "./models.js";
import { records } from "./records.js";

/** How many of a kind's corrections the user is shown when asked about it. */
const CORRECTION_EXAMPLES = 3;

/** Where the loop stands: the layer version in use, the failures it knows, what waits for the user, what it spent. */
export async function loopStanding(): Promise<LoopStanding> {
  const kept = records();
  const version = await kept.versions.current();
  const items = await kept.versions.items(version);
  const kinds = await kept.evidence.kinds();
  const settings = await readSettings();
  let shelved = 0;
  for (const found of kinds) if (await kept.rejections.shelved(found.key, settings.model ?? "", found.failures.length, await kept.evidence.criteria(found))) shelved += 1;
  const corrections = (await kept.evidence.correctionKinds()).filter((kind) => kind.sessions.length >= TRIGGER_SESSIONS).length;
  const weeklyBudgetUsd = settings.rsi?.weeklyBudgetUsd ?? null;
  return {
    version,
    inUse: items.filter((item) => !item.archived).length,
    archived: items.filter((item) => item.archived).length,
    kinds: kinds.length,
    recurring: triggered(kinds).length,
    shelved,
    corrections,
    held: (await kept.held.waiting()).length,
    spentUsd: await new Budget(kept.spend, weeklyBudgetUsd ?? 0).spent(),
    weeklyBudgetUsd,
  };
}

/** The changes the loop kept, newest first. */
export async function loopChanges(): Promise<LoopChange[]> {
  const kept = records();
  return (await kept.versions.items(await kept.versions.current())).toReversed()
    .map((item) => ({ id: item.id, added: item.added, kind: item.kind, archived: item.archived, text: item.text ?? `skill ${item.skill}` }));
}

/**
 * Archives the change in use whose id `id` begins, so new conversations run without it; else why it cannot be. The
 * failure it answered is taken up again, and its proposer is told this change was undone.
 */
export async function undoChange(id: string): Promise<{ undone: LayerItem; version: number } | string> {
  const kept = records();
  const matches = (await kept.versions.items(await kept.versions.current())).filter((item) => item.id.startsWith(id) && !item.archived);
  const [undone] = matches;
  if (undone === undefined) return `no change in use starts with ${id}`;
  if (matches.length > 1) return `${id} names more than one change; give more of it`;
  const version = await kept.versions.commit((all) => all.map((item) => (item.id === undone.id ? { ...item, archived: true } : item)));
  if (undone.source.failure !== undefined) {
    await kept.rejections.record({
      failure: undone.source.failure, candidate: undone.id, text: undone.text ?? `the skill ${undone.skill}`, reason: "the user undid it after it was kept",
    });
    await kept.evidence.reopen(undone.source.failure);
  }
  return { undone, version };
}

/** The kinds of correction the user is asked about, those found in enough sessions, and how many corrections wait for more. */
export async function correctionsAsked(): Promise<{ asking: CorrectionKind[]; later: number }> {
  const kinds = await records().evidence.correctionKinds();
  const asking = kinds.filter((kind) => kind.sessions.length >= TRIGGER_SESSIONS);
  return {
    asking: asking.map((kind) => ({
      key: kind.key, sessions: kind.sessions.length, examples: kind.corrections.slice(0, CORRECTION_EXAMPLES).map((correction) => correction.summary),
    })),
    later: kinds.filter((kind) => !asking.includes(kind)).reduce((sum, kind) => sum + kind.corrections.length, 0),
  };
}

/** Learns from every correction of the kind `key`, or dismisses them all; else why it cannot. */
export async function answerCorrections(key: string, learn: boolean): Promise<string | undefined> {
  const evidence = records().evidence;
  const kind = (await evidence.correctionKinds()).find((each) => each.key === key && each.sessions.length >= TRIGGER_SESSIONS);
  if (kind === undefined) return `no kind of correction ${key} waits for an answer`;
  await evidence.answerKind(kind, learn);
  return undefined;
}

/** The changes the audit held for the user, waiting for a decision. */
export async function heldChanges(): Promise<HeldChange[]> {
  return (await records().held.waiting()).map(({ id, failure, proposal, reasons }) => ({
    id, failure, kind: proposal.candidate.kind, ...(proposal.skill !== undefined && { skill: proposal.skill }),
    text: proposal.candidate.text, prediction: proposal.prediction, reasons,
  }));
}

/**
 * Approves a held change, which the next round still tests before keeping it, or refuses it, which counts against
 * its kind; else why it cannot.
 */
export async function decideHeld(id: string, approve: boolean): Promise<string | undefined> {
  const kept = records();
  const held = (await kept.held.waiting()).find((each) => each.id === id);
  if (held === undefined) return `no change ${id} waits for your review`;
  await kept.held.decide(held, approve ? "approved" : "refused");
  if (!approve) {
    const { candidate, prediction } = held.proposal;
    await kept.rejections.record({ failure: held.failure, candidate: held.id, text: candidate.text, reason: "you refused it on review", prediction });
  }
  return undefined;
}

/** How the loop runs, as the settings have it. */
export async function loopSettings(): Promise<LoopSettings> {
  const rsi = (await readSettings()).rsi ?? {};
  return {
    weeklyBudgetUsd: rsi.weeklyBudgetUsd ?? null,
    regularModel: rsi.regularModel ?? null,
    strongModel: rsi.strongModel ?? null,
    holdForReview: rsi.holdForReview === true,
  };
}

/** Changes the loop settings given, a null clearing one, leaving the rest; answers with all of them. */
export async function changeLoopSettings(change: Partial<LoopSettings>): Promise<LoopSettings> {
  await changeSettings((current) => {
    const rsi: Record<string, unknown> = { ...current.rsi };
    for (const [key, value] of Object.entries(change)) {
      if (value === null) delete rsi[key];
      else if (value !== undefined) rsi[key] = value;
    }
    return { rsi: rsi as RsiSettings };
  });
  return loopSettings();
}

/** The loop as a service answers its owner's clients from it. */
export const loopControl: LoopControl = {
  standing: loopStanding,
  changes: loopChanges,
  undo: async (id) => {
    const undone = await undoChange(id);
    return typeof undone === "string" ? undone : undefined;
  },
  corrections: async () => (await correctionsAsked()).asking,
  answer: answerCorrections,
  held: heldChanges,
  decide: decideHeld,
  settings: loopSettings,
  setSettings: changeLoopSettings,
};
