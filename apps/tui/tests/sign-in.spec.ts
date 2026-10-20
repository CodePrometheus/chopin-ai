import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Container, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageIn } from "../src/ask.js";
import { FileCredentialStore } from "../src/credentials.js";
import { pickModel, signIn, signOut } from "../src/sign-in.js";
import { runtimeWith } from "./models.js";
import { ScriptedTerminal } from "./scripted-terminal.js";

afterEach(() => vi.unstubAllEnvs());

async function until(test: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !test(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!test()) throw new Error("timed out");
}

/** A screen to show dialogs on, and a runtime whose one extra provider is entered with a key kept in a file. */
async function setUp() {
  const home = await mkdtemp(join(tmpdir(), "chopin-sign-in-"));
  vi.stubEnv("CHOPIN_HOME", home);
  initTheme();
  const faux = fauxProvider({ provider: "keyed", models: [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }] });
  const keyed: Provider = {
    ...faux.provider,
    name: "Keyed",
    auth: {
      apiKey: {
        name: "Keyed API key",
        login: async (interaction) => ({ type: "api_key", key: await interaction.prompt({ type: "secret", message: "Enter the Keyed API key" }) }),
        resolve: async ({ credential }) => (credential?.key === undefined ? undefined : { auth: { apiKey: credential.key } }),
      },
    },
  };
  const file = join(home, "auth.json");
  const runtime = await runtimeWith([keyed], new FileCredentialStore(file));
  const terminal = new ScriptedTerminal();
  const tui = new TuiMainScreen(terminal);
  const slot = new Container();
  tui.addChild(slot);
  tui.start();
  return { runtime, terminal, tui, stage: stageIn(tui, slot), file, keyed };
}

describe("dialogs", () => {
  it("connect a provider by its key, pick one of its models, and sign out of it", async () => {
    const { runtime, terminal, tui, stage, file, keyed } = await setUp();
    try {
      const connected = signIn(stage, runtime, keyed.id);
      await until(() => terminal.screen().includes("Enter the Keyed API key"));
      terminal.type("\x1b[200~sk-test\x1b[201~");
      await until(() => terminal.screen().includes("•••••••"));
      terminal.type("\r");
      expect(await connected).toBe(keyed.id);
      expect(terminal.screen()).not.toContain("sk-test");
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ [keyed.id]: { type: "api_key", key: "sk-test" } });

      // Whatever else the environment connects, typing narrows the list to the model wanted.
      const picked = pickModel(stage, runtime);
      for (const key of "keyed beta") terminal.type(key);
      await until(() => terminal.screen().includes("beta [keyed]"));
      terminal.type("\r");
      expect(await picked).toEqual({ provider: keyed.id, modelId: "beta" });

      const signedOut = signOut(stage, runtime);
      await until(() => terminal.screen().includes("Select provider to logout"));
      terminal.type("\r");
      expect(await signedOut).toBe(keyed.id);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({});
    } finally {
      tui.stop();
    }
  });

  it("come back with nothing when the user backs out", async () => {
    const { runtime, terminal, tui, stage } = await setUp();
    try {
      const connected = signIn(stage, runtime);
      await until(() => terminal.screen().includes("Select provider to configure"));
      terminal.type("\x1b");
      expect(await connected).toBeUndefined();
    } finally {
      tui.stop();
    }
  });
});
