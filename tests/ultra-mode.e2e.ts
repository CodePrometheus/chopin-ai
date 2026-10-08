import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from "@deepseek-ai/dsh-loader-smoke";
import { describe, expect, it } from "vitest";

const driver = fileURLToPath(new URL("./fixtures/ultra-driver.ts", import.meta.url));
const configPath = fileURLToPath(new URL("./fixtures/ultra.cordis.yml", import.meta.url));
const tsconfigPath = fileURLToPath(new URL("../tsconfig.base.json", import.meta.url));

interface UltraTrace {
  rootSessionId: string;
  enabled: { kind: string; text?: string };
  disabled: { kind: string; text?: string };
  toolWhileEnabled: boolean;
  toolAfterDisable: boolean;
  subagentWhileEnabled: boolean;
  subagentAfterDisable: boolean;
  modeAfterReload: { kind: string; text?: string };
  toolAfterReload: boolean;
  output: string;
  ordinaryOutput: string;
  blockedChildReason: string;
  blockedSessionId: string;
  standardOutput: string;
  standardFollowupOutput: string;
  ultraEffortState: string;
  coldReadEventCount: number;
  resultText: string;
  maxConcurrentWorkers: number;
  requests: Array<{
    sessionId?: string;
    provider: string;
    model: string;
    effort?: string;
    ultraTool: boolean;
    system?: string;
    toolNames: string[];
  }>;
}

describe("Chopin Ultra in a real DSH composition", () => {
  it("enables max-reasoning bounded parallel workers for one session", { timeout: LOADER_SMOKE_TEST_TIMEOUT_MS }, async () => {
    let trace!: UltraTrace;
    await runLoaderSmoke({
      label: "chopin-ultra",
      tempDirPrefix: "chopin-ultra-e2e-",
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath,
      mode: "lib",
      inspect: async (cwd) => {
        trace = JSON.parse(await readFile(join(cwd, "ultra-trace.json"), "utf8")) as UltraTrace;
      },
    });

    expect(trace.enabled.kind).toBe("success");
    expect(trace.enabled.text).toContain("subscription quota");
    expect(trace.toolWhileEnabled).toBe(true);
    expect(trace.toolAfterDisable).toBe(false);
    expect(trace.subagentWhileEnabled).toBe(false);
    expect(trace.subagentAfterDisable).toBe(true);
    expect(trace.modeAfterReload).toEqual({ kind: "success", text: "Chopin mode: standard. Ultra delegation is disabled." });
    expect(trace.toolAfterReload).toBe(false);
    expect(trace.disabled).toEqual({ kind: "success", text: "Chopin mode: standard. Ultra delegation is disabled." });
    expect(trace.maxConcurrentWorkers).toBe(2);
    expect(trace.output).toBe("ultra synthesis complete");
    expect(trace.ordinaryOutput).toBe("ordinary child complete");
    expect(trace.blockedChildReason).toBe("blocked");
    expect(trace.requests.some((request) => request.sessionId === trace.blockedSessionId)).toBe(false);
    expect(trace.standardOutput).toBe("standard complete");
    expect(trace.standardFollowupOutput).toBe("standard complete");
    expect(trace.ultraEffortState).toBe("restored");
    expect(trace.coldReadEventCount).toBeGreaterThan(0);
    expect(trace.resultText).toContain("Worker 1 — inspect alpha [completed]");
    expect(trace.resultText).toContain("Worker 2 — inspect beta [completed]");

    const root = trace.requests.filter((request) => request.sessionId === trace.rootSessionId);
    const ultraRoot = root.filter((request) => request.ultraTool);
    const standardRoot = root.filter((request) => !request.ultraTool);
    const workers = trace.requests.filter((request) => request.system?.includes("one bounded worker in a Chopin Ultra batch"));
    const ordinary = trace.requests.filter((request) => request.provider === "chopin-ultra-initial");
    expect(root).toHaveLength(4);
    expect(ultraRoot).toHaveLength(2);
    expect(standardRoot).toHaveLength(2);
    expect(workers).toHaveLength(2);
    expect(ordinary).toHaveLength(1);
    expect([...ultraRoot, ...workers].every((request) => request.effort === "max")).toBe(true);
    expect(ordinary[0]?.effort).not.toBe("max");
    expect(standardRoot.every((request) => request.effort !== "max")).toBe(true);
    expect(ultraRoot[0]).toMatchObject({ provider: "chopin-ultra-current", model: "current-model" });
    expect(ultraRoot[1]).toMatchObject({ provider: "chopin-ultra-active-next", model: "active-next-model" });
    expect(workers.every((request) =>
      request.provider === "chopin-ultra-current" && request.model === "current-model")).toBe(true);
    expect(standardRoot.every((request) =>
      request.provider === "chopin-ultra-next" && request.model === "next-model")).toBe(true);
    expect(ordinary[0]).toMatchObject({ provider: "chopin-ultra-initial", model: "initial-model" });
    expect(ultraRoot[0]?.system).toContain("Chopin Ultra mode is active");
    expect(standardRoot.every((request) => !request.system?.includes("Chopin Ultra mode is active"))).toBe(true);
    expect(ultraRoot.every((request) => !request.toolNames.includes("subagent"))).toBe(true);
    expect(standardRoot.every((request) => request.toolNames.includes("subagent"))).toBe(true);
    expect(workers.every((request) => request.toolNames.includes("read"))).toBe(true);
    expect(workers.every((request) => !request.toolNames.some((name) =>
      ["ultra_delegate", "subagent", "subagent_fork", "subagent_claude_code", "workflow", "ralph"].includes(name)))).toBe(true);
  });
});
