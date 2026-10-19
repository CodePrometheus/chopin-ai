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
import { gateRefusal, skillBody, unmetGates, type Layer, type Skill } from "@chopin-ai/core";

/** Tools that have completed successfully in a conversation; a fork sees them as of its fork point. */
const Succeeded = defineDoc<{ tools: string[] }>({
  kind: "chopin.succeeded",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ tools: [] }),
});

/**
 * The portable layer as an extension. Skills and instructions are served from here, outside the workspace, so the
 * agent can read them but never edit them; only evaluation changes the layer. A refused call names any required
 * tool missing from `registered`, such as one whose MCP server did not answer.
 */
export function layerExtension(layer: Layer, registered: ReadonlySet<string>): Extension {
  const skills = new Map(layer.skills.map((skill) => [skill.name, skill]));
  const required = [...new Set(layer.gates.flatMap((rule) => rule.requires))];
  return defineExtension({
    name: "chopin-layer",
    sections: [
      section("guidance", () => layer.instructions),
      section("skills", () => (layer.skills.length === 0 ? undefined : skillIndex(layer.skills))),
    ],
    tools: layer.skills.length === 0 ? [] : [skillTool(skills)],
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

function skillTool(skills: ReadonlyMap<string, Skill>) {
  return defineTool({
    name: "skill",
    description: "Read a skill's instructions, or a file the skill bundles.",
    parameters: Type.Object({
      name: Type.String({ description: "The skill's name" }),
      file: Type.Optional(Type.String({ description: "A file inside the skill, relative to it; SKILL.md when omitted" })),
    }),
    execute: async ({ name, file }) => {
      const skill = skills.get(name);
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
