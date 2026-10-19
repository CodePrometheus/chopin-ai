import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLayer } from "@chopin-ai/core";
import type { AgentServiceOptions } from "@chopin-ai/harness-pi";
import { chopinModels } from "./credentials.js";
import { chopinHome } from "./home.js";
import { notInteractive, resolveModel } from "./model.js";

/**
 * What every chopin service runs its agents with: the models signed in here, the default model as it is when each
 * conversation starts, and the layer in its home when there is one.
 */
export async function agentSetup(): Promise<Pick<AgentServiceOptions, "models" | "agent" | "layer">> {
  const models = chopinModels();
  // A service with no model to start conversations with says so now rather than at its first conversation.
  await resolveModel(models, notInteractive);
  const directory = join(chopinHome(), "layer");
  const layer = await stat(directory).then(() => loadLayer(directory), () => undefined);
  if (layer?.ok === false) throw new Error(`invalid layer ${directory}:\n${layer.problems.join("\n")}`);
  return {
    models: () => models,
    agent: async () => ({ model: await resolveModel(models, notInteractive) }),
    ...(layer?.ok === true && { layer: layer.layer }),
  };
}

/** The built web app every chopin service serves. */
export function webApp(): string {
  return join(dirname(fileURLToPath(import.meta.resolve("@chopin-ai/web/package.json"))), "dist");
}
