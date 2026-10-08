/**
 * Contract of the failure signature: the same error clusters apart under different gates,
 * the version is part of the signature, and slugs are shape-constrained.
 */

import { describe, expect, it } from "vitest";

import { NORMALIZER_VERSION, buildSignalKey, correctionSignalKey, normalizeErrorString, scrub } from "../src/index.js";

describe("buildSignalKey", () => {
  it("five-segment signature: version, kind, tool, gate, normalized error string", () => {
    const key = buildSignalKey({ kind: "tool-failure", tool: "bash", error: "spawn EBADF at /tmp/build-123" });
    expect(key).toBe(`sk${NORMALIZER_VERSION}:tool-failure:bash:-:${normalizeErrorString("spawn EBADF at /tmp/build-123").key}`);
  });

  it("the same error rejected by different gates is a different cluster", () => {
    const base = { kind: "gate-rejection", tool: "submit_delivery", error: "Rejected by 1 unmet investigation gate(s)" };
    expect(buildSignalKey({ ...base, gate: "verified" })).not.toBe(buildSignalKey({ ...base, gate: "diff-reviewed" }));
    expect(buildSignalKey({ ...base, gate: "verified+diff-reviewed" })).toContain(":verified+diff-reviewed:");
  });

  it("segments cannot contain the separator", () => {
    expect(() => buildSignalKey({ kind: "tool:failure", tool: "bash", error: "x" })).toThrow(/kind/);
    expect(() => buildSignalKey({ kind: "tool-failure", tool: "bash", gate: "a b", error: "x" })).toThrow(/gate/);
  });
});

describe("correctionSignalKey", () => {
  it("accepts kebab-case slugs and rejects other shapes", () => {
    expect(correctionSignalKey("reuse-one-deploy-branch")).toBe(`sk${NORMALIZER_VERSION}:user-correction:reuse-one-deploy-branch`);
    expect(() => correctionSignalKey("Reuse Branch")).toThrow(/kebab-case/);
    expect(() => correctionSignalKey("a".repeat(65))).toThrow(/64/);
  });
});

describe("scrub", () => {
  it("wipes secret shapes and leaves ordinary errors alone", () => {
    expect(scrub("TOKEN=super-secret-value")).toContain("<redacted>");
    expect(scrub("ETIMEDOUT connecting to db")).toBe("ETIMEDOUT connecting to db");
  });
});
