/**
 * Real composition verification: do the gates actually hold inside a running agent loop.
 *
 * Unit tests only prove the verdict function computes correctly; this proves it is really
 * wired into the tool execution pipeline, and that its source is the session log: the same
 * tool with the same arguments passes the second time only because a successful
 * ledger_search happened in between.
 *
 * Requires `pnpm build` first: the fixture loads each package's build artifacts.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from "@deepseek-ai/dsh-loader-smoke";

const driver = fileURLToPath(new URL("./fixtures/gate-driver.ts", import.meta.url));
const configPath = fileURLToPath(new URL("./fixtures/gate.cordis.yml", import.meta.url));
const tsconfigPath = fileURLToPath(new URL("../tsconfig.base.json", import.meta.url));

interface Trace {
  calls: { callId: string; name: string }[];
  results: { callId: string; isError: boolean; text: string }[];
}

describe("chopin gates in a real composition", () => {
  it("blocks an unevidenced submission and passes it once the evidence is gathered", { timeout: LOADER_SMOKE_TEST_TIMEOUT_MS }, async () => {
    let trace!: Trace;
    await runLoaderSmoke({
      label: "chopin-gate",
      tempDirPrefix: "chopin-gate-e2e-",
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath,
      mode: "lib",
      inspect: async (cwd) => {
        trace = JSON.parse(await readFile(join(cwd, "tool-trace.json"), "utf8")) as Trace;
      },
    });

    const resultOf = (callId: string) => trace.results.find((result) => result.callId === callId);

    // Every step of the script really happened.
    expect(trace.calls.map((call) => call.name)).toEqual([
      "submit_report",
      "ledger_search",
      "submit_report",
      "submit_broken",
      "ledger_write",
    ]);

    // First submission: nothing searched, blocked, and the reason names the missing gate.
    const first = resultOf("gate-e2e-submit-1");
    expect(first?.isError).toBe(true);
    expect(first?.text).toContain("recurrence-ledger");

    // The evidence call in between succeeded: the gate counts "searched", not "found".
    expect(resultOf("gate-e2e-ledger")?.isError).toBe(false);

    // Same tool, same arguments, passes this time. The only variable is the call in between.
    expect(resultOf("gate-e2e-submit-2")?.isError).toBe(false);

    // Tool availability is the static composition check's job; the runtime guard only reports what is currently unsatisfied.
    const broken = resultOf("gate-e2e-broken");
    expect(broken?.isError).toBe(true);
    expect(broken?.text).toContain("impossible");
    expect(broken?.text).toContain("Needs a tool nothing provides");

    // Writing the ledger must ask first. This composition has no approval service, so ask
    // degrades to a rejection: better to fail the write than to write silently.
    const write = resultOf("gate-e2e-ledger-write");
    expect(write?.isError).toBe(true);
    expect(write?.text).toContain("approval");
  });
});
