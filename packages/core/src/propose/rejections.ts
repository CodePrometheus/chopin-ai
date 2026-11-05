import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readJsonLines } from "../json-file.js";
import { RECURRENCE } from "../gate/daily.js";

/** After this many refusals a kind of failure is set aside for the user. */
export const SHELVE_AFTER = 3;

/** A proposal that was refused: the kind of failure it answered, what it changed, and why it was refused. */
export interface Rejection {
  failure: string;
  candidate: string;
  text: string;
  reason: string;
  /** The prediction it made that did not hold, when one did not. */
  prediction?: string;
  /**
   * The model on which the failure did not recur, so no change could be shown to mend it there, how many failures of
   * the kind were known then, the criteria they were judged by, and how many continuations told it; more failures,
   * other criteria, or fewer continuations than a full measure are reason to look again.
   */
  notRecurring?: { model: string; failures: number; criteria?: string; tried?: number };
  at: string;
}

/** Refused proposals as JSON Lines, read back so the next proposal for the same failure sees what was tried. */
export class Rejections {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async record(rejection: Omit<Rejection, "at">): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify({ ...rejection, at: new Date().toISOString() })}\n`);
  }

  async for(failure: string): Promise<Rejection[]> {
    return (await readJsonLines(this.path) as Rejection[]).filter((rejection) => rejection.failure === failure);
  }

  /**
   * Whether the kind of failure, now with `failures` failures judged by `criteria`, is set aside on `model`: refused
   * often enough, or found not to recur there while it had as many, judged the same way.
   */
  async shelved(failure: string, model: string, failures: number, criteria = ""): Promise<boolean> {
    const refused = await this.for(failure);
    return refused.length >= SHELVE_AFTER || refused.some(({ notRecurring }) =>
      notRecurring?.model === model && failures <= notRecurring.failures && (notRecurring.criteria ?? "") === criteria
      && (notRecurring.tried ?? 0) >= RECURRENCE.tries);
  }
}
