import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type Provider } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Asker } from "../src/ask.js";
import { FileCredentialStore } from "../src/credentials.js";
import { chooseModel, signIn } from "../src/sign-in.js";

afterEach(() => vi.unstubAllEnvs());

/** A provider whose only way in is a key entered, kept where `file` says. */
async function keyed() {
  const home = await mkdtemp(join(tmpdir(), "chopin-sign-in-"));
  vi.stubEnv("CHOPIN_HOME", home);
  const faux = fauxProvider({ models: [{ id: "alpha", name: "Alpha" }] });
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Faux key",
        login: async (interaction) => ({ type: "api_key", key: await interaction.prompt({ type: "secret", message: "Enter the key" }) }),
        resolve: async ({ credential }) => (credential?.key === undefined ? undefined : { auth: { apiKey: credential.key } }),
      },
    },
  };
  const file = join(home, "auth.json");
  const models = createModels({ credentials: new FileCredentialStore(file) });
  models.setProvider(provider);
  return { models, provider, file };
}

describe("signing in", () => {
  it("asks for a key as a secret, keeps it, and then offers the provider's models", async () => {
    const { models, provider, file } = await keyed();
    const asked: string[] = [];
    const asker = {
      enter: async (message: string, secret: boolean) => {
        asked.push(`${message} (${secret ? "secret" : "plain"})`);
        return "sk-test";
      },
      choose: async (_title: string, items: readonly { value: string }[]) => items.at(-1)?.value ?? "",
      tell: () => {},
    } as unknown as Asker;
    expect(await models.getAvailable()).toEqual([]);
    expect(await signIn(models, asker, provider.id)).toBe(provider.id);
    expect(asked).toEqual(["Enter the key (secret)"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ [provider.id]: { type: "api_key", key: "sk-test" } });
    expect(await chooseModel(models, asker)).toEqual({ provider: provider.id, modelId: "alpha" });
  });

  it("goes back from the models to connecting a provider, and then to the models again", async () => {
    const { models, provider } = await keyed();
    const shown: string[] = [];
    let first = true;
    const asker = {
      enter: async (message: string) => {
        shown.push(`asked: ${message}`);
        return "sk-test";
      },
      choose: async (title: string, items: readonly { value: string; label: string }[]) => {
        shown.push(`${title}: ${items.map((item) => item.label).join(", ")}`);
        // The first list is the models with only the way back, the next the models again.
        if (title === "Select a model" && first) {
          first = false;
          return items[0]?.value ?? "";
        }
        return items.at(-1)?.value ?? "";
      },
      tell: () => {},
    } as unknown as Asker;
    expect(await chooseModel(models, asker)).toEqual({ provider: provider.id, modelId: "alpha" });
    // With one provider and one way in, connecting goes straight to its key.
    expect(shown).toEqual([
      "Select a model: ← Connect a provider",
      "asked: Enter the key",
      "Select a model: ← Connect a provider, alpha",
    ]);
  });
});
