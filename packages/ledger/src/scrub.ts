/**
 * Scrubbing: wipe fragments that may be secrets before text enters the ledger, a candidate
 * or the model context.
 *
 * Err on the side of wiping: a false positive loses a few characters, while one miss sends
 * a secret into the context once more.
 *
 * @module @chopin/ledger/scrub
 */

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, "<anthropic-key>"],
  [/sk-[A-Za-z0-9]{20,}/g, "<api-key>"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "<github-token>"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "<github-token>"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "<aws-key>"],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<jwt>"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi, "Bearer <token>"],
  // Assignments like TOKEN=xxx / api_key: "xxx": the value is always wiped.
  [/\b([A-Za-z_]*(?:token|secret|password|passwd|api[_-]?key)[A-Za-z_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, "$1=<redacted>"],
];

/** Wipe fragments that may be secrets. */
export function scrub(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
