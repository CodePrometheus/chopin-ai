import { defineDoc, defineExtension, hook, ToolTask, type Extension } from "@earendil-works/pi-durable";
import type { Mode } from "./protocol.js";

/** A conversation's mode, as the store keeps it. */
export const ModeDoc = defineDoc<{ mode: Mode }>({
  kind: "chopin.mode",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ mode: "full" }),
});

/** A conversation's name, as its owner gave it; empty until then. */
export const NameDoc = defineDoc<{ name: string }>({
  kind: "chopin.name",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ name: "" }),
});

export function modeExtension(readOnly: (tool: string) => boolean): Extension {
  return defineExtension({
    name: "chopin-mode",
    hooks: [hook(ToolTask, {
      beforeTool: async (call, api, context) => {
        const mode = (await api.snapshot(ModeDoc, api.conversationId, context))?.mode ?? "full";
        if (mode === "full" || readOnly(call.name)) return undefined;
        return { block: "This conversation is read-only: only tools that change nothing may run." };
      },
    })],
  });
}
