import type { Models } from "@earendil-works/pi-ai";
import { Declined } from "./ask.js";
import { readSettings, writeSettings } from "./home.js";
import { chooseModel, onScreen, signIn } from "./sign-in.js";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export type ChooseModel = (models: Models) => Promise<ModelRef>;

/** The model to run with: CHOPIN_MODEL, else the one chosen before, else `choose` picks one and it is kept. */
export async function resolveModel(models: Models, choose: ChooseModel): Promise<ModelRef> {
  const fromEnvironment = process.env.CHOPIN_MODEL?.trim();
  const named = fromEnvironment === undefined || fromEnvironment === "" ? (await readSettings()).model : fromEnvironment;
  if (named !== undefined) {
    const [provider = "", ...rest] = named.split("/");
    if (models.getModel(provider, rest.join("/")) !== undefined) return { provider, modelId: rest.join("/") };
    throw new Error(`unknown model ${named}; use provider/model, as the model library names them`);
  }
  const chosen = await choose(models);
  await writeSettings({ ...(await readSettings()), model: `${chosen.provider}/${chosen.modelId}` });
  return chosen;
}

/**
 * Asks in the terminal: a provider to connect when none is, then a model among those the connected ones offer.
 * Escape on the models goes back to the providers, and escape there gives up.
 */
export const pickInTerminal: ChooseModel = (models) => onScreen(async (asker) => {
  if ((await models.getAvailable()).length === 0) {
    asker.tell("No provider is connected yet; connect one to start.");
    await signIn(models, asker);
  }
  for (;;) {
    try {
      return await chooseModel(models, asker);
    } catch (error) {
      if (!(error instanceof Declined)) throw error;
      await signIn(models, asker);
    }
  }
}).catch((error: unknown) => {
  throw error instanceof Declined ? new Error("no model was picked") : error;
});

/** For commands with no one to ask, such as an editor starting `chopin acp`. */
export const notInteractive: ChooseModel = async () => {
  throw new Error("no model chosen yet: run chopin once to connect a provider and pick one, or set CHOPIN_MODEL=provider/model");
};
