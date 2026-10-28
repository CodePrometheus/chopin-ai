import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTool,
  hook,
  section,
  ToolTask,
  type Extension,
  type ToolRegistration,
  type Wrap,
} from "@earendil-works/pi-durable";
import {
  effectiveLayer, gateRefusal, skillBody, unmetGates, type Layer, type LayerVersions, type Skill,
} from "@chopin-ai/core";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, ConversationRecord, DocumentReader, ModelRef, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";

/** The loop's versions a session layers over the hand-written layer: those for every project, and this project's. */
export interface LayerSource {
  global?: LayerVersions;
  project?: LayerVersions;
  /** When true, an item applies on every model, not only those it passed the gate on. */
  anyModel?: boolean;
}

/** The versions a conversation runs with, fixed when it is made so its prompt does not change under it. */
const Pinned = defineDoc<{ global: number; project: number }>({
  kind: "chopin.layer-versions",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ global: -1, project: -1 }),
  checkpointWhen: () => false,
});

/** Pins the versions in use to a conversation made without them; a fork keeps the ones it was copied with. */
export function pinLayerVersions(source: LayerSource): (tx: Tx, conversation: ConversationRecord) => Promise<void> {
  return async (tx, conversation) => {
    const pinned = await tx.doc(Pinned, conversation.id);
    if (pinned.global !== -1) return;
    pinned.global = (await source.global?.current()) ?? 0;
    pinned.project = (await source.project?.current()) ?? 0;
  };
}

/** Tools that have completed successfully in a conversation; a fork sees them as of its fork point. */
const Succeeded = defineDoc<{ tools: string[] }>({
  kind: "chopin.succeeded",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ tools: [] }),
  checkpointWhen: () => false,
});

/**
 * The portable layer as an extension. Skills and instructions are served from here, outside the workspace, so the
 * agent can read them but never edit them; only evaluation changes the layer. A conversation sees the hand-written
 * `layer` with the loop's items for its pinned versions and its model laid over it. A refused call names any required
 * tool missing from `registered`, such as one whose MCP server did not answer.
 */
export function layerExtension(layer: Layer, registered: ReadonlySet<string>, source: LayerSource = {}): Extension {
  const versioned = source.global !== undefined || source.project !== undefined;
  const resolved = new Map<string, Promise<Layer>>();
  // Versions never change once published, so what a conversation resolves to is kept by version and model.
  const layerFor = async (read: DocumentReader, conversation: ConversationId, model: ModelRef | undefined, context: Context) => {
    if (!versioned) return layer;
    const pinned = (await read.snapshot(Pinned, conversation, context)) ?? { global: 0, project: 0 };
    const runner = {
      model: model === undefined ? "" : `${model.provider}/${model.modelId}`,
      harness: "pi",
      // Without a model, as when a tool resolves a skill, every item counts; the index shown was already filtered.
      anyModel: model === undefined || source.anyModel === true,
    };
    const key = `${pinned.global}/${pinned.project}/${runner.model}/${runner.anyModel === true}`;
    let found = resolved.get(key);
    if (found === undefined) {
      found = (async () => {
        let result = layer;
        if (source.global !== undefined) {
          result = await effectiveLayer(result, source.global, Math.max(0, pinned.global), runner);
        }
        if (source.project !== undefined) {
          result = await effectiveLayer(result, source.project, Math.max(0, pinned.project), runner);
        }
        return result;
      })();
      found.catch(() => resolved.delete(key));
      resolved.set(key, found);
    }
    return found;
  };
  const required = [...new Set(layer.gates.flatMap((rule) => rule.requires))];
  return defineExtension({
    name: "chopin-layer",
    sections: [
      section("guidance", async (input, context) =>
        (await layerFor(input.read, input.conversationId, input.agent.model, context)).instructions),
      section("skills", async (input, context) => {
        const { skills } = await layerFor(input.read, input.conversationId, input.agent.model, context);
        return skills.length === 0 ? undefined : skillIndex(skills);
      }),
    ],
    tools: layer.skills.length === 0 && !versioned ? [] : [skillTool(async (name, api, context) =>
      (await layerFor(api, api.conversationId, undefined, context)).skills.find((skill) => skill.name === name))],
    hooks: layer.gates.length === 0 ? [] : [hook(ToolTask, {
      beforeTool: async (call, api, context) => {
        const succeeded = (await api.snapshot(Succeeded, api.conversationId, context))?.tools ?? [];
        const unmet = unmetGates(layer.gates, call.name, new Set(succeeded));
        return unmet.length === 0 ? undefined : { block: gateRefusal(unmet, registered) };
      },
    })],
    wraps: required.map(recordSuccess),
  });
}


function skillIndex(skills: readonly Skill[]): string {
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
  return ["Skills; read one with the skill tool when its description applies:", ...lines].join("\n");
}

type FindSkill = (name: string, api: ToolExecutionApi, context: Context) => Promise<Skill | undefined>;

function skillTool(find: FindSkill) {
  return defineTool({
    name: "skill",
    description: "Read a skill's instructions, or a file the skill bundles.",
    parameters: Type.Object({
      name: Type.String({ description: "The skill's name" }),
      file: Type.Optional(Type.String({ description: "A file inside the skill, relative to it; SKILL.md when omitted" })),
    }),
    execute: async ({ name, file }, api, context) => {
      const skill = await find(name, api, context);
      if (skill === undefined) throw new Error(`no skill named ${name}`);
      const path = resolve(skill.directory, file ?? "SKILL.md");
      if (relative(skill.directory, path).split(sep)[0] === ".." || path === skill.directory) {
        throw new Error(`${file} is outside the skill`);
      }
      const text = await readFile(path, "utf8");
      return { output: [{ type: "text", text: path === resolve(skill.directory, "SKILL.md") ? skillBody(text) : text }] };
    },
  });
}

function recordSuccess(tool: string): Wrap {
  return {
    tool,
    wrap: (registration: ToolRegistration): ToolRegistration => ({
      ...registration,
      execute: async (args, api, context) => {
        const result = await registration.execute(args, api, context);
        if (result.isError !== true) {
          await api.commit(async (tx) => {
            const doc = await tx.doc(Succeeded, api.conversationId);
            if (!doc.tools.includes(tool)) doc.tools.push(tool);
          }, context);
        }
        return result;
      },
    }),
  };
}
