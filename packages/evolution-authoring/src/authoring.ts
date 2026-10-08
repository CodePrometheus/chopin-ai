import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  artifactBuilt,
  artifactDrafted,
  artifactVersionId,
  assertCapabilityManifest,
  canonicalJson,
} from "@chopin/evolution";
import type {
  ArtifactProposal,
  ArtifactStore,
  CandidateProjection,
  CandidateState,
  CapabilityManifest,
  EvolutionActor,
  EvolutionEventStore,
  EvolutionProjection,
} from "@chopin/evolution";

const executeFile = promisify(execFile);
const CONTENT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const GIT_HEAD = /^[a-f0-9]{40,64}$/;

export class EvolutionAuthoringError extends Error {
  constructor(message: string) {
    super(`evolution authoring: ${message}`);
    this.name = "EvolutionAuthoringError";
  }
}

export interface CandidateSummary {
  id: string;
  state: CandidateState;
  trustedIndependentUnits: number;
  proposalCount: number;
  updatedAt: string;
}

export interface StagedArtifactSummary {
  artifactId: string;
  contentDigest: string;
  manifestDigest: string;
  surfaceDigest: string;
  sourceRevision: string;
  created: boolean;
}

export type GitHeadReader = (sourceDirectory: string) => Promise<string | undefined>;

export function summarizeCandidates(
  projection: EvolutionProjection,
  state?: CandidateState,
): CandidateSummary[] {
  return projection.candidates
    .filter((candidate) => state === undefined || candidate.state === state)
    .map((candidate) => ({
      id: candidate.id,
      state: candidate.state,
      trustedIndependentUnits: candidate.trustedIndependentUnits,
      proposalCount: candidate.proposals.length,
      updatedAt: candidate.updatedAt,
    }));
}

function exact(value: unknown, expected: unknown, name: string): void {
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new EvolutionAuthoringError(`${name} differs from classified proposal`);
  }
}

/** Pure contract check: authoring may not let an artifact escalate permissions or rewrite the proposal's applicability. */
export function assertProposalMatchesManifest(
  candidate: CandidateProjection,
  proposalId: string,
  manifest: CapabilityManifest,
): ArtifactProposal {
  assertCapabilityManifest(manifest);
  if (candidate.state !== "classified") {
    throw new EvolutionAuthoringError(`candidate ${candidate.id} is ${candidate.state}, not classified`);
  }
  const proposal = candidate.proposals.find((item) => item.proposalId === proposalId);
  if (proposal === undefined) throw new EvolutionAuthoringError(`candidate ${candidate.id} has no proposal ${proposalId}`);
  exact(manifest.lineage.candidateIds, [candidate.id], "manifest lineage.candidateIds");
  exact(manifest.lineage.proposalIds, [proposal.proposalId], "manifest lineage.proposalIds");
  if (manifest.kind !== proposal.kind) throw new EvolutionAuthoringError("manifest kind differs from classified proposal");
  if (manifest.intendedEffect !== proposal.intendedEffect) {
    throw new EvolutionAuthoringError("manifest intendedEffect differs from classified proposal");
  }
  exact(manifest.trigger, proposal.trigger, "manifest trigger");
  exact(manifest.permissions, proposal.requiredPermissions, "manifest permissions");
  exact(manifest.lineage.improvementId ?? null, proposal.improvementId ?? null, "improvement origin");
  return proposal;
}

/** Judge containment after realpath; a symlink inside the directory pointing outside the workspace is rejected too. */
export async function resolveOwnedSourceDirectory(cwd: string, sourceDirectory: string): Promise<string> {
  if (cwd.trim() === "" || sourceDirectory.trim() === "") throw new EvolutionAuthoringError("cwd and sourceDir must be non-empty");
  const workspace = await realpath(cwd);
  const source = await realpath(resolve(workspace, sourceDirectory));
  const rel = relative(workspace, source);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new EvolutionAuthoringError(`sourceDir escapes owning workspace: ${sourceDirectory}`);
  }
  if (!(await stat(source)).isDirectory()) throw new EvolutionAuthoringError(`sourceDir is not a directory: ${sourceDirectory}`);
  return source;
}

export async function readAuthoringManifest(sourceDirectory: string): Promise<CapabilityManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(sourceDirectory, "capability.json"), "utf8"));
  } catch (error) {
    throw new EvolutionAuthoringError(`cannot read capability.json: ${(error as Error).message}`);
  }
  assertCapabilityManifest(parsed);
  return parsed;
}

export function formatHostSourceRevision(contentDigest: string, gitHead?: string): string {
  if (!CONTENT_DIGEST.test(contentDigest)) throw new EvolutionAuthoringError("contentDigest must be sha256:<hex>");
  if (gitHead === undefined) return `host:no-git@${contentDigest}`;
  const normalized = gitHead.trim().toLowerCase();
  if (!GIT_HEAD.test(normalized)) throw new EvolutionAuthoringError("git HEAD is not a full object id");
  return `git:${normalized}@${contentDigest}`;
}

async function readGitHead(sourceDirectory: string): Promise<string | undefined> {
  try {
    const result = await executeFile("git", ["-C", sourceDirectory, "rev-parse", "--verify", "HEAD"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    const head = result.stdout.trim().toLowerCase();
    return GIT_HEAD.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

export async function deriveHostSourceRevision(
  sourceDirectory: string,
  contentDigest: string,
  gitHeadReader: GitHeadReader = readGitHead,
): Promise<string> {
  return formatHostSourceRevision(contentDigest, await gitHeadReader(sourceDirectory));
}

function findCandidate(projection: EvolutionProjection, candidateId: string): CandidateProjection {
  const candidate = projection.candidates.find((item) => item.id === candidateId);
  if (candidate === undefined) throw new EvolutionAuthoringError(`unknown candidate ${candidateId}`);
  return candidate;
}

function existingSummary(
  projection: EvolutionProjection,
  artifactId: string,
  contentDigest: string,
  manifestDigest: string,
  surfaceDigest: string,
): StagedArtifactSummary | undefined {
  const artifact = projection.artifacts.find((item) => item.id === artifactId);
  if (artifact === undefined) return undefined;
  if (artifact.contentDigest !== contentDigest || artifact.manifestDigest !== manifestDigest || artifact.surfaceDigest !== surfaceDigest) {
    throw new EvolutionAuthoringError(`artifact version ${artifactId} already exists with different content`);
  }
  if (artifact.sourceRevision === undefined) throw new EvolutionAuthoringError(`artifact ${artifactId} exists without a built source revision`);
  return {
    artifactId,
    contentDigest,
    manifestDigest,
    surfaceDigest,
    sourceRevision: artifact.sourceRevision,
    created: false,
  };
}

export async function stageArtifactFromCandidate(input: {
  eventStore: EvolutionEventStore;
  artifactStore: ArtifactStore;
  cwd: string;
  sourceDir: string;
  candidateId: string;
  proposalId: string;
  actor: EvolutionActor;
  gitHeadReader?: GitHeadReader;
}): Promise<StagedArtifactSummary> {
  const sourceDirectory = await resolveOwnedSourceDirectory(input.cwd, input.sourceDir);
  const sourceManifest = await readAuthoringManifest(sourceDirectory);
  const initial = await input.eventStore.fold();
  assertProposalMatchesManifest(findCandidate(initial, input.candidateId), input.proposalId, sourceManifest);

  const staged = await input.artifactStore.stage(sourceDirectory);
  const latest = await input.eventStore.fold();
  assertProposalMatchesManifest(findCandidate(latest, input.candidateId), input.proposalId, staged.manifest);
  const artifactId = artifactVersionId(staged.manifest);
  const existing = existingSummary(latest, artifactId, staged.contentDigest, staged.manifestDigest, staged.surfaceDigest);
  if (existing !== undefined) return existing;

  const sourceRevision = await deriveHostSourceRevision(sourceDirectory, staged.contentDigest, input.gitHeadReader);
  const events = [
    artifactDrafted({ artifactId, actor: input.actor }, {
      manifest: staged.manifest,
      contentDigest: staged.contentDigest,
      manifestDigest: staged.manifestDigest,
      surfaceDigest: staged.surfaceDigest,
    }),
    artifactBuilt({ artifactId, actor: input.actor }, {
      contentDigest: staged.contentDigest,
      manifestDigest: staged.manifestDigest,
      surfaceDigest: staged.surfaceDigest,
      sourceRevision,
    }),
  ];
  try {
    await input.eventStore.appendMany(events);
  } catch (error) {
    const raced = existingSummary(
      await input.eventStore.fold(),
      artifactId,
      staged.contentDigest,
      staged.manifestDigest,
      staged.surfaceDigest,
    );
    if (raced !== undefined) return raced;
    throw error;
  }
  return {
    artifactId,
    contentDigest: staged.contentDigest,
    manifestDigest: staged.manifestDigest,
    surfaceDigest: staged.surfaceDigest,
    sourceRevision,
    created: true,
  };
}
