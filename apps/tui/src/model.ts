import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { changeSettings, readSettings } from "./home.js";
import { onScreen, pickModel, signIn } from "./sign-in.js";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export type ChooseModel = (models: ModelRuntime) => Promise<ModelRef>;

/** CHOPIN_MODEL, else the model chosen before; none when neither names one. */
export async function chosenModel(models: ModelRuntime): Promise<ModelRef | undefined> {
  const fromEnvironment = process.env.CHOPIN_MODEL?.trim();
  const named = fromEnvironment === undefined || fromEnvironment === "" ? (await readSettings()).model : fromEnvironment;
  if (named === undefined) return undefined;
  const [provider = "", ...rest] = named.split("/");
  const modelId = rest.join("/");
  // One a terminal found when it fetched the catalogs since is in those kept on disk.
  if (models.getModel(provider, modelId) === undefined) await models.refresh({ allowNetwork: false });
  if (models.getModel(provider, modelId) !== undefined) return { provider, modelId };
  throw new Error(`unknown model ${named}; use provider/model, as the model library names them`);
}

/** The model to run with: the one chosen, else `choose` picks one and it is kept. */
export async function resolveModel(models: ModelRuntime, choose: ChooseModel): Promise<ModelRef> {
  const chosen = await chosenModel(models);
  if (chosen !== undefined) return chosen;
  const picked = await choose(models);
  await changeSettings({ model: `${picked.provider}/${picked.modelId}` });
  return picked;
}

/**
 * Asks in the terminal as pi does: a provider to connect when none is, then a model among those the connected ones
 * offer. Escape on the models goes back to connecting a provider, and backing out of that gives up.
 */
export const pickInTerminal: ChooseModel = (runtime) => onScreen(async (stage) => {
  for (let connect = (await runtime.getAvailable()).length === 0; ; connect = true) {
    if (connect && (await signIn(stage, runtime)) === undefined) throw new Error("no model was picked");
    const picked = await pickModel(stage, runtime);
    if (picked !== undefined) return picked;
  }
});

/** The model new conversations start with, as kept in the settings. */
export async function defaultModel(): Promise<ModelRef | undefined> {
  const [provider, ...rest] = (await readSettings()).model?.split("/") ?? [];
  return provider === undefined || rest.length === 0 ? undefined : { provider, modelId: rest.join("/") };
}

/** For commands with no one to ask, such as an editor starting `chopin acp`. */
export const notInteractive: ChooseModel = async () => {
  throw new Error("no model chosen yet: run chopin once to connect a provider and pick one, or set CHOPIN_MODEL=provider/model");
};
