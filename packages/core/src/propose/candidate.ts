import type { TextCandidate } from "../judge/audit.js";

/** A proposal as the proposer hands it in: one change to the layer's text, where it applies, and what it should do. */
export interface Proposal {
  candidate: TextCandidate;
  /** A skill's name, which is also its directory; only for a skill. */
  skill?: string;
  scope: "global" | "project";
  /** What the change should fix, and what it might break, said so it can be checked. */
  prediction: string;
}

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The proposal in a proposer's reply, a single JSON object; `undefined` when the reply is not exactly one well-formed
 * proposal, since a proposal that has to be guessed at is not tested.
 */
export function parseProposal(reply: string): Proposal | undefined {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const { kind, text, skill, scope, prediction, revises } = value;
  if (kind !== "instruction" && kind !== "skill") return undefined;
  if (typeof text !== "string" || text.trim() === "") return undefined;
  if (scope !== "global" && scope !== "project") return undefined;
  if (typeof prediction !== "string" || prediction.trim() === "") return undefined;
  if (revises !== undefined && revises !== null && typeof revises !== "string") return undefined;
  if (kind === "skill" && (typeof skill !== "string" || !SKILL_NAME.test(skill) || skill.length > 64)) return undefined;
  const candidate: TextCandidate = { kind, text, ...(typeof revises === "string" && { revises }) };
  return { candidate, ...(kind === "skill" && { skill: skill as string }), scope, prediction };
}
