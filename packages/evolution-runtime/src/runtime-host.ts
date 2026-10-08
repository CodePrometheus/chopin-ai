import type { ArtifactStore, EvolutionEventStore } from "@chopin/evolution";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";

export interface ArtifactHost {
  readonly events: EvolutionEventStore;
  readonly artifacts: ArtifactStore;
  readonly receiptsDir: string;
  readonly chopinVersion: string;
  readonly dshVersion: string;
  readonly processGeneration: string;
  readonly autonomous: boolean;
  requestAuditedApproval(agent: Agent, callId: ToolCallId, toolName: string, reason: string):
    Promise<{ outcome: ApprovalOutcome; auditId?: string; decidedAt?: string }>;
}
