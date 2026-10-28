import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LayerVersions, Rejections, TRIGGER_SESSIONS } from "@chopin-ai/core";
import { readSettings, rsiDirectory, writeWhole } from "../home.js";
import { Evidence } from "./harvest.js";
import { HeldProposals } from "./held.js";
import { Budget } from "./models.js";

/**
 * One line on what the loop did since it was last shown: changes kept, kinds of correction and changes waiting for
 * the user, kinds of failure set aside, and the week's spending. Undefined when none of the first four has anything new.
 */
export async function loopSummary(now = Date.now()): Promise<string | undefined> {
  const root = rsiDirectory();
  const markFile = join(root, "shown.json");
  const shown = await readFile(markFile, "utf8").then((text) => JSON.parse(text) as { at: number }, () => ({ at: 0 }));
  const versions = new LayerVersions(join(root, "layer"));
  const kept = (await versions.items(await versions.current())).filter((item) => !item.archived && Date.parse(item.added) > shown.at).length;
  const evidence = new Evidence(join(root, "evidence"));
  const waiting = (await evidence.correctionKinds()).filter((kind) => kind.sessions.length >= TRIGGER_SESSIONS).length;
  const rejections = new Rejections(join(root, "rejections.jsonl"));
  const settings = await readSettings();
  let shelved = 0;
  for (const found of await evidence.kinds()) if (await rejections.shelved(found.key, settings.model ?? "", found.failures.length, await evidence.criteria(found))) shelved += 1;
  const held = (await new HeldProposals(join(root, "held.jsonl")).waiting()).length;
  if (kept === 0 && waiting === 0 && held === 0 && shelved === 0) return undefined;
  const weekly = settings.rsi?.weeklyBudgetUsd;
  const spent = await new Budget(join(root, "spend.jsonl"), weekly ?? 0).spent(now);
  await writeWhole(markFile, JSON.stringify({ at: now }), 0o600);
  const parts = [
    ...(kept > 0 ? [`kept ${kept} change${kept === 1 ? "" : "s"} since last time`] : []),
    ...(waiting > 0 ? [`${waiting} kind${waiting === 1 ? "" : "s"} of correction to confirm (chopin evolve corrections)`] : []),
    ...(held > 0 ? [`${held} change${held === 1 ? "" : "s"} held for your review (chopin evolve review)`] : []),
    ...(shelved > 0 ? [`${shelved} kind${shelved === 1 ? "" : "s"} of failure set aside`] : []),
    `$${spent.toFixed(2)}${weekly === undefined ? "" : ` of $${weekly.toFixed(2)}`} spent this week`,
  ];
  return `RSI: ${parts.join(" · ")}`;
}
