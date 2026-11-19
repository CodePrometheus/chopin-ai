import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const integer = (minimum: number, maximum = Number.MAX_SAFE_INTEGER) => Type.Integer({ minimum, maximum });
const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
/** Canonical UUIDs serialized by the Rust command authority. */
export const JobIdSchema = Type.String({ minLength: 36, maxLength: 36, pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" });
const text = Type.String({ minLength: 1, pattern: "^[^\\u0000]*$" });
const identity = Type.String({ minLength: 1 });
export const JobRequestSchema = object({
  version: Type.Literal(1), domain: JobIdSchema,
  source: Type.Union([
    object({ kind: Type.Literal("tool"), goalId: identity, conversationId: integer(1), taskId: integer(1), callId: identity }),
    object({ kind: Type.Literal("learning"), runId: JobIdSchema }),
  ]),
  grant: object({ id: JobIdSchema, version: integer(1) }),
  argv: Type.Array(Type.String({ pattern: "^[^\\u0000]*$" }), { minItems: 1 }), cwd: text,
  env: Type.Record(Type.String({ pattern: "^[^=\\u0000]+$" }), Type.String({ pattern: "^[^\\u0000]*$" }), { additionalProperties: false }),
  inheritEnv: Type.Boolean(), timeoutMs: Type.Optional(nullable(integer(1))), policyRevision: identity,
});
export type JobRequest = Static<typeof JobRequestSchema>;

/** Representation checks shared by transports and durable admission, before any pending intent is written. */
export function isJobRequest(value: unknown): value is JobRequest {
  if (!Value.Check(JobRequestSchema, value)) return false;
  const nil = "00000000-0000-0000-0000-000000000000";
  return value.domain !== nil && value.grant.id !== nil && value.argv[0] !== "" && (value.source.kind !== "learning" || value.source.runId !== nil);
}

export const JobSnapshotSchema = object({
  scopeId: JobIdSchema, operationId: JobIdSchema,
  state: object({
    version: integer(0), phase: Type.Union([Type.Literal("pending"), Type.Literal("reserved"), Type.Literal("attached"), Type.Literal("running"), Type.Literal("exited"), Type.Literal("drained")]),
    stopRequested: Type.Boolean(), worker: nullable(JobIdSchema),
    process: nullable(object({ domain: JobIdSchema, boot: JobIdSchema, initPid: integer(0, 0xffff_ffff), startTicks: integer(0), namespaceInode: integer(0) })),
    released: Type.Boolean(), started: Type.Boolean(),
    primaryExit: nullable(Type.Union([object({ kind: Type.Literal("code"), value: integer(-0x8000_0000, 0x7fff_ffff) }), object({ kind: Type.Literal("signal"), value: integer(-0x8000_0000, 0x7fff_ffff) })])),
    outputComplete: Type.Boolean(), lastSequence: integer(0),
  }),
});
export type JobSnapshot = Static<typeof JobSnapshotSchema>;

export const JobOutputSchema = object({
  stream: nullable(Type.Union([Type.Literal("stdout"), Type.Literal("stderr")])),
  data: Type.String({ pattern: "^[A-Za-z0-9_-]*$" }), cursor: Type.String({ minLength: 1 }), complete: Type.Boolean(),
});
export type JobOutput = Static<typeof JobOutputSchema>;

/** An authoritative refusal; transport failures and unavailable observations remain unknown. */
export class CommandRefusal extends Error {
  readonly status: number;
  constructor(status: number) { super(`the command host refused the operation: ${status}`); this.status = status; }
}

/** Original-operation transport. Callers persist intent before submitting and reconcile unknown outcomes by ID. */
export interface CommandBroker {
  submit(operation: string, request: JobRequest, signal?: AbortSignal): Promise<JobSnapshot>;
  cancel(operation: string, request: JobRequest, signal?: AbortSignal): Promise<JobSnapshot>;
  get(operation: string, signal?: AbortSignal): Promise<JobSnapshot | undefined>;
  reconcile(operation: string, signal?: AbortSignal): Promise<JobSnapshot>;
  stop(operation: string, signal?: AbortSignal): Promise<JobSnapshot>;
  output(operation: string, limit: number, cursor?: string, signal?: AbortSignal): Promise<JobOutput>;
}
