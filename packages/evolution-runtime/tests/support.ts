import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
  ArtifactStore,
  artifactActivated,
  artifactApproved,
  artifactBuilt,
  artifactCanaryActivated,
  artifactDeploymentRequested,
  artifactDrafted,
  artifactInstalledDisabled,
  artifactVerified,
} from "@chopin/evolution";
import type { ApplicabilityTrigger, CapabilityManifest, EvolutionEvent } from "@chopin/evolution";
import { approvalReceipt, deploymentReceipt, deploymentRequest, verificationReceipt } from "../../evolution/tests/receipt-fixtures.js";

import { ChopinEvolution } from "../src/index.js";

const temporaryDirectories: string[] = [];

export async function temporaryDirectory(prefix = "chopin-runtime-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

export async function cleanupTemporaryDirectories(): Promise<void> {
  if (process.env.CHOPIN_RETAIN_TEST_OUTPUT === "1") {
    temporaryDirectories.length = 0;
    return;
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}

export function dataManifest(
  id: string,
  options: { kind?: "memory" | "skill"; trigger?: ApplicabilityTrigger; summary?: string; candidateId?: string } = {},
): CapabilityManifest {
  const kind = options.kind ?? "memory";
  return {
    schemaVersion: 1,
    id,
    version: "1.0.0",
    kind,
    runtime: "data",
    intendedEffect: "advisory",
    summary: options.summary ?? `Capability ${id}`,
    entry: "content.md",
    trigger: options.trigger ?? { repos: ["chopin"] },
    provides: { contexts: kind === "memory" ? [id] : [], skills: kind === "skill" ? [id] : [], guards: [], tools: [], services: [], workflows: [] },
    permissions: [],
    dependencies: [],
    conflicts: [],
    requires: { chopinPluginApi: "^1.0.0" },
    lineage: { candidateIds: [options.candidateId ?? `candidate-${id}`], proposalIds: [`proposal-${id}`] },
  };
}

export function gateManifest(id: string, candidateId = `candidate-${id}`): CapabilityManifest {
  return {
    schemaVersion: 1,
    id,
    version: "1.0.0",
    kind: "gate",
    runtime: "dsh-plugin",
    intendedEffect: "preventive",
    summary: `Gate ${id}`,
    entry: "index.js",
    trigger: { repos: ["chopin"] },
    provides: { contexts: [], skills: [], guards: [id], tools: [], services: [], workflows: [] },
    permissions: ["tools:guard"],
    dependencies: [],
    conflicts: [],
    requires: { chopinPluginApi: "^1.0.0", dsh: "0.1.1-rc.2" },
    lineage: { candidateIds: [candidateId], proposalIds: [`proposal-${id}`] },
  };
}

export type Staged = Awaited<ReturnType<ArtifactStore["stage"]>>;

export async function stageArtifact(root: string, value: CapabilityManifest, content: string): Promise<Staged> {
  const source = join(root, `source-${value.id}-${value.version}`);
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "capability.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeFile(join(source, value.entry), content, "utf8");
  return new ArtifactStore(join(root, "artifacts")).stage(source);
}

/** Event sequence all the way to active; deployedAt fixes that the feedback window only covers what came after it. */
export function lifecycle(staged: Staged, deployedAt = "2026-08-31T00:00:00.000Z"): EvolutionEvent[] {
  const artifactId = `${staged.manifest.id}:${staged.manifest.version}`;
  const binding = { artifactId, ...staged };
  const active = { ...deploymentReceipt(binding, "active"), startedAt: deployedAt, endedAt: deployedAt };
  return [
    artifactDrafted({ artifactId }, {
      manifest: staged.manifest,
      contentDigest: staged.contentDigest,
      manifestDigest: staged.manifestDigest,
      surfaceDigest: staged.surfaceDigest,
    }),
    artifactBuilt({ artifactId }, {
      contentDigest: staged.contentDigest,
      manifestDigest: staged.manifestDigest,
      surfaceDigest: staged.surfaceDigest,
      sourceRevision: "git:0123456789abcdef",
    }),
    artifactVerified({ artifactId }, verificationReceipt(binding)),
    artifactApproved({ artifactId }, approvalReceipt(binding)),
    artifactDeploymentRequested({ artifactId }, deploymentRequest(binding, "disabled")),
    artifactInstalledDisabled({ artifactId }, deploymentReceipt(binding, "disabled")),
    artifactDeploymentRequested({ artifactId }, deploymentRequest(binding, "canary")),
    artifactCanaryActivated({ artifactId }, deploymentReceipt(binding, "canary")),
    artifactDeploymentRequested({ artifactId }, deploymentRequest(binding, "active")),
    artifactActivated({ artifactId }, active),
  ];
}

export function evolutionService(ctx: Context, root: string): ChopinEvolution {
  return new ChopinEvolution(ctx, {
    eventsFile: join(root, "events.jsonl"),
    artifactsDir: join(root, "artifacts"),
    receiptsDir: join(root, "receipts"),
    chopinVersion: "0.1.0",
    dshVersion: "0.1.1-rc.2",
    processGeneration: "runtime-test-generation",
    autonomous: false,
  });
}

let sequence = 0;

export function userMessage(text: string, timeMs: number): SessionEvent {
  sequence += 1;
  return {
    type: "user/message",
    seq: sequence,
    time: timeMs,
    data: { id: `user-${sequence}`, source: { kind: "user" }, content: [{ type: "text", text }] },
  } as unknown as SessionEvent;
}

export function toolCall(callId: string, name: string, timeMs: number, args = "{}"): SessionEvent {
  sequence += 1;
  return { type: "tool/call", seq: sequence, time: timeMs, data: { turn: 1, step: 1, callId, name, arguments: args } } as unknown as SessionEvent;
}

export function toolResult(callId: string, timeMs: number, options: { isError?: boolean; text?: string } = {}): SessionEvent {
  sequence += 1;
  return {
    type: "tool/result",
    seq: sequence,
    time: timeMs,
    data: {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: ToolCallId(callId), isError: options.isError === true, content: [{ type: "text", text: options.text ?? "ok" }] }),
    },
  } as unknown as SessionEvent;
}

export function turnEnd(turn: number, timeMs: number): Extract<SessionEvent, { type: "turn/end" }> {
  sequence += 1;
  return { type: "turn/end", seq: sequence, time: timeMs, data: { turn, reason: { kind: "stop" } } } as unknown as Extract<SessionEvent, { type: "turn/end" }>;
}

export function fakeAgent(sessionId: string, events: SessionEvent[], cwd = "/tmp/chopin"): Agent {
  return { id: "main", session: { id: sessionId, header: { cwd }, snapshotEvents: () => [...events] } } as unknown as Agent;
}
