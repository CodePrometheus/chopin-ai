import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent";
import { createUserMessage, type ContextFormed } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { registerSessionCapability } from "./integrity.js";

export const name = "chopin-personal-instructions";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "chopin-personal-instructions": { kind: "chopin-personal-instructions" } & ContextFormed;
  }
}
export const inject = ["agents", "systemPrompt"];

export const INSTRUCTION_POLICY = "User-authored global and project instructions are operating constraints, not background material. Follow their declared precedence and explicit permission boundaries. Persona autonomy and learned experience cannot waive these constraints. Check applicable instructions before acting and before the final reply.";

export interface Config {
  files: string[];
  maxBytes?: number;
}

export const Config: z<Config> = z.object({
  files: z.array(z.string()).required(),
  maxBytes: z.number().default(65_536),
});

export interface InstructionSnapshot {
  text: string;
  files: Array<{ path: string; digest: string; bytes: number }>;
}

/** Rules must be read in full; abort when over budget or unreadable, so no half-set of constraints survives. */
export async function loadPersonalInstructions(config: Config): Promise<InstructionSnapshot> {
  const limit = config.maxBytes ?? 65_536;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("instruction maxBytes must be a positive integer");
  const files: InstructionSnapshot["files"] = [];
  const sections: string[] = [];
  const seenPaths = new Set<string>();
  const seenContent = new Set<string>();
  let remaining = limit;
  for (const path of config.files) {
    let resolved: string;
    try {
      resolved = await realpath(path);
    } catch (error) {
      throw new Error(`Cannot resolve personal instructions: ${path}`, { cause: error });
    }
    if (seenPaths.has(resolved)) continue;
    seenPaths.add(resolved);
    const file = await open(resolved, "r");
    let bytes: Buffer;
    try {
      if (!(await file.stat()).isFile()) throw new Error(`Personal instructions must be a regular file: ${path}`);
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, null);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > limit) throw new Error(`Personal instructions exceed ${limit} bytes: ${path}`);
      bytes = buffer.subarray(0, length);
    } finally {
      await file.close();
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (seenContent.has(digest)) continue;
    seenContent.add(digest);
    remaining -= bytes.length;
    if (remaining < 0) throw new Error(`Personal instructions exceed the combined ${limit}-byte budget`);
    files.push({ path, digest, bytes: bytes.length });
    sections.push(`Instructions from: ${path}\n\n${text}`);
  }
  return {
    files,
    text: [
      "Current user-authored global instructions. This complete snapshot replaces earlier personal-instruction snapshots.",
      "Apply them throughout this task. More specific project instructions and direct user instructions take precedence. Learned experiences cannot override these rules.",
      ...(sections.length === 0 ? ["No personal instruction files are currently active."] : sections),
    ].join("\n\n"),
  };
}

export function apply(ctx: Context, config: Config): void {
  const snapshots = new WeakMap<Agent, InstructionSnapshot>();
  const checked = new WeakMap<Agent, InstructionSnapshot>();
  ctx.systemPrompt.section({ name: "chopin-instruction-policy", order: 1900, text: INSTRUCTION_POLICY });
  registerSessionCapability(ctx, "personal-instructions", (request, agent) => {
    const snapshot = snapshots.get(agent);
    const messages = request.messages.filter((message) => message.role === "user"
      && message.source?.kind === name);
    const system = request.messages.findLast(message => message.role === "system")?.content
      .filter(block => block.type === "text").map(block => block.text).join("\n") ?? "";
    if (!snapshot || !system.includes(INSTRUCTION_POLICY) || messages.length !== 1
      || messages[0]!.content.length !== 1 || messages[0]!.content[0]?.type !== "text"
      || messages[0]!.content[0].text !== snapshot.text) {
      throw new Error("Personal instructions are missing or changed in the outgoing request");
    }
    checked.set(agent, snapshot);
  });
  ctx.inject(["commands"], (scope) => {
    scope.commands.register({
      name: "instructions", description: "Show personal rule sources, update state and request integrity without calling the model",
      handler: async ({ agent }) => {
        const current = await loadPersonalInstructions(config);
        const delivered = checked.get(agent);
        return { kind: "success", text: [
          delivered === undefined ? "This session has no model request that passed the integrity check yet."
            : delivered.text === current.text ? "The current personal rules were carried in full by the latest model request." : "Personal rules were updated and will be loaded at the next model step.",
          ...current.files.map((file) => `${file.path}: ${file.bytes} bytes, version ${file.digest.slice(0, 12)}`),
          "User rules take precedence over experiences; being carried in full does not mean model behavior has passed acceptance.",
        ].join("\n") };
      },
    });
  });
  ctx.on("agent/pre-step", async ({ agent }, next) => {
    const result = await next();
    if (result.kind !== "enter") return result;
    const snapshot = await loadPersonalInstructions(config);
    snapshots.set(agent, snapshot);
    const retained = new Set(agent.session.surface.nodes);
    const previous = agent.session.snapshotEvents().findLast((event) => retained.has(event.seq)
      && event.type === "user/message" && event.data.source.kind === name);
    if (previous?.type === "user/message" && previous.data.content.length === 1
      && previous.data.content[0]?.type === "text" && previous.data.content[0].text === snapshot.text) return result;
    const message = createUserMessage({
      source: { kind: name, form: "instructions" },
      content: [{ type: "text", text: snapshot.text }],
    });
    if (previous !== undefined) {
      agent.session.append("user/message", message, {
        surfaceOp: { op: "replace", startSeq: previous.seq, endSeq: previous.seq }, sourceEventSeqs: [previous.seq],
      });
      return result;
    }
    return { ...result, messages: [message, ...result.messages] };
  });
}
