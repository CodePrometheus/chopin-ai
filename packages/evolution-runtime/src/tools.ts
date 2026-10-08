import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { JsonSchemaNode, ToolDefinition } from "@deepseek-ai/dsh-tools";

import { EXPERIENCE_READ_TOOL } from "./render.js";
import { improverTools } from "./improver-tools.js";

type JsonValue = Parameters<ToolDefinition["output"]["render"]>[1];

export const name = "chopin-evolution-tools";
export const inject = ["tools", "chopinEvolution"];

// The model may request user approval and read experiences; successful deployments advance automatically, failed retries need separate authorization.

const APPROVAL_OUTPUT: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: ["artifactId", "contentDigest", "outcome", "receiptId"],
  properties: {
    artifactId: { type: "string" },
    contentDigest: { type: "string" },
    outcome: { type: "string", enum: ["allowed-once", "rejected", "cancelled", "unavailable"] },
    receiptId: { type: "string" },
  },
};

const READ_OUTPUT: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: ["artifactId", "contentDigest", "kind", "summary", "body"],
  properties: {
    artifactId: { type: "string" },
    contentDigest: { type: "string" },
    kind: { type: "string", enum: ["memory", "skill"] },
    when: { type: "string" },
    summary: { type: "string" },
    body: { type: "string" },
  },
};

function render(_args: unknown, value: JsonValue): ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

function renderExperience(_args: unknown, value: JsonValue): ContentBlock[] {
  const result = value as unknown as { artifactId: string; kind: string; when?: string; summary: string; body: string };
  const header = [
    `### ${result.artifactId} (${result.kind})`,
    ...(result.when === undefined ? [] : [`when: ${result.when}`]),
    result.summary,
  ].join("\n");
  return [{ type: "text", text: `${header}\n\n${result.body}` }];
}

function card(title: string) {
  return (args: unknown) => ({ card: "generic" as const, title, kind: "other" as const, rawInput: args as JsonValue });
}

function approvalTool(ctx: Context): ToolDefinition {
  return {
    name: "evolution_approve",
    description:
      "Authorize one exact verified capability digest. Managed capabilities use host policy without prompting; "
      + "requests outside that policy require explicit user authorization. The host installs it, "
      + "runs the canary and activates it on its own; you do not drive those steps. Changing code, permissions or "
      + "capability surface invalidates this approval. Rejection never mutates artifact state.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["artifactId", "contentDigest"],
      properties: {
        artifactId: { type: "string", description: "Exact <capability-id>:<version>." },
        contentDigest: { type: "string", description: "Exact sha256 digest shown in the evolution queue." },
      },
    },
    output: { schema: APPROVAL_OUTPUT, render },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error("evolution_approve requires an owning agent session");
      const { artifactId, contentDigest } = args as { artifactId: string; contentDigest: string };
      const result = await ctx.chopinEvolution.approveArtifact(exec.agent, exec.callId, artifactId, contentDigest);
      if (result.outcome === "allowed-once") await ctx.chopinEvolution.advance();
      return { artifactId, contentDigest, outcome: result.outcome, receiptId: result.receipt?.receiptId ?? "" };
    },
    presentCall: card("evolution_approve"),
  };
}

function readTool(ctx: Context): ToolDefinition {
  return {
    name: EXPERIENCE_READ_TOOL,
    description:
      "Read an approved experience whose full text is not loaded. Full experience blocks already contain the complete "
      + "lesson: use them directly without re-reading. Loading and explicit reads are recorded automatically; neither proves benefit.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["artifactId"],
      properties: {
        artifactId: { type: "string", description: "Exact version ID from the index, or the exact name in a Full experience block. Names resolve only to the version exposed in this request." },
      },
    },
    output: { schema: READ_OUTPUT, render: renderExperience },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error(`${EXPERIENCE_READ_TOOL} requires an owning agent session`);
      const { artifactId } = args as { artifactId: string };
      return ctx.chopinEvolution.readExperience(exec.agent, exec.callId, artifactId);
    },
    presentCall: card(EXPERIENCE_READ_TOOL),
  };
}

function retryTool(ctx: Context): ToolDefinition {
  return {
    name: "evolution_deployment_retry",
    description: "Retry an exact failed deployment. Managed capabilities receive at most one automatic policy retry per deployment mode. On another failure, stage a corrected version instead of repeatedly retrying. Permission expansion still requires user authorization.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["artifactId", "contentDigest", "failureReceiptId"],
      properties: {
        artifactId: { type: "string" },
        contentDigest: { type: "string" },
        failureReceiptId: { type: "string" },
      },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        required: ["artifactId", "outcome", "requestId", "receiptId"],
        properties: {
          artifactId: { type: "string" },
          outcome: { type: "string", enum: ["allowed-once", "rejected", "cancelled", "unavailable"] },
          requestId: { type: "string" },
          receiptId: { type: "string" },
        },
      },
      render,
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error("evolution_deployment_retry requires an owning agent session");
      const { artifactId, contentDigest, failureReceiptId } = args as { artifactId: string; contentDigest: string; failureReceiptId: string };
      const result = await ctx.chopinEvolution.retryDeployment(exec.agent, exec.callId, artifactId, contentDigest, failureReceiptId);
      if (result.outcome === "allowed-once") await ctx.chopinEvolution.advance();
      return { artifactId, outcome: result.outcome, requestId: result.request?.requestId ?? "", receiptId: result.receipt?.receiptId ?? "" };
    },
    presentCall: card("evolution_deployment_retry"),
  };
}

export function apply(ctx: Context): void {
  ctx.tools.register(approvalTool(ctx));
  ctx.tools.register(readTool(ctx));
  ctx.tools.register(retryTool(ctx));
  for (const tool of improverTools(ctx)) ctx.tools.register(tool);
}
