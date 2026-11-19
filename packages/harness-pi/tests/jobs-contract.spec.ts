import { readFile } from "node:fs/promises";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { isJobRequest, JobOutputSchema, JobRequestSchema, JobSnapshotSchema } from "../src/jobs.js";

it("accepts both command sources, every lifecycle phase and binary output serialized by Rust", async () => {
  const values: { requests: unknown[]; snapshots: unknown[]; output: unknown[] } = JSON.parse(await readFile(new URL("../../../crates/job-broker/contracts.json", import.meta.url), "utf8"));
  expect(values.requests).toHaveLength(2);
  expect(values.snapshots).toHaveLength(6);
  expect(values.output).toHaveLength(3);
  for (const request of values.requests) expect(Value.Check(JobRequestSchema, request)).toBe(true);
  for (const snapshot of values.snapshots) expect(Value.Check(JobSnapshotSchema, snapshot)).toBe(true);
  for (const output of values.output) expect(Value.Check(JobOutputSchema, output)).toBe(true);
});

it("rejects representations the Rust authority cannot admit while retaining empty later arguments", async () => {
  const wire = JSON.parse(await readFile(new URL("../../../crates/job-broker/contracts.json", import.meta.url), "utf8"));
  const original = wire.requests[0]; const nil = "00000000-0000-0000-0000-000000000000";
  expect(isJobRequest({ ...original, argv: ["sh", ""] })).toBe(true);
  expect(isJobRequest({ ...original, source: { ...original.source, goalId: "opaque\0goal", callId: "opaque\0call" }, policyRevision: "opaque\0policy" })).toBe(true);
  for (const changed of [
    { ...original, argv: [""] }, { ...original, domain: nil }, { ...original, grant: { ...original.grant, id: nil } },
    { ...original, source: { ...original.source, taskId: 0 } }, { ...original, source: { ...original.source, conversationId: 0 } },
    { ...wire.requests[1], source: { kind: "learning", runId: nil } },
  ]) expect(isJobRequest(changed)).toBe(false);
});
