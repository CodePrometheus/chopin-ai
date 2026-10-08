import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { EvolutionEventStore } from "@chopin/evolution";
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from "@deepseek-ai/dsh-loader-smoke";
import { describe, expect, it } from "vitest";

const driver = fileURLToPath(new URL("./fixtures/evolution-driver.ts", import.meta.url));
const configPath = fileURLToPath(new URL("./fixtures/evolution.cordis.yml", import.meta.url));
const tsconfigPath = fileURLToPath(new URL("../tsconfig.base.json", import.meta.url));

// Executable capabilities run only inside the macOS OS sandbox.
describe.runIf(process.platform === "darwin")("experience-derived plugin in a real DSH composition", () => {
  it("hot-swaps and rolls back an approved tool in the same process and session", { timeout: LOADER_SMOKE_TEST_TIMEOUT_MS }, async () => {
    let trace!: {
      calls: Array<{ callId: string; name: string }>;
      results: Array<{ callId: string; isError: boolean; text: string }>;
      sessionIds: string[];
      contexts: string[];
    };
    let runtimeLoaded = false;
    let rollbackLoaded = false;
    let v1ToolExposure = 0;
    let v2ToolExposure = 0;
    let v1ContextExposure = 0;
    let v2ContextExposure = 0;
    await runLoaderSmoke({
      label: "chopin-evolution",
      tempDirPrefix: "chopin-evolution-e2e-",
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath,
      mode: "lib",
      inspect: async (cwd) => {
        trace = JSON.parse(await readFile(join(cwd, "tool-trace.json"), "utf8"));
        const projection = await new EvolutionEventStore(join(cwd, ".evolution", "events.jsonl")).fold();
        const v1 = projection.artifacts.find((item) => item.id === "learned-echo:1.0.0");
        const v2 = projection.artifacts.find((item) => item.id === "learned-echo:2.0.0");
        runtimeLoaded = v2?.deploymentReceipts.some((receipt) =>
          receipt.operationId.startsWith("runtime-load-") && receipt.processGeneration === "e2e-generation") === true;
        rollbackLoaded = v1?.state === "retired" && v1.deploymentReceipts.filter((receipt) =>
          receipt.operationId.startsWith("runtime-load-") && receipt.processGeneration === "e2e-generation").length >= 2;
        v1ToolExposure = v1?.exposures["tool-called"] ?? 0;
        v2ToolExposure = v2?.exposures["tool-called"] ?? 0;
        v1ContextExposure = v1?.exposures.injected ?? 0;
        v2ContextExposure = v2?.exposures.injected ?? 0;
      },
    });

    expect(trace.calls).toEqual([
      { callId: "evolution-e2e-echo-1", name: "learned_echo" },
      { callId: "evolution-e2e-echo-2", name: "learned_echo" },
      { callId: "evolution-e2e-echo-3", name: "learned_echo" },
    ]);
    expect(trace.results.map((result) => result.isError)).toEqual([false, false, false]);
    expect(trace.results[0]?.text).toContain("v1:learned capability works");
    expect(trace.results[1]?.text).toContain("v2:learned capability works");
    expect(trace.results[2]?.text).toContain("v1:learned capability works");
    expect(new Set(trace.sessionIds).size).toBe(1);
    expect(runtimeLoaded).toBe(true);
    expect(rollbackLoaded).toBe(true);
    expect(v1ToolExposure).toBe(2);
    expect(v2ToolExposure).toBe(1);
    expect(v1ContextExposure).toBe(2);
    expect(v2ContextExposure).toBe(1);
    expect(trace.contexts).toEqual([
      "v1:{{literal_value}}:use the learned capability",
      "v2:{{literal_value}}:use the upgraded learned capability",
      "v1:{{literal_value}}:use the rolled-back learned capability",
    ]);
  });
});
