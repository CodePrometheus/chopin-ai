/** What an admission leaves behind for the user: what was compared, how much, and how strong the evidence was. */
export interface Certificate {
  candidate: string;
  kind: "instruction" | "skill";
  scope: { kind: "global" } | { kind: "project"; project: string };
  /** The version it was compared against. */
  incumbent: number;
  pairs: number;
  evidence: number;
  level: number;
  kept: boolean;
  /** Decision points where, over all their pairs, it did better than the incumbent, and the reverse. */
  fixed: string[];
  broken: string[];
  /** In how many of its continuations the change was used, as a skill read. */
  used: number;
  /** Refused for mending none of the failures it was first tried on, before the test proper. */
  screenedOut: boolean;
  /** The pairs at failures, and in how many of them each version made the failure again. */
  atFailures: { pairs: number; incumbentRepeated: number; candidateRepeated: number };
  prediction: string;
  model: string;
  harness: string;
  at: string;
}
