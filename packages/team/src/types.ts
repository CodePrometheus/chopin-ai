/**
 * Team mode vocabulary: structured tasks, the authoritative event log and the projection
 * derived from it. Nothing here names a project; slots, checks and delivery come from the
 * target project's own configuration.
 *
 * @module @chopin/team/types
 */

/**
 * `acceptance` turns the batch's acceptance criteria into executable checks before approval;
 * its checks never land alone (they fail until the work exists) but ride with the change they
 * belong to. `change` edits code and must land on the trunk; `read-only` writes nothing and
 * delivers a report.
 */
export type TaskKind = "acceptance" | "change" | "read-only";

export interface ModelRoute {
  provider: string;
  model: string;
}

export interface TaskSpec {
  /** Lowercase slug, unique across the whole log. */
  id: string;
  kind: TaskKind;
  objective: string;
  /** The single-line message of the commit a change task lands; required exactly for `change`. */
  commitMessage?: string;
  /** Path globs this task may write; empty exactly for `read-only`. */
  writeScope: string[];
  /** Tasks that must be finished before this one may be claimed. */
  dependsOn: string[];
  acceptance: {
    criteria: string;
    examples: string[];
  };
  /** Omitted means the master's own model. */
  model?: ModelRoute;
  maxRequests: number;
  maxRounds: number;
  /** Post-trunk stages, resolved from the project configuration when the batch is proposed. */
  stages: string[];
  /** Whether part of the acceptance can only be confirmed by a person after the change lands. */
  manualAcceptance: boolean;
}

export type ReportStatus = "continue" | "complete" | "blocked" | "needs-decision";

/** What crosses from one round's worker to the next; bounded by the host. */
export interface RoundReport {
  status: ReportStatus;
  summary: string;
  evidence: string[];
  nextSteps: string[];
  blocker?: string;
  /** An acceptance task's account of which check file gates which task; the host pins each by content. */
  checks?: { forTaskId: string; path: string }[];
}

export interface RoundUsage {
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export type PauseReason =
  | "blocked"
  | "needs-decision"
  | "request-budget"
  | "round-budget"
  | "write-scope"
  | "rebase-conflict"
  | "approval"
  | "check-failed"
  | "batch-check"
  | "interrupted"
  | "rework"
  | "cancelled"
  | "replanned";

/** `local` keeps the commit on the task branch for the person to merge; the others publish it. */
export type DeliveryMode = "local" | "push" | "pull-request";

/** One acceptance check file, pinned by content so the task it gates cannot quietly edit it. */
export interface AuthoredCheck {
  forTaskId: string;
  /** Repository-relative path. */
  path: string;
  sha256: string;
}

/** `user` never writes directly; it is reserved for decisions the host relays from an approval. */
export type TeamActorKind = "host" | "master";

export interface TeamActor {
  kind: TeamActorKind;
  id: string;
}

interface EventEnvelope<T extends string, D> {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
  type: T;
  actor: TeamActor;
  data: D;
}

export type TeamEvent =
  | EventEnvelope<"batch.proposed", { batchId: string; tasks: TaskSpec[]; proposedBy: string }>
  | EventEnvelope<"batch.approved", { batchId: string; approvalAuditId: string; decidedAt: string }>
  | EventEnvelope<"batch.rejected", { batchId: string; reason: string }>
  | EventEnvelope<"task.claimed", { taskId: string; attemptId: string; slot: string; branch: string }>
  | EventEnvelope<"task.round-started", { taskId: string; attemptId: string; round: number; sessionId: string }>
  | EventEnvelope<"task.round-reported", { taskId: string; attemptId: string; round: number; report: RoundReport; usage: RoundUsage }>
  | EventEnvelope<"task.paused", { taskId: string; attemptId: string; reason: PauseReason; detail: string; savedCommit?: string }>
  | EventEnvelope<"decision.recorded", { taskId: string; decision: string; sessionId: string }>
  | EventEnvelope<"task.delivered", { taskId: string; attemptId: string; commit: string; mode: DeliveryMode }>
  | EventEnvelope<"task.landed", { taskId: string; commit: string }>
  | EventEnvelope<"task.completed", { taskId: string; attemptId: string }>
  /** `commit` is the acceptance branch head that holds the checks; slots restore them from it. */
  | EventEnvelope<"task.checks-authored", { taskId: string; attemptId: string; commit: string; checks: AuthoredCheck[] }>
  | EventEnvelope<"task.stage-passed", { taskId: string; stage: string; evidence: string }>
  | EventEnvelope<"task.stage-failed", { taskId: string; stage: string; evidence: string }>
  | EventEnvelope<"task.accepted", { taskId: string }>
  | EventEnvelope<"task.rework", { taskId: string; reason: string }>
  | EventEnvelope<"task.cancelled", { taskId: string; reason: string }>
  | EventEnvelope<"batch.checked", { batchId: string; passed: boolean; detail: string; culpritTaskId?: string }>
  | EventEnvelope<"slot.dirty", { slot: string; detail: string }>
  | EventEnvelope<"slot.cleaned", { slot: string }>;

export type TeamEventType = TeamEvent["type"];
export type TeamEventData<T extends TeamEventType> = Extract<TeamEvent, { type: T }>["data"];

export type BatchStatus = "proposed" | "approved" | "rejected";

export interface BatchProjection {
  id: string;
  status: BatchStatus;
  /** The lead session that proposed the batch, where its decisions are made. */
  proposedBy: string;
  taskIds: string[];
  /** Sum of the tasks' request caps: the most this batch can spend. */
  maxRequests: number;
  /** `culpritCommit` is what the culprit had landed when it was blamed; a newer landing calls for a new check. */
  check?: { passed: boolean; detail: string; culpritTaskId?: string; culpritCommit?: string };
}

/**
 * `proposed` waits for approval; `queued` may be claimed once its dependencies are done;
 * `attention` waits for a decision; `delivered` waits for the trunk; `done` is landed (or a
 * completed read-only report) and every configured stage passed.
 */
export type TaskStatus = "proposed" | "rejected" | "queued" | "running" | "attention" | "delivered" | "landed" | "done" | "cancelled";

export interface AttemptProjection {
  id: string;
  slot: string;
  branch: string;
  round: number;
  /** The last round that delivered its report; a round ends only with its report. */
  reportedRound: number;
  sessionId?: string;
  lastReport?: RoundReport;
}

export interface TaskProjection {
  spec: TaskSpec;
  batchId: string;
  status: TaskStatus;
  attempt?: AttemptProjection;
  /** Every attempt id ever claimed for this task; a report for any but the current one is stale. */
  attemptIds: string[];
  /** Rounds across all attempts, checked against `spec.maxRounds`. */
  rounds: number;
  usage: RoundUsage;
  /** The latest report across attempts; `round` below `rounds` means a later round ended without one. */
  lastReport?: { round: number; report: RoundReport };
  attention?: { reason: PauseReason; detail: string; savedCommit?: string };
  decisions: string[];
  delivered?: { commit: string; mode: DeliveryMode };
  landedCommit?: string;
  landedAt?: string;
  /** The task branch kept after a pause or cancellation; never deleted by the host. */
  branch?: string;
  stages: Record<string, { passed: boolean; evidence: string }>;
  accepted: boolean;
  /** Acceptance checks authored for this task; restored into its slot from `commit` and verified by content at delivery. */
  checks: { commit: string; path: string; sha256: string }[];
}

export interface SlotProjection {
  taskId?: string;
  dirty?: string;
}

export interface TeamProjection {
  batches: Record<string, BatchProjection>;
  tasks: Record<string, TaskProjection>;
  slots: Record<string, SlotProjection>;
  eventCount: number;
}
