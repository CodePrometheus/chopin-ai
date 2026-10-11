#!/usr/bin/env node
/**
 * Team mode end to end in a real chopin profile, with a scripted model: one lead session
 * interviews, submits and approves a batch; workers write acceptance checks, deliver a
 * change, report read-only findings, and run into the scope, budget, tool and sandbox limits.
 * The verdict lists every expectation; the temporary DSH_HOME is kept when one fails.
 */

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { PROFILE, prepareProfile, repoRoot } from "./real-profile.mjs";

const BOOT_TIMEOUT_MS = 330_000;
const { home, workspace, env, log, dsh, manifestPath, step } = await prepareProfile("chopin-team-e2e-");
const resultPath = join(home, "result.json");
const fixture = join(repoRoot, ".agents", "e2e", home.split("/").at(-1));
await step("boot", [dsh, "--profile", PROFILE, "--patch", join(repoRoot, "scripts/team-e2e-overlay.yml")], {
  cwd: workspace,
  timeout: BOOT_TIMEOUT_MS,
  env: { ...env, CHOPIN_TEAM_E2E_RESULT: resultPath, CHOPIN_TEAM_E2E_PROFILE: manifestPath, CHOPIN_TEAM_DIR: join(home, "team"), CHOPIN_TEAM_E2E_FIXTURE: fixture },
});

let result;
try {
  result = JSON.parse(await readFile(resultPath, "utf8"));
} catch {
  console.error(`team e2e: the probe reported nothing\n       log: ${log}`);
  process.exit(1);
}
if (!result.ok) {
  console.error(`team e2e: probe failed: ${result.error}\n       home: ${home}`);
  process.exit(1);
}

const { leadCalls: calls, tasks, workers } = result;
const resultOf = (worker, tool, index = 0) => worker.calls.filter((call) => call.name === tool)[index]?.result;
const expectations = [
  ["submitting before the interview is refused", calls[0]?.name === "team_batch_submit" && calls[0].result?.isError && calls[0].result.text.includes("Interview the person first")],
  ["the interview skill loads", calls[1]?.name === "skill" && calls[1].result?.isError === false],
  ["the batch is submitted after the interview", calls[2]?.name === "team_batch_submit" && calls[2].result?.isError === false],
  ["the acceptance task pins a check for alpha", tasks.author?.status === "done" && tasks.alpha?.checks?.[0]?.path === "tests/alpha.check"],
  ["only the person's approval releases the batch", result.batch?.status === "approved"],
  ["alpha is committed with its check on its own branch, and the trunk is untouched", tasks.alpha?.status === "delivered" && result.trunk.subject === "base"
    && result.branch.subjects.join(",") === "feat: alpha" && [...result.branch.files].sort().join(",") === "src/alpha/impl.txt,tests/alpha.check"],
  ["alpha's check runs and passes in its sandbox", resultOf(workers.alpha, "team_check")?.text.startsWith("Passed")],
  ["a read-only task completes from its report", tasks.scout?.status === "done"],
  ["a worker is refused the lead's tools", resultOf(workers.scout, "team_status")?.isError && resultOf(workers.scout, "team_status").text.includes("belongs to the lead's session")],
  ["completion outside the write scope is refused within the round", resultOf(workers.sneak, "team_report")?.isError && resultOf(workers.sneak, "team_report").text.includes("src/shared.txt")],
  ["a needs-decision report waits for a person", tasks.sneak?.attention?.reason === "needs-decision"],
  ["the request cap stops a worker", tasks.greedy?.attention?.reason === "request-budget" && tasks.greedy.usage.requests <= 3],
  ["the sandbox keeps a worker inside its slot", result.outsideExists === false],
  ["workers ask the person for approvals and may write only their slot", JSON.stringify(workers.alpha.policies).includes('["approval/policy","ask"]')
    && JSON.stringify(workers.alpha.policies).includes('["sandbox/mode","workspace-write"]')],
  ["workers run as sub-agents of the lead, one per round", ["author", "alpha", "scout", "sneak", "greedy"].every((id) =>
    result.childLabels.some((label) => label.endsWith(` · ${id} · round 1`)))],
  ["a second session only watches while the lead is there", result.watched.includes("team-e2e-lead") && result.watched.includes("leads this team")],
  ["the second session leads once the person asks it to take over", result.tookOver.startsWith("This session leads the team") && result.leadAfterTakeover === "team-e2e-second"],
  ["closing the lead hands the team back", result.leadAfterClose === null],
  ["the lead's context carries the team brief", result.leadBriefSeen],
  ["the observer records worker sessions", result.observedWorkerSessions.length > 0],
];
let failed = 0;
for (const [label, passed] of expectations) {
  if (!passed) failed += 1;
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}`);
}
if (failed > 0) {
  console.error(`team e2e: ${failed} expectation(s) failed\n       result: ${resultPath}\n       log: ${log}\n       fixture: ${fixture}`);
  process.exit(1);
}
console.log("team e2e ok");
await rm(home, { recursive: true, force: true });
await rm(fixture, { recursive: true, force: true });
