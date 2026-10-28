import type { TranscriptEntry } from "../transcript.js";
import { isUserWritten } from "./points.js";
import type { Signal } from "./signals.js";

/** Asks a model for a reply to one prompt; the caller picks the model and pays for it. */
export type Complete = (prompt: string) => Promise<string>;

/** Why the failure happened. */
export const CAUSES = [
  "tool_error", "wrong_command", "skipped_verification", "misread_request", "missing_context", "environment",
  "user_preference", "gave_up_early", "other",
] as const;

/** What the agent did that led to it. */
export const BEHAVIORS = ["read", "edit", "run_command", "answer", "plan", "ask", "other"] as const;

/** A failure written as three fields; two failures are the same kind only when all three are equal. */
export interface FailureSignature {
  cause: (typeof CAUSES)[number];
  behavior: (typeof BEHAVIORS)[number];
  /** A short kebab-case name for the mechanism, such as `stops-at-truncated-output`. */
  mechanism: string;
}

const MECHANISM = /^[a-z0-9]+(-[a-z0-9]+){0,7}$/;

/**
 * What the model is shown of a session: lines before the failure, and after it up to the user's next message, which
 * tell a failure the agent had to recover from apart from a result it used; each line cut to a length.
 */
const BEFORE = 20;
const AFTER = 8;
const ENTRY_CHARS = 1500;

/** How many named failures are offered, the most common first, so the prompt does not grow with the catalog. */
const KNOWN_SHOWN = 30;

/**
 * The rules failures are named by; a failure is counted only with failures named under the same rules, so changing
 * them starts the count afresh instead of mixing two ways of naming.
 */
export const CLASSIFIER_VERSION = 3;

/** What a model makes of a signal: a named failure, or not a failure at all, such as a search that found nothing. */
export type Classified = FailureSignature | "not_a_failure";

/**
 * The signature of the failure `signal` marks in `entries`. Signatures already seen, the most common first, are
 * offered whole, so one kind of failure keeps one name; a reply that does not fit gives `undefined` rather than a
 * guess. A session of another agent, `foreign`, may hold refusals by its host's own rules, which are not the agent's.
 */
export async function classify(
  entries: readonly TranscriptEntry[],
  signal: Signal,
  known: readonly FailureSignature[],
  complete: Complete,
  foreign = false,
): Promise<Classified | undefined> {
  const next = entries.findIndex((entry, line) => line > signal.line && isUserWritten(entry));
  const end = Math.min(next === -1 ? entries.length : next + 1, signal.line + 1 + AFTER);
  const window = entries.slice(Math.max(0, signal.line - BEFORE), end);
  const reply = await complete(prompt(window, signal.line - Math.max(0, signal.line - BEFORE), signal, known.slice(0, KNOWN_SHOWN), foreign));
  return parseSignature(reply);
}

export function parseSignature(reply: string): Classified | undefined {
  const json = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
  let value: { failure?: unknown; cause?: unknown; behavior?: unknown; mechanism?: unknown };
  try {
    value = JSON.parse(json) as typeof value;
  } catch {
    return undefined;
  }
  if (value.failure === false) return "not_a_failure";
  const { cause, behavior, mechanism } = value;
  if (!CAUSES.includes(cause as never) || !BEHAVIORS.includes(behavior as never)) return undefined;
  if (typeof mechanism !== "string" || !MECHANISM.test(mechanism)) return undefined;
  return { cause, behavior, mechanism } as FailureSignature;
}

/** The key failures of one kind share. */
export function signatureKey(signature: FailureSignature): string {
  return `${signature.cause}/${signature.behavior}/${signature.mechanism}`;
}

function prompt(window: readonly TranscriptEntry[], at: number, signal: Signal, known: readonly FailureSignature[], foreign: boolean): string {
  return [
    "An agent's session may have gone wrong at the line marked >>> below. If it did, name the failure with three",
    "fields, as one JSON object.",
    `- cause: one of ${CAUSES.join(", ")}`,
    `- behavior: what the agent did that led to it, one of ${BEHAVIORS.join(", ")}`,
    "- mechanism: a kebab-case name for how it failed, of at most 8 words, general enough to recur in other sessions",
    ...(known.length === 0 ? [] : [
      "When it is the same failure as one already named, reply with that one exactly, all three fields as they are;",
      "name a new one when they only sound alike:",
      ...known.map((signature) => JSON.stringify(signature)),
    ]),
    'Reply {"failure":false} when it is no failure of the agent\'s own making:',
    "- the agent got what it needed and carried on, as the lines after it show, such as when a search rightly found",
    "  nothing or one part of a longer command exited non-zero",
    "- the outside world failed, such as the network or a service, and no other step would have fared better",
    ...(foreign ? [
      "- the agent's host refused it by a rule of its own, such as a blocked command, a permission check or a sandbox",
      "  limit; this session comes from another agent, and its host's rules are not this agent's",
    ] : []),
    `The signal: ${JSON.stringify(signal)}`,
    "The session around it, one ACP entry per line:",
    ...window.map((entry, line) => {
      const text = JSON.stringify(entry);
      return `${line === at ? ">>> " : ""}${text.length <= ENTRY_CHARS ? text : `${text.slice(0, ENTRY_CHARS)}…`}`;
    }),
    'Reply with only the JSON object, such as {"cause":"…","behavior":"…","mechanism":"…"} or {"failure":false}.',
  ].join("\n");
}
