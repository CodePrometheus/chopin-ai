import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { loadLayer } from "@chopin-ai/core";
import type { AgentServiceOptions } from "@chopin-ai/harness-pi";
import { chopinCredentials, chopinModels } from "./credentials.js";
import { layerDirectory } from "./home.js";
import { chosenModel } from "./model.js";

/**
 * What every chopin service runs its agents with: the models reaching providers with `credentials`, those signed in
 * here unless another store is given; the default model as it is when each conversation starts, if one is chosen,
 * else the conversation's client picks; and the layer in its home when there is one.
 */
export async function agentSetup(credentials: CredentialStore = chopinCredentials()): Promise<Pick<AgentServiceOptions, "models" | "agent" | "layer">> {
  const models = await chopinModels(credentials);
  // A model named but unknown is a mistake to report now rather than at the first conversation.
  await chosenModel(models);
  const directory = layerDirectory();
  const layer = await stat(directory).then(() => loadLayer(directory), () => undefined);
  if (layer?.ok === false) throw new Error(`invalid layer ${directory}:\n${layer.problems.join("\n")}`);
  return {
    models: () => models,
    agent: async () => {
      const model = await chosenModel(models);
      return model === undefined ? undefined : { model };
    },
    ...(layer?.ok === true && { layer: layer.layer }),
  };
}
