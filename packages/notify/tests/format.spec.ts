/**
 * Values in the notification text.
 *
 * The notification is one line and its reader is in another window, so neither field
 * may be ambiguous: the duration must show its magnitude at a glance, and the
 * workspace name must tell concurrently open sessions apart.
 */

import { describe, expect, it } from "vitest";
import { humanDuration, spokenByPerson, workspaceLabel } from "../src/index.js";

describe("humanDuration", () => {
  it("gives only seconds under a minute", () => {
    expect(humanDuration(3_000)).toBe("3s");
    expect(humanDuration(59_400)).toBe("59s");
  });

  it("whole minutes carry no zero-second tail", () => {
    expect(humanDuration(120_000)).toBe("2m");
  });

  it("gives minutes and seconds past a minute", () => {
    expect(humanDuration(200_000)).toBe("3m20s");
  });

  // Rounding boundary: 59.6 seconds reads as 1m, not 60s
  it("never shows 60s when rounding up to a whole minute", () => {
    expect(humanDuration(59_600)).toBe("1m");
  });
});

describe("workspaceLabel", () => {
  it("takes the last path segment", () => {
    expect(workspaceLabel("/home/me/work/sample-project")).toBe("sample-project");
  });

  it("ignores a trailing slash", () => {
    expect(workspaceLabel("/home/me/work/sample-project/")).toBe("sample-project");
  });

  // The root has no usable segment; fall back to a fixed value rather than an empty string -- a notification with an empty title shows no source
  it("falls back to a fixed name for the root path", () => {
    expect(workspaceLabel("/")).toBe("chopin");
    expect(workspaceLabel("")).toBe("chopin");
  });
});

describe("spokenByPerson", () => {
  it("counts only messages a person typed, not briefs a host injected", () => {
    expect(spokenByPerson([{ type: "user/message", data: { source: { kind: "team" } } }])).toBe(false);
    expect(spokenByPerson([{ type: "assistant/message", data: {} }, { type: "user/message", data: { source: { kind: "user" } } }])).toBe(true);
  });
});
