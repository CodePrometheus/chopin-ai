/**
 * Decision table for transient failures.
 *
 * This decision determines whether a failure is silently retried or reported, and
 * both directions have a cost: a miss only costs one slow rerun, a false positive
 * makes an error that should have been seen vanish and builds later judgment on a
 * false premise. So both sides need standing cases.
 */

import { describe, expect, it } from "vitest";
import { isTransient } from "../src/transient.js";

describe("isTransient", () => {
  it("retries process spawn failures", () => {
    expect(isTransient("Error: spawn EBADF")).toBe(true);
    // Case and surrounding text may vary; the decision only looks at the signature string
    expect(isTransient("bash: Error: spawn ebadf at ChildProcess")).toBe(true);
  });

  it("retries search tool launch failures", () => {
    expect(isTransient("glob could not start its search command (ripgrep launch failed)")).toBe(true);
  });

  it("does not retry errors from the command itself", () => {
    expect(isTransient("Error: command not found: foo")).toBe(false);
    expect(isTransient("exit code: 1")).toBe(false);
  });

  // Permission and path problems give the same result however often retried; retrying only delays exposure
  it("does not retry permission and path errors", () => {
    expect(isTransient("permission denied")).toBe(false);
    expect(isTransient("no such file or directory")).toBe(false);
  });

  // The decision must stay narrow: merely mentioning EBADF is not enough, or normal
  // output containing the word would count as a failure
  it("does not retry on a similar word in the error text", () => {
    expect(isTransient("wrote EBADFLAG to the config")).toBe(false);
    expect(isTransient("the search command finished")).toBe(false);
  });
});
