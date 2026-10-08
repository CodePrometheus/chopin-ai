import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import type {  } from "@deepseek-ai/dsh-user-approval";
import type {  } from "@deepseek-ai/dsh-tools";
import {
  MANAGED_POLICY,
  artifactApproved,
  artifactBuilt,
  artifactDrafted,
  artifactVerified,
  artifactVersionId,
  assertApprovalReceipt,
  candidateClassified,
  candidateCorroborated,
  candidateIdFor,
  candidateObserved,
  canonicalJson,
  capabilityPermissionDigest,
  capabilityProvidesDigest,
  verifyStagedArtifact,
} from "@chopin/evolution";
import { buildSignalKey, correctionSignalKey, scrub } from "@chopin/ledger";
import type { ApprovalReceipt, ArtifactProjection, CapabilityManifest, EvolutionActor, EvolutionEvent, StagedArtifact } from "@chopin/evolution";

import { latestHumanPrompt } from "./facts.js";
import { selectEffectiveDataArtifacts } from "./selection.js";
import { completedTask } from "./maintenance.js";
import type { ArtifactHost } from "./runtime-host.js";
import type { AdvanceResult, ExperienceRecordInput, UserCorrectionResult } from "./index.js";
import { artifactReferenceOf, hasExactApproval } from "./deployment.js";

interface ExperienceHost extends ArtifactHost {
  advance(): Promise<AdvanceResult>;
  maintenanceBudgetReached(agent: Agent): boolean;
  guardedTools(): string[];
}

const HOST_AUTHOR_ACTOR: EvolutionActor = { kind: "system", id: "chopin-host-authoring" };

interface PreparedHostArtifact {
  inspection: StagedArtifact;
  commit(): Promise<StagedArtifact>;
  dispose(): Promise<void>;
}

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LESSON_MAX_CHARS = 500;
const CORRECTION_EXCERPT_MAX_CHARS = 400;
const pendingCorrections = new Map<string, Promise<UserCorrectionResult>>();

/** The memory manifest for one correction; correcting the same slug again cuts a new version that supersedes the old. */
function lessonManifest(input: {
  capabilityId: string;
  candidateId: string;
  lesson: string;
  when: string;
  workspace?: string;
  operationId: string;
  previous: readonly ArtifactProjection[];
  kind?: "memory" | "skill";
}): CapabilityManifest {
  const version = `1.0.0-c${input.operationId.slice(0, 40)}`;
  const latest = [...input.previous].sort((left, right) => right.stateChangedEventIndex - left.stateChangedEventIndex)
    .find((artifact) => artifact.enabled && (artifact.state === "active" || artifact.state === "retired"));
  return {
    schemaVersion: 1,
    id: input.capabilityId,
    version,
    kind: input.kind ?? "memory",
    runtime: "data",
    intendedEffect: "advisory",
    summary: input.lesson,
    entry: "content.md",
    trigger: { when: input.when, ...(input.workspace === undefined ? {} : { repos: [input.workspace] }) },
    provides: { contexts: input.kind === "skill" ? [] : [input.capabilityId], skills: input.kind === "skill" ? [input.capabilityId] : [], guards: [], tools: [], services: [], workflows: [] },
    permissions: [],
    dependencies: [],
    conflicts: [],
    requires: { chopinPluginApi: "^1.0.0" },
    lineage: {
      candidateIds: [input.candidateId],
      proposalIds: [`memory-${input.operationId}`],
      ...(latest === undefined ? {} : { supersedes: artifactReferenceOf(latest) }),
    },
  };
}

export class ExperienceAuthoring {
  constructor(private readonly host: ExperienceHost) {}

  async recordExperience(agent: Agent, callId: ToolCallId, input: ExperienceRecordInput): Promise<UserCorrectionResult> {
    if (input.source !== "correction" && input.source !== "completion") throw new Error("invalid experience source");
    if (input.scope !== undefined && input.scope !== "global" && input.scope !== "workspace") throw new Error("invalid experience scope");
    const workspace = input.scope === "workspace" ? agent.session.header.cwd : undefined;
    if (input.scope === "workspace" && !workspace) throw new Error("workspace-scoped experience requires a session working directory");
    const scopeKey = workspace === undefined ? "" : `-${createHash("sha256").update(workspace).digest("hex").slice(0, 16)}`;
    let slug = input.slug;
    const existing = selectEffectiveDataArtifacts((await this.host.events.snapshot()).projection).find(artifact => artifact.id === slug || artifact.manifest.id === slug);
    if (existing) {
      const repos = existing.manifest.trigger.repos ?? [];
      if (existing.manifest.kind !== (input.kind ?? "memory") || (workspace === undefined ? repos.length !== 0 : repos.length !== 1 || repos[0] !== workspace)) {
        throw new Error("The referenced experience belongs to a different kind or scope");
      }
      const family = existing.manifest.id;
      if (!family.startsWith("lesson-") || (scopeKey && !family.endsWith(scopeKey))) throw new Error("The referenced experience has no managed recording key");
      slug = family.slice("lesson-".length, family.length - scopeKey.length);
      if (`lesson-${slug}${scopeKey}` !== family) throw new Error("The referenced experience identity does not round-trip");
    }
    if (this.host.maintenanceBudgetReached(agent)) throw new Error("maintenance budget exhausted for this request");
    const lesson = scrub(input.lesson).replace(/\s+/g, " ").trim();
    if (lesson === "" || lesson.length > LESSON_MAX_CHARS) throw new Error(`lesson must be 1-${LESSON_MAX_CHARS} characters`);
    const when = scrub(input.when).replace(/\s+/g, " ").trim();
    const correctionKey = `${correctionSignalKey(slug)}${scopeKey}`;
    const signalKey = input.source === "completion"
      ? buildSignalKey({ kind: "task-completion", tool: "experience", error: `${slug}${scopeKey}` }) : correctionKey;
    const candidateId = candidateIdFor(signalKey);
    const prompt = latestHumanPrompt(agent.session);
    if (prompt === undefined) throw new Error("no user message in this session to record as a correction");
    const completion = input.source === "completion" ? completedTask(agent.session, this.host.guardedTools()) : undefined;
    if (input.source === "completion" && completion === undefined) throw new Error("experience capture requires a successful gated delivery in the current request");
    const sourceId = completion?.callId ?? prompt.requestId;
    const sourceTime = completion?.occurredAt ?? prompt.occurredAt;
    const sourceRef = completion === undefined
      ? `session:${agent.session.id}:user-message:${prompt.requestId}`
      : `session:${agent.session.id}:event:${completion.seq}`;
    const excerpt = scrub(completion === undefined ? prompt.prompt : `${completion.tool} completed; ${sourceRef}`)
      .replace(/\s+/g, " ").trim().slice(0, CORRECTION_EXCERPT_MAX_CHARS);
    if (excerpt === "") throw new Error("the latest user message is empty after scrubbing");
    const body = scrub(input.body ?? lesson).trim();
    if (body.length === 0 || body.length > 12_000) throw new Error("experience body must be 1-12000 characters");
    const sessionId = String(agent.session.id);
    const capabilityId = `lesson-${slug}${scopeKey}`;
    const operationId = createHash("sha256").update(canonicalJson({
      sessionId, requestId: sourceId, source: input.source, kind: input.kind ?? "memory", signalKey, lesson, when, excerpt, body,
    })).digest("hex");
    const proposalId = `memory-${operationId}`;
    const evidenceId = `evidence-${createHash("sha256").update(`${sessionId}\0${sourceId}\0${signalKey}`).digest("hex")}`;
    const observedEventId = `observed-${createHash("sha256").update(evidenceId).digest("hex")}`;
    const operationKey = canonicalJson({ eventsFile: this.host.events.path, operationId });
    const pending = pendingCorrections.get(operationKey);
    if (pending !== undefined) return pending;

    const finish = async (artifactId: string, eventId = observedEventId): Promise<UserCorrectionResult> => {
      await this.host.advance();
      const projection = (await this.host.events.snapshot()).projection;
      const artifact = projection.artifacts.find((item) => item.id === artifactId);
      if (artifact === undefined) throw new Error(`committed correction artifact ${artifactId} is missing`);
      return {
        outcome: "allowed-once", candidateId: artifact.manifest.lineage.candidateIds[0] ?? candidateId, eventId, artifactId,
        artifactState: artifact.state,
        enabled: selectEffectiveDataArtifacts(projection).some((item) => item.id === artifactId),
        authorization: artifact.approvalReceipts.some((receipt) => receipt.policy !== undefined) ? "policy" : "user",
      };
    };

    const run = (async (): Promise<UserCorrectionResult> => {
      const before = (await this.host.events.snapshot()).projection;
      const committed = before.artifacts.find((artifact) =>
        artifact.manifest.id === capabilityId && artifact.manifest.lineage.proposalIds.includes(proposalId));
      if (committed !== undefined) {
        if (!hasExactApproval(committed)) throw new Error(`correction artifact ${committed.id} has no exact approval`);
        return finish(committed.id);
      }
      const previous = before.artifacts.filter((artifact) => artifact.manifest.id === capabilityId);
      const effective = selectEffectiveDataArtifacts(before).find((artifact) => artifact.manifest.id === capabilityId
        && artifact.manifest.kind === (input.kind ?? "memory") && artifact.manifest.summary === lesson && artifact.manifest.trigger.when === when);
      if (effective !== undefined) {
        const staged = await this.host.artifacts.inspect(effective.contentDigest);
        if ((await readFile(join(staged.path, staged.manifest.entry), "utf8")).trim() === body) {
          const original = before.candidates.find((candidate) => effective.manifest.lineage.candidateIds.includes(candidate.id));
          if (original !== undefined) return finish(effective.id, original.firstEventId);
        }
      }
      const manifest = lessonManifest({ capabilityId, candidateId, lesson, when, workspace, operationId, previous, kind: input.kind });
      if (!STABLE_ID.test(artifactVersionId(manifest))) throw new Error("Recording key is too long for its scope; use a shorter key or the exact existing experience identifier");
      const prepared = await this.prepareHostArtifact(manifest, { "content.md": `${body}\n` });
      try {
        const approval = this.host.autonomous
          ? { outcome: "allowed-once" as const, decidedAt: new Date().toISOString(), auditId: undefined }
          : await this.host.requestAuditedApproval(
          agent,
          callId,
          "evolution_correction_record",
          [
            `Record correction "${input.slug}": ${lesson}`,
            `Applies when: ${when}`,
            `From your message: "${excerpt}"`,
            `Artifact: ${artifactVersionId(manifest)}`,
            `Exact content digest: ${prepared.inspection.contentDigest}`,
          ].join("\n"),
        );
        if (approval.outcome !== "allowed-once" || (!this.host.autonomous && approval.auditId === undefined) || approval.decidedAt === undefined) {
          return { outcome: approval.outcome, candidateId };
        }
        const staged = await prepared.commit();
        const artifactId = artifactVersionId(manifest);
        const sourceRevision = `host:no-git@${staged.contentDigest}`;
        const verification = await verifyStagedArtifact(this.host.artifacts, staged.contentDigest, {
          sourceRevision,
          receiptsDir: this.host.receiptsDir,
          chopinVersion: this.host.chopinVersion,
          dshVersion: this.host.dshVersion,
        });
        if (verification.verdict !== "pass") {
          throw new Error(`lesson artifact ${artifactId} failed static verification: ${verification.checks.filter((check) => check.status === "fail").map((check) => check.name).join(", ")}`);
        }
        const receipt: ApprovalReceipt = {
          receiptId: `approve-${randomUUID()}`,
          artifactId,
          contentDigest: staged.contentDigest,
          manifestDigest: staged.manifestDigest,
          surfaceDigest: staged.surfaceDigest,
          permissionDigest: capabilityPermissionDigest(manifest),
          capabilityDigest: capabilityProvidesDigest(manifest),
          decision: approval.outcome,
          sessionId,
          decidedAt: approval.decidedAt,
          ...(this.host.autonomous
            ? { actor: "host-policy", policy: MANAGED_POLICY }
            : { actor: "dsh-approval-seam", approvalAuditId: approval.auditId }),
        };
        assertApprovalReceipt(receipt);
        const committedId = await this.host.events.transact((projection, history) => {
          const existing = projection.artifacts.find((artifact) =>
            artifact.manifest.id === capabilityId && artifact.manifest.lineage.proposalIds.includes(proposalId));
          if (existing !== undefined) {
            if (!hasExactApproval(existing)) throw new Error(`correction artifact ${existing.id} has no exact approval`);
            return { events: [], value: existing.id };
          }
          const candidate = projection.candidates.find((item) => item.id === candidateId);
          if (completion !== undefined && projection.candidates.some((item) => item.evidence.some((evidence) => evidence.class === "task-completion"
            && evidence.sourceSessionId === sessionId && evidence.sourceAttemptId === prompt.requestId))) {
            throw new Error("this completed task has already been captured; update it during a later task");
          }
          const lifecycle: EvolutionEvent[] = [];
          // One user message keeps only the first approved evidence event; later wordings belong to their own artifacts.
          if (!history.some((event) => event.eventId === observedEventId)) {
            lifecycle.push(candidateObserved({
              candidateId,
              eventId: observedEventId,
              occurredAt: receipt.decidedAt,
              actor: completion === undefined ? { kind: "user", id: prompt.requestId } : HOST_AUTHOR_ACTOR,
            }, {
              signalKey,
              lesson: candidate?.lesson ?? lesson,
              evidence: {
                evidenceId,
                class: completion === undefined ? "user-correction" : "task-completion",
                independenceKey: sessionId,
                independentUnits: 1,
                observedAt: sourceTime,
                contentHash: `sha256:${createHash("sha256").update(excerpt).digest("hex")}`,
                summary: excerpt,
                sourceSessionId: sessionId,
                sourceAttemptId: completion === undefined ? sourceId : prompt.requestId,
                sourceRef,
              },
            }));
          }
          if (candidate === undefined || candidate.state === "observed" || candidate.state === "corroborated") {
            lifecycle.push(candidateCorroborated({ candidateId, actor: HOST_AUTHOR_ACTOR }, {
              rootCause: `${completion === undefined ? "Interpreted user correction" : "Lesson from completed task"}: ${lesson}`,
              trigger: manifest.trigger,
              boundaries: { includes: [when], excludes: [] },
            }));
          }
          lifecycle.push(
            candidateClassified({ candidateId, actor: HOST_AUTHOR_ACTOR }, [{
              proposalId, kind: manifest.kind, intendedEffect: "advisory", summary: lesson,
              trigger: manifest.trigger, requiredPermissions: [],
            }]),
            artifactDrafted({ artifactId, actor: HOST_AUTHOR_ACTOR }, {
              manifest, contentDigest: staged.contentDigest,
              manifestDigest: staged.manifestDigest, surfaceDigest: staged.surfaceDigest,
            }),
            artifactBuilt({ artifactId, actor: HOST_AUTHOR_ACTOR }, {
              contentDigest: staged.contentDigest, manifestDigest: staged.manifestDigest,
              surfaceDigest: staged.surfaceDigest, sourceRevision,
            }),
            artifactVerified({ artifactId, actor: { kind: "system", id: "chopin-static-verifier" } }, verification),
            artifactApproved({ artifactId, actor: { kind: "system", id: receipt.actor } }, receipt),
          );
          return { events: lifecycle, value: artifactId };
        });
        return finish(committedId);
      } finally {
        await prepared.dispose();
      }
    })();
    pendingCorrections.set(operationKey, run);
    try {
      return await run;
    } finally {
      pendingCorrections.delete(operationKey);
    }
  }

  /** The host computes the content digest; after authorization only those same bytes are committed. */
  private async prepareHostArtifact(manifest: CapabilityManifest, files: Record<string, string>): Promise<PreparedHostArtifact> {
    const directory = join(this.host.artifacts.root, ".host-authoring", randomUUID());
    await mkdir(directory, { recursive: true });
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      await rm(directory, { recursive: true });
      disposed = true;
    };
    try {
      await writeFile(join(directory, "capability.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content, "utf8");
      const inspection = await this.host.artifacts.inspectSource(directory);
      return {
        inspection,
        commit: async () => {
          const staged = await this.host.artifacts.stage(directory);
          if (
            staged.contentDigest !== inspection.contentDigest
            || staged.manifestDigest !== inspection.manifestDigest
            || staged.surfaceDigest !== inspection.surfaceDigest
          ) throw new Error(`host artifact ${artifactVersionId(manifest)} changed after approval`);
          return staged;
        },
        dispose,
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  }

}
