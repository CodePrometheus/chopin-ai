/**
 * Team mode: a deterministic orchestrator that runs fresh, bounded workers per task in
 * fixed worktree slots, with every state derived from one authoritative event log.
 *
 * @module @chopin/team
 */

export { CHECK_TOOL, REPORT_TOOL, workerBrief } from "./brief.js";
export { modifiedChecks, sha256File } from "./checks.js";
export { affectedChecks, findTeamRoot, loadTeamConfig, parseTeamConfig, scopeViolations, TEAM_CONFIG_PATH, TeamConfigError } from "./config.js";
export type { CheckRule, SlotConfig, StageConfig, TeamConfig } from "./config.js";
export { assertTeamEvent, InvalidTeamEventError, teamEvent } from "./events.js";
export { TeamEngine } from "./engine.js";
export type { CommandPort, CommandResult, EngineOptions, RoundGate, WorkerOutcome, WorkerPort, WorkerRound } from "./engine.js";
export { authoredChecks, checkCommands, completionRefusal } from "./gates.js";
export type { CheckRun, GateContext, Refusal } from "./gates.js";
export { claimableTasks, foldTeamEvents, TeamFoldError } from "./fold.js";
export { assertReport, InvalidReportError, REPORT_LIMITS } from "./report.js";
export { assign, branchFor, scopesOverlap, stuckTasks } from "./scheduler.js";
export type { Assignment } from "./scheduler.js";
export { acquireLease, holderAlive, Lease, leaseHolder, takeOverLease } from "./lease.js";
export type { LeaseHolder } from "./lease.js";
export { leadBrief } from "./status.js";
export { TeamEventStore, TeamLogCorruptError, TeamLogLockError } from "./store.js";
export type * from "./types.js";
