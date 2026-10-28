import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Proposal } from "@chopin-ai/core";

/** A proposal the audit could not settle, held for the user, and what the user decided on it. */
export interface HeldProposal {
  id: string;
  /** The kind of failure it answers. */
  failure: string;
  proposal: Proposal;
  /** Why the audit asked for a person. */
  reasons: string[];
  decision?: "approved" | "refused" | "tested";
  at: string;
}

/**
 * Proposals held for the user as JSON Lines, the latest line for a proposal winning. An approved one replaces the
 * audit only: it still goes through the gate in a later round, and is marked tested once it has.
 */
export class HeldProposals {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Every proposal in its latest state. */
  async all(): Promise<HeldProposal[]> {
    const text = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const latest = new Map<string, HeldProposal>();
    for (const line of text.split("\n").filter((line) => line !== "")) {
      const held = JSON.parse(line) as HeldProposal;
      latest.set(held.id, held);
    }
    return [...latest.values()];
  }

  /** Proposals waiting for the user. */
  async waiting(): Promise<HeldProposal[]> {
    return (await this.all()).filter((held) => held.decision === undefined);
  }

  /** The approved proposal for a kind of failure that no round has tested yet. */
  async approved(failure: string): Promise<HeldProposal | undefined> {
    return (await this.all()).find((held) => held.failure === failure && held.decision === "approved");
  }

  async hold(held: Omit<HeldProposal, "at" | "decision">): Promise<void> {
    await this.#append({ ...held, at: new Date().toISOString() });
  }

  async decide(held: HeldProposal, decision: NonNullable<HeldProposal["decision"]>): Promise<void> {
    await this.#append({ ...held, decision, at: new Date().toISOString() });
  }

  async #append(held: HeldProposal): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await appendFile(this.path, `${JSON.stringify(held)}\n`, { mode: 0o600 });
  }
}
