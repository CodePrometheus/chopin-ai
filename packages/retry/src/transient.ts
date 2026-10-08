/**
 * Decide whether a tool failure is of the "rerunning once usually fixes it" kind.
 *
 * The criterion looks only at the error text, never the tool name: the same underlying
 * failure shows up across tools, and one tool meets both transient failures and real errors.
 *
 * @module
 */

/**
 * Process spawn failure. The system throws it when file descriptors run short; it has
 * nothing to do with the command and a rerun fixes it.
 *
 * It is the most frequent tool failure in cross-session stats, and unattended it gets
 * read as the command really failing and shifts the judgment -- e.g. "check did not
 * pass" becomes a conclusion.
 */
const SPAWN_FAILURE = /spawn\s+EBADF/i;

/** Search tool failed to launch, unrelated to the query */
const SEARCH_LAUNCH_FAILURE = /could not start its search command/i;

const TRANSIENT = [SPAWN_FAILURE, SEARCH_LAUNCH_FAILURE];

/**
 * Whether this error deserves an automatic retry.
 *
 * The criterion is deliberately narrow: only failures that recur in cross-session
 * stats and are confirmed unrelated to the call. Widening it hides real failures -- a
 * real failure retried three times still fails, just three times slower; while an
 * error that should have been seen gets silently retried away, and the judgment ends
 * up built on a false premise.
 *
 * @param message - Error text returned by the tool
 * @returns `true` when it is a known transient failure
 *
 * @example
 * ```ts
 * isTransient("Error: spawn EBADF")        // true
 * isTransient("Error: command not found")  // false
 * ```
 */
export function isTransient(message: string): boolean {
  return TRANSIENT.some((pattern) => pattern.test(message));
}
