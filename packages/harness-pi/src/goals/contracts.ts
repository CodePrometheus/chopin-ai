import { arr, int, lit, map, nul, obj, opt, str, union, unknown, type Static } from "@earendil-works/chord";
import { compile } from "@earendil-works/pi-schema";
import { refusal } from "../service-error.js";

const Identity = str({ min: 1 });
const Revision = int({ min: 1, max: Number.MAX_SAFE_INTEGER });
const EntryId = Revision;
const Time = int({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });
/** Internal driver input, retained in raw history but never attributed to the owner. */
export const GOAL_CONTROL_KIND = "chopin.goal-control";

/** An exact host delegation. Receiving owner input never implicitly replaces it. */
export const GoalGrantSchema = obj({ id: Identity, version: Revision });
export type GoalGrant = Static<typeof GoalGrantSchema>;
/** An immutable terminal source for an explicitly requested continuation. */
export const GoalContinuationSchema = obj({ goalId: Identity, expectedVersion: Revision });
export type GoalContinuation = Static<typeof GoalContinuationSchema>;

/** Owner commands; each command is delivered under one stable request identity. */
export const GoalCommandSchema = union([
  obj({ kind: lit("goal.submit"), objective: str({ min: 1 }), completionCriteria: arr(str({ min: 1 })), grant: GoalGrantSchema, continuation: opt(GoalContinuationSchema) }),
  obj({ kind: lit("goal.input"), goalId: Identity, expectedVersion: Revision, text: str({ min: 1 }), questionId: opt(Identity), grant: opt(GoalGrantSchema) }),
  obj({ kind: lit("goal.stop"), goalId: Identity, expectedVersion: Revision }),
]);
export type GoalCommand = Static<typeof GoalCommandSchema>;
export const EngineCommandSchema = obj({ version: lit(1), requestId: Identity, command: GoalCommandSchema });
export type EngineCommand = Static<typeof EngineCommandSchema>;
/** Durable admission, not execution completion. */
export const EngineReceiptSchema = obj({ version: lit(1), requestId: Identity, goalId: Identity, acceptedVersion: Revision });
export type EngineReceipt = Static<typeof EngineReceiptSchema>;

export const GoalStatusSchema = union([
  lit("accepted"), lit("running"), lit("waiting_user"), lit("waiting_authorization"), lit("waiting_time"),
  lit("waiting_dependency"), lit("stopping"), lit("completed"), lit("stopped"), lit("failed"),
]);
export type GoalStatus = Static<typeof GoalStatusSchema>;
/** A persisted wait bound to this goal, not to an observing client. */
export const GoalWaitingSchema = obj({ reason: str({ min: 1 }), questionId: opt(Identity), until: opt(Time) });
export type GoalWaiting = Static<typeof GoalWaitingSchema>;
/** A verified workspace artifact reference; a path is never a public download URL. */
export const GoalArtifactSchema = obj({ path: str({ min: 1 }), sha256: str({ pattern: "^[a-f0-9]{64}$" }) });
export type GoalArtifact = Static<typeof GoalArtifactSchema>;
const Criterion = int({ min: 0, max: Number.MAX_SAFE_INTEGER });
export const GoalEvidenceSchema = union([
  obj({ kind: lit("assistant"), criterion: Criterion, entryId: EntryId }),
  obj({ kind: lit("tool"), criterion: Criterion, entryId: EntryId, artifact: opt(GoalArtifactSchema) }),
]);
export type GoalEvidence = Static<typeof GoalEvidenceSchema>;
/** Completion references real source entries and the verifier's committed decision. */
export const GoalResultSchema = obj({ summary: str({ min: 1 }), evidence: arr(GoalEvidenceSchema), verifiedAt: Time });
export type GoalResult = Static<typeof GoalResultSchema>;
export const GoalSnapshotSchema = obj({
  goalId: Identity, conversationId: Revision, version: Revision, objective: str({ min: 1 }),
  completionCriteria: arr(str({ min: 1 })), status: GoalStatusSchema, grant: GoalGrantSchema,
  createdAt: Time, updatedAt: Time, waiting: opt(GoalWaitingSchema), result: opt(GoalResultSchema),
});
export type GoalSnapshot = Static<typeof GoalSnapshotSchema>;
/** A source page; its cursor must be round-tripped without interpretation. */
export const GoalPageSchema = obj({ goals: arr(GoalSnapshotSchema), cursor: opt(map(unknown())) });
export type GoalPage = { goals: GoalSnapshot[]; cursor?: Readonly<Record<string, import("@earendil-works/chord/json").JsonValue>> };

const Envelope = compile(EngineCommandSchema);
/** Validate representation before the transaction, without claiming delegated authority. */
export function validateCommand(value: unknown): EngineCommand {
  if (!Envelope.check(value)) throw refusal("invalid_command", "command violates its declared representation");
  const command = value.command;
  if (command.kind === "goal.submit" && (command.objective.trim() === "" || command.completionCriteria.some((criterion) => criterion.trim() === ""))) {
    throw refusal("invalid_command", "objective and criteria must contain text");
  }
  if (command.kind === "goal.input" && command.text.trim() === "") throw refusal("invalid_command", "input must contain text");
  return value;
}
/** Terminal goals retain their original state; continuation creates a separate goal. */
export function terminal(status: GoalStatus): boolean {
  return status === "completed" || status === "stopped" || status === "failed";
}
