import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { JsonSchemaNode, ToolDefinition } from "@deepseek-ai/dsh-tools";
import { evolutionQueue, renderEvolutionQueue } from "@chopin/evolution-runtime";
import type { EvolutionQueueItem } from "@chopin/evolution-runtime";
import {
  TRIGGER_WHEN_MAX_CHARS,
  candidateClassified,
  candidateCorroborated,
  candidateMerged,
  candidateRejected,
  candidateResolved,
} from "@chopin/evolution";
import type {
  ApplicabilityTrigger,
  ArtifactProposal,
  CandidateBoundaries,
  CandidateState,
  ProposalOutcome,
} from "@chopin/evolution";

import { stageArtifactFromCandidate, summarizeCandidates } from "./authoring.js";

type JsonValue = Parameters<ToolDefinition["output"]["render"]>[1];

export {
  EvolutionAuthoringError,
  assertProposalMatchesManifest,
  deriveHostSourceRevision,
  formatHostSourceRevision,
  readAuthoringManifest,
  resolveOwnedSourceDirectory,
  stageArtifactFromCandidate,
  summarizeCandidates,
} from "./authoring.js";
export type {
  CandidateSummary,
  GitHeadReader,
  StagedArtifactSummary,
} from "./authoring.js";

export const name = "chopin-evolution-authoring";
export const inject = ["tools", "chopinEvolution"];

export const AUTHORING_TOOL_NAMES = [
  "evolution_candidates_list",
  "evolution_candidate_corroborate",
  "evolution_candidate_classify",
  "evolution_candidate_reject",
  "evolution_candidate_merge",
  "evolution_artifact_stage",
  "evolution_candidate_resolve",
  "evolution_correction_record",
  "evolution_queue",
  "evolution_experience_record",
  "evolution_candidate_read",
] as const;

const CANDIDATE_STATES: CandidateState[] = ["observed", "corroborated", "classified", "resolved", "rejected", "merged"];
const TRIGGER_PROPERTIES = {
  when: {
    type: "string" as const,
    description:
      "One line naming the action and the surface this lesson applies to, e.g. \"deploying to staging or creating a "
      + "deploy branch\". The host loads eligible short lessons automatically; this condition controls when to apply them. "
      + `At most ${TRIGGER_WHEN_MAX_CHARS} characters.`,
  },
  repos: { type: "array" as const, items: { type: "string" as const } },
  taskKinds: { type: "array" as const, items: { type: "string" as const } },
  pathGlobs: { type: "array" as const, items: { type: "string" as const } },
  tools: { type: "array" as const, items: { type: "string" as const } },
  errorKeys: { type: "array" as const, items: { type: "string" as const } },
  languages: { type: "array" as const, items: { type: "string" as const } },
  environments: { type: "array" as const, items: { type: "string" as const } },
};

const CANDIDATE_OUTPUT: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: ["candidateId", "state", "eventId"],
  properties: {
    candidateId: { type: "string" },
    state: { type: "string", enum: CANDIDATE_STATES },
    eventId: { type: "string" },
  },
};

const CANDIDATE_LIST_OUTPUT: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: ["count", "candidates"],
  properties: {
    count: { type: "integer" },
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "state", "trustedIndependentUnits", "proposalCount", "updatedAt"],
        properties: {
          id: { type: "string" },
          state: { type: "string", enum: CANDIDATE_STATES },
          trustedIndependentUnits: { type: "integer" },
          proposalCount: { type: "integer" },
          updatedAt: { type: "string" },
        },
      },
    },
  },
};

const STAGE_OUTPUT: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: ["artifactId", "contentDigest", "manifestDigest", "surfaceDigest", "sourceRevision", "created"],
  properties: {
    artifactId: { type: "string" },
    contentDigest: { type: "string" },
    manifestDigest: { type: "string" },
    surfaceDigest: { type: "string" },
    sourceRevision: { type: "string" },
    created: { type: "boolean" },
  },
};

export const STAGE_PARAMETERS: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["candidateId", "proposalId", "sourceDir"],
  properties: {
    candidateId: { type: "string" },
    proposalId: { type: "string" },
    sourceDir: { type: "string", description: "Artifact source directory inside the owning session workspace." },
  },
};

function render(_args: unknown, value: JsonValue): ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

function card(title: string) {
  return (args: unknown) => ({ card: "generic" as const, title, kind: "other" as const, rawInput: args as JsonValue });
}

async function resultFor(ctx: Context, candidateId: string, eventId: string) {
  const projection = await ctx.chopinEvolution.events.fold();
  const candidate = projection.candidates.find((item) => item.id === candidateId);
  if (candidate === undefined) throw new Error(`candidate ${candidateId} disappeared after ${eventId}`);
  return { candidateId, state: candidate.state, eventId };
}

function actorId(exec: Parameters<ToolDefinition["execute"]>[1]): string {
  if (exec.agent === undefined) throw new Error("evolution authoring requires an owning agent session");
  return exec.agent.id;
}

function listTool(ctx: Context): ToolDefinition {
  return {
    name: AUTHORING_TOOL_NAMES[0],
    description: "List compact evolution candidate state. Evidence bodies and artifact content are never returned.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: { state: { type: "string", enum: CANDIDATE_STATES } },
    },
    output: { schema: CANDIDATE_LIST_OUTPUT, render },
    async execute(args) {
      const { state } = args as { state?: CandidateState };
      const candidates = summarizeCandidates(await ctx.chopinEvolution.events.fold(), state);
      return { count: candidates.length, candidates };
    },
    presentCall: card(AUTHORING_TOOL_NAMES[0]),
  };
}

function candidateReadTool(ctx: Context): ToolDefinition {
  return {
    name: "evolution_candidate_read",
    description: "Read one candidate's proposed requirements and bounded, scrubbed evidence before classifying or repairing it. Root-cause text is a proposed explanation, not independent verification. Use proposalId to select an older proposal named in the queue; never read raw session logs for this.",
    parameters: {
      type: "object", additionalProperties: false, required: ["candidateId"],
      properties: { candidateId: { type: "string" }, proposalId: { type: "string" } },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false, required: ["candidateId", "state", "lesson", "rootCause", "proposals", "evidence"],
        properties: {
          candidateId: { type: "string" }, state: { type: "string" }, lesson: { type: "string" }, rootCause: { type: "string" },
          proposals: { type: "array", items: PROPOSAL_ITEMS },
          evidence: { type: "array", items: {
            type: "object", additionalProperties: false, required: ["class", "summary", "sourceRef"],
            properties: { class: { type: "string" }, summary: { type: "string" }, sourceRef: { type: "string" } },
          } },
        },
      },
      render,
    },
    async execute(args) {
      const { candidateId, proposalId } = args as { candidateId: string; proposalId?: string };
      const candidate = (await ctx.chopinEvolution.events.fold()).candidates.find((item) => item.id === candidateId);
      if (candidate === undefined) throw new Error(`unknown candidate ${candidateId}`);
      const proposals = proposalId === undefined ? candidate.proposals.slice(-8)
        : candidate.proposals.filter((proposal) => proposal.proposalId === proposalId);
      if (proposalId !== undefined && proposals.length === 0) throw new Error(`unknown proposal ${proposalId}`);
      return {
        candidateId, state: candidate.state, lesson: candidate.lesson, rootCause: candidate.rootCause ?? "", proposals,
        evidence: candidate.evidence.slice(-3).map((evidence) => ({ class: evidence.class, summary: evidence.summary, sourceRef: evidence.sourceRef ?? "" })),
      };
    },
    presentCall: card("evolution_candidate_read"),
  };
}

function corroborateTool(ctx: Context): ToolDefinition {
  return {
    name: AUTHORING_TOOL_NAMES[1],
    description: "Corroborate an observed candidate after its independent host evidence threshold is satisfied.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["candidateId", "rootCause", "trigger", "boundaries"],
      properties: {
        candidateId: { type: "string" },
        rootCause: { type: "string" },
        trigger: { type: "object", additionalProperties: false, required: [], properties: TRIGGER_PROPERTIES },
        boundaries: {
          type: "object",
          additionalProperties: false,
          required: ["includes", "excludes"],
          properties: {
            includes: { type: "array", items: { type: "string" } },
            excludes: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    output: { schema: CANDIDATE_OUTPUT, render },
    async execute(args, exec) {
      const input = args as { candidateId: string; rootCause: string; trigger: ApplicabilityTrigger; boundaries: CandidateBoundaries };
      const event = candidateCorroborated({ candidateId: input.candidateId, actor: { kind: "agent", id: actorId(exec) } }, input);
      await ctx.chopinEvolution.events.append(event);
      return resultFor(ctx, input.candidateId, event.eventId);
    },
    presentCall: card(AUTHORING_TOOL_NAMES[1]),
  };
}

const PROPOSAL_ITEMS: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: ["proposalId", "kind", "intendedEffect", "summary", "trigger", "requiredPermissions"],
  properties: {
    proposalId: { type: "string" },
    kind: { type: "string", enum: ["memory", "skill", "gate", "tool", "plugin"] },
    intendedEffect: { type: "string", enum: ["advisory", "preventive"] },
    summary: { type: "string" },
    trigger: { type: "object", additionalProperties: false, required: [], properties: TRIGGER_PROPERTIES },
    requiredPermissions: { type: "array", items: { type: "string" } },
  },
};

function classifyTool(ctx: Context): ToolDefinition {
  return {
    name: AUTHORING_TOOL_NAMES[2],
    description: "Classify one corroborated candidate into one or more least-authority capability proposals.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["candidateId", "proposals"],
      properties: {
        candidateId: { type: "string" },
        proposals: { type: "array", items: PROPOSAL_ITEMS },
      },
    },
    output: { schema: CANDIDATE_OUTPUT, render },
    async execute(args, exec) {
      const { candidateId, proposals } = args as { candidateId: string; proposals: ArtifactProposal[] };
      const event = candidateClassified({ candidateId, actor: { kind: "agent", id: actorId(exec) } }, proposals);
      await ctx.chopinEvolution.events.append(event);
      return resultFor(ctx, candidateId, event.eventId);
    },
    presentCall: card(AUTHORING_TOOL_NAMES[2]),
  };
}

function rejectTool(ctx: Context): ToolDefinition {
  return {
    name: AUTHORING_TOOL_NAMES[3],
    description: "Reject a non-terminal candidate with an auditable reason.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["candidateId", "reason"],
      properties: { candidateId: { type: "string" }, reason: { type: "string" } },
    },
    output: { schema: CANDIDATE_OUTPUT, render },
    async execute(args, exec) {
      const { candidateId, reason } = args as { candidateId: string; reason: string };
      const event = candidateRejected({ candidateId, actor: { kind: "agent", id: actorId(exec) } }, reason);
      await ctx.chopinEvolution.events.append(event);
      return resultFor(ctx, candidateId, event.eventId);
    },
    presentCall: card(AUTHORING_TOOL_NAMES[3]),
  };
}

function mergeTool(ctx: Context): ToolDefinition {
  return {
    name: AUTHORING_TOOL_NAMES[4],
    description: "Merge a non-terminal candidate into an existing canonical candidate.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["candidateId", "into"],
      properties: { candidateId: { type: "string" }, into: { type: "string" } },
    },
    output: { schema: CANDIDATE_OUTPUT, render },
    async execute(args, exec) {
      const { candidateId, into } = args as { candidateId: string; into: string };
      const projection = await ctx.chopinEvolution.events.fold();
      if (!projection.candidates.some((candidate) => candidate.id === into)) throw new Error(`merge target ${into} does not exist`);
      const event = candidateMerged({ candidateId, actor: { kind: "agent", id: actorId(exec) } }, into);
      await ctx.chopinEvolution.events.append(event);
      return resultFor(ctx, candidateId, event.eventId);
    },
    presentCall: card(AUTHORING_TOOL_NAMES[4]),
  };
}

function stageTool(ctx: Context): ToolDefinition {
  return {
    name: AUTHORING_TOOL_NAMES[5],
    description:
      "Stage one classified proposal from a sourceDir inside this session workspace. The host computes CAS and source revision; "
      + "the caller cannot supply either digest or revision.",
    parameters: STAGE_PARAMETERS,
    output: { schema: STAGE_OUTPUT, render },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error("evolution_artifact_stage requires an owning agent session");
      const cwd = exec.agent.session.header.cwd;
      if (cwd === undefined) throw new Error("owning agent session has no cwd");
      const input = args as { candidateId: string; proposalId: string; sourceDir: string };
      const staged = await stageArtifactFromCandidate({
        eventStore: ctx.chopinEvolution.events,
        artifactStore: ctx.chopinEvolution.artifacts,
        cwd,
        sourceDir: input.sourceDir,
        candidateId: input.candidateId,
        proposalId: input.proposalId,
        actor: { kind: "agent", id: exec.agent.id },
      });
      if (ctx.chopinEvolution.autonomous) await ctx.chopinEvolution.advance();
      return staged;
    },
    presentCall: card(AUTHORING_TOOL_NAMES[5]),
  };
}

const OUTCOME_ITEMS: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: ["proposalId", "status"],
  properties: {
    proposalId: { type: "string" },
    status: { type: "string", enum: ["activated", "rejected"] },
    artifactId: { type: "string" },
    contentDigest: { type: "string" },
    deploymentEventId: { type: "string" },
    reason: { type: "string" },
  },
};

function resolveTool(ctx: Context): ToolDefinition {
  return {
    name: AUTHORING_TOOL_NAMES[6],
    description:
      "Resolve every classified proposal. Activated outcomes must cite an existing earlier successful canary/active deployment event; "
      + "the authoritative event-store fold rejects invented references.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["candidateId", "outcomes"],
      properties: {
        candidateId: { type: "string" },
        outcomes: { type: "array", items: OUTCOME_ITEMS },
      },
    },
    output: { schema: CANDIDATE_OUTPUT, render },
    async execute(args, exec) {
      const { candidateId, outcomes } = args as { candidateId: string; outcomes: ProposalOutcome[] };
      const event = candidateResolved({ candidateId, actor: { kind: "agent", id: actorId(exec) } }, outcomes);
      await ctx.chopinEvolution.events.append(event);
      return resultFor(ctx, candidateId, event.eventId);
    },
    presentCall: card(AUTHORING_TOOL_NAMES[6]),
  };
}

const CORRECTION_OUTPUT: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: ["candidateId", "outcome", "eventId", "artifactId", "artifactState", "enabled"],
  properties: {
    candidateId: { type: "string" },
    outcome: { type: "string", enum: ["allowed-once", "rejected", "cancelled", "unavailable"] },
    eventId: { type: "string" },
    artifactId: { type: "string" },
    artifactState: { type: "string" },
    enabled: { type: "boolean" },
    authorization: { type: "string", enum: ["user", "policy"] },
  },
};

function correctionTool(ctx: Context): ToolDefinition {
  return {
    name: AUTHORING_TOOL_NAMES[7],
    description:
      "Record a reusable lesson from the user's latest correction or explicit request to remember it. Managed lessons are authorized by host policy "
      + "without an approval prompt, verified and available from the next step. The source message is preserved as "
      + "evidence separately from the proposed lesson. Reuse the same slug when updating a lesson; do not record secrets.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["slug", "lesson", "when", "scope"],
      properties: {
        slug: { type: "string", maxLength: 128, description: "For updates, use the exact existing experience identifier shown in context. For a new lesson, use a short kebab-case key." },
        scope: { type: "string", enum: ["global", "workspace"], description: "Use global only for explicitly general user preferences or reusable methods; workspace for project-specific conventions. The host binds the actual working directory." },
        lesson: { type: "string", description: "What to do differently, in behavioral terms, at most 500 characters." },
        when: {
          type: "string",
          description: `One line naming the action and the surface it applies to, e.g. "deploying to staging or creating a deploy branch"; at most ${TRIGGER_WHEN_MAX_CHARS} characters.`,
        },
      },
    },
    output: {
      schema: CORRECTION_OUTPUT,
      render: (_args, value) => {
        const result = value as unknown as { candidateId: string; outcome: string; eventId: string; artifactId: string; artifactState: string; enabled: boolean; authorization?: string };
        const text = result.outcome === "allowed-once"
          ? `Correction recorded as ${result.candidateId}; memory ${result.artifactId} is ${result.artifactState}, ${result.enabled ? "eligible for automatic context loading" : "not currently effective"}; authorization=${result.authorization}.`
          : `Correction not recorded: approval outcome was ${result.outcome}.`;
        return [{ type: "text", text }];
      },
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error("evolution_correction_record requires an owning agent session");
      const input = args as { slug: string; lesson: string; when: string; scope: "global" | "workspace" };
      const result = await ctx.chopinEvolution.recordUserCorrection(exec.agent, exec.callId, input);
      return {
        candidateId: result.candidateId,
        outcome: result.outcome,
        eventId: result.eventId ?? "",
        artifactId: result.artifactId ?? "",
        artifactState: result.artifactState ?? "",
        enabled: result.enabled ?? false,
        ...(result.authorization === undefined ? {} : { authorization: result.authorization }),
      };
    },
    presentCall: card(AUTHORING_TOOL_NAMES[7]),
  };
}

function experienceTool(ctx: Context): ToolDefinition {
  return {
    name: "evolution_experience_record",
    description: "Only after a successful gated delivery, automatically save one reusable memory or procedural skill. For a direct user request to remember something, use evolution_correction_record. Reuse a slug to update one managed entry; identical content is reused. Body contains the procedure, not a transcript. Never change user-authored skills or host rules. Summarize the actual result once.",
    parameters: {
      type: "object", additionalProperties: false, required: ["slug", "lesson", "when", "kind", "scope"],
      properties: {
        slug: { type: "string", maxLength: 128, description: "For updates, use the exact existing experience identifier shown in context. For a new lesson, use a short kebab-case key." },
        scope: { type: "string", enum: ["global", "workspace"], description: "Use workspace for project-specific knowledge; global only for methods that genuinely generalize across projects. The host binds the actual working directory." },
        lesson: { type: "string", description: "One-sentence reusable lesson, at most 500 characters." },
        when: { type: "string", description: `Applicability, at most ${TRIGGER_WHEN_MAX_CHARS} characters.` },
        kind: { type: "string", enum: ["memory", "skill"] },
        body: { type: "string", description: "Complete reusable instructions, at most 12000 characters. Defaults to the lesson." },
      },
    },
    output: { schema: CORRECTION_OUTPUT, render },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error("experience capture requires an owning session");
      const input = args as { slug: string; lesson: string; when: string; kind: "memory" | "skill"; scope: "global" | "workspace"; body?: string };
      const result = await ctx.chopinEvolution.recordExperience(exec.agent, exec.callId, { ...input, source: "completion" });
      return {
        candidateId: result.candidateId, outcome: result.outcome, eventId: result.eventId ?? "", artifactId: result.artifactId ?? "",
        artifactState: result.artifactState ?? "", enabled: result.enabled ?? false,
        ...(result.authorization === undefined ? {} : { authorization: result.authorization }),
      };
    },
    presentCall: card("evolution_experience_record"),
  };
}

const QUEUE_OUTPUT: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: ["count", "items"],
  properties: {
    count: { type: "integer" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "id", "detail"],
        properties: {
          action: { type: "string", enum: ["corroborate", "classify", "stage", "approve", "fix", "retry"] },
          id: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
  },
};

function queueTool(ctx: Context): ToolDefinition {
  return {
    name: AUTHORING_TOOL_NAMES[8],
    description:
      "List the self-improvement work only you or the user can do: candidates ready to corroborate or classify, "
      + "proposals waiting to be staged, artifacts waiting for approval, artifacts whose verification failed. Everything "
      + "else (verification, installation, canary, activation, rollback, retirement) the host advances on its own.",
    parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
    output: {
      schema: QUEUE_OUTPUT,
      render: (_args, value) => {
        const result = value as unknown as { count: number; items: EvolutionQueueItem[] };
        return [{ type: "text", text: result.count === 0 ? "The evolution queue is empty." : renderEvolutionQueue(result.items, 50) }];
      },
    },
    async execute() {
      const items = evolutionQueue(await ctx.chopinEvolution.events.fold());
      return { count: items.length, items };
    },
    presentCall: card(AUTHORING_TOOL_NAMES[8]),
  };
}

export function authoringTools(ctx: Context): ToolDefinition[] {
  return [
    listTool(ctx),
    corroborateTool(ctx),
    classifyTool(ctx),
    rejectTool(ctx),
    mergeTool(ctx),
    stageTool(ctx),
    resolveTool(ctx),
    correctionTool(ctx),
    queueTool(ctx),
    experienceTool(ctx),
    candidateReadTool(ctx),
  ];
}

export function apply(ctx: Context): void {
  for (const tool of authoringTools(ctx)) ctx.tools.register(tool);
}
