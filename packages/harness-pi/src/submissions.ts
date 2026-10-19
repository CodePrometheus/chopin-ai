import type { ConversationView } from "@earendil-works/pi-durable";
import type { Static } from "typebox";
import { detailText, runInputs } from "./acp.js";
import type { SubmissionSchema } from "./protocol.js";

/** How a submission stands, as clients see it. */
export type Outcome = Static<typeof SubmissionSchema>;

/** How many settled submissions clients keep learning of; running ones are always kept. */
export const RECENT_SUBMISSIONS = 16;

/** A submission as clients see it: running until it settles, then answered or not, and why. */
export function outcomeOf(record: { status: string; reason?: string; detail?: unknown }): Outcome {
  if (record.status === "done") return { status: "done" };
  if (record.status !== "unanswered") return { status: "pending" };
  const detail = detailText(record.detail);
  return { status: "unanswered", reason: record.reason ?? "unknown", ...(detail !== undefined && { detail }) };
}

/** A submission nobody can say more about, for want of a store to read. */
export function lost(detail: string): Outcome {
  return { status: "unanswered", reason: "lost", detail };
}

/**
 * Folds what the store says into what clients have, keeping every running submission, the latest settled ones, and
 * whatever this read reported, so a client waiting on an old one sees how it ended before it goes.
 */
export function merge(draft: Record<string, Outcome>, known: Readonly<Record<string, Outcome>>): void {
  Object.assign(draft, known);
  const settled = Object.keys(draft).filter((id) => draft[id]?.status !== "pending").map(Number).sort((a, b) => b - a);
  for (const id of settled.slice(RECENT_SUBMISSIONS)) if (!(String(id) in known)) delete draft[String(id)];
}

/** What changes when a submission may have ended: which entries are there, and which inputs the run serves. */
export function progressOf(view: ConversationView): string {
  const { entries } = view;
  return `${entries.length}:${entries[0]?.id ?? ""}:${entries.at(-1)?.id ?? ""}:${runInputs(view).join(",")}`;
}
