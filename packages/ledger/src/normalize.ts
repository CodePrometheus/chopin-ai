/**
 * Error string normalization.
 *
 * The normalized result is the defect's stable identity: the same underlying error must
 * map to the same key across users, sessions and releases, even when the raw text embeds
 * volatile fragments (ids, timestamps, paths, numbers). Normalization is purely
 * deterministic and irreversible: the raw string is always kept alongside, never reconstructed.
 */

export interface NormalizedError {
  /** Stable match key derived from the raw text. */
  key: string;
  /** The raw text as observed. */
  raw: string;
}

const REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  // ISO timestamps go first: they contain digits/hex and would be eaten by the other rules.
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>"],
  [/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "<uuid>"],
  // Long hex strings: object ids, hashes, pointers.
  [/\b[0-9a-fA-F]{12,}\b/g, "<hex>"],
  // Absolute paths (POSIX and Windows). Home directory paths carry the user name.
  [/(?:[A-Za-z]:)?(?:[\\/][\w.~-]+){2,}/g, "<path>"],
  // Digit runs: ports, counts, sizes, durations. No word boundary required: numbers often
  // sit against a unit (30000ms, 512kb) and \b would miss them; consistent replacement keeps the key stable.
  [/\d+(?:\.\d+)?/g, "<n>"],
];

export function normalizeErrorString(raw: string): NormalizedError {
  let key = raw.trim().replace(/\s+/g, " ");
  for (const [pattern, token] of REPLACEMENTS) {
    key = pattern.global ? key.replace(pattern, token) : key;
  }
  // Collapse runs of placeholders left by adjacent replacements, e.g. "<n> <n> <n>".
  key = key.replace(/(?:<(?:ts|uuid|hex|path|n)>\s*){2,}/g, (m) => {
    const first = m.match(/<[a-z]+>/);
    return first ? `${first[0]} ` : m;
  });
  return { key: key.trim(), raw };
}

/**
 * Version of the normalization rules. Bump it whenever the rules change: signatures change
 * with it, old clusters stop accumulating, and history is not recomputed. A rule change
 * only affects later observations.
 */
export const NORMALIZER_VERSION = 1;

export interface SignalKeyInput {
  /** Signal kind: gate-rejection / tool-failure. */
  kind: string;
  /** Name of the failing tool. */
  tool: string;
  /** Unmet rule ids on a gate rejection (joined with `+` when several); empty for a plain tool failure. */
  gate?: string;
  /** Raw error text, normalized internally. */
  error: string;
}

const KEY_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;
const CORRECTION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function segment(name: string, value: string): string {
  if (!KEY_SEGMENT.test(value)) throw new Error(`signal key ${name} is not a stable segment: ${value}`);
  return value;
}

/**
 * Failure signature: five segments (version, kind, tool, gate, normalized error string);
 * any differing segment is a different cluster. The gate segment keeps the same error
 * apart under different intents; the version segment keeps rule changes from polluting old clusters.
 */
export function buildSignalKey(input: SignalKeyInput): string {
  const gate = input.gate === undefined || input.gate === "" ? "-" : segment("gate", input.gate);
  return `sk${NORMALIZER_VERSION}:${segment("kind", input.kind)}:${segment("tool", input.tool)}:${gate}:${normalizeErrorString(input.error).key}`;
}

/** Signature of a user correction. The model picks the slug, the person sees it at approval, and the same slug clusters across sessions. */
export function correctionSignalKey(slug: string): string {
  if (!CORRECTION_SLUG.test(slug) || slug.length > 64) {
    throw new Error(`correction slug must be kebab-case with at most 64 characters: ${slug}`);
  }
  return `sk${NORMALIZER_VERSION}:user-correction:${slug}`;
}
