import { describe, expect, it } from "vitest";

import { defineChopinPlugin } from "../src/index.js";
import type { CapabilityManifest } from "../src/index.js";

function manifest(overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    schemaVersion: 1,
    id: "read-first-guard",
    version: "1.0.0",
    kind: "gate",
    runtime: "dsh-plugin",
    intendedEffect: "preventive",
    summary: "Require a read before edit.",
    entry: "index.js",
    trigger: { tools: ["str_replace_editor"] },
    provides: { contexts: [], skills: [], guards: ["read-first"], tools: [], services: [], workflows: [] },
    permissions: ["tools:guard"],
    dependencies: [],
    conflicts: [],
    requires: { chopinPluginApi: "^1.0.0", dsh: "0.1.1-rc.2" },
    lineage: { candidateIds: ["read-before-edit"], proposalIds: ["read-first-guard"] },
    ...overrides,
  };
}

describe("defineChopinPlugin", () => {
  it("returns a frozen definition and exposes no DSH types", () => {
    const plugin = defineChopinPlugin({ manifest: manifest(), activate() {} });
    expect(Object.isFrozen(plugin)).toBe(true);
    expect(plugin.manifest.id).toBe("read-first-guard");
  });

  it("rejects a data capability posing as an executable plugin", () => {
    expect(() => defineChopinPlugin({
      manifest: manifest({
        kind: "memory",
        runtime: "data",
        intendedEffect: "advisory",
        provides: { contexts: ["read-first"], skills: [], guards: [], tools: [], services: [], workflows: [] },
        permissions: [],
        requires: { chopinPluginApi: "^1.0.0" },
      }),
      activate() {},
    })).toThrow(/cannot use data runtime/);
  });
});
