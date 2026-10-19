import { mkdtemp, readFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AgentService, launchToken, listen } from "@chopin-ai/harness-pi";
import { connect } from "@chopin-ai/harness-pi/protocol";
import type { Workspace, WorkspaceProvider } from "@chopin-ai/workspace";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chat } from "../src/chat.js";
import { FileCredentialStore } from "../src/credentials.js";
import { plain, ScriptedTerminal } from "./scripted-terminal.js";

const nowhere: WorkspaceProvider = {
  open: (owner): Workspace => ({
    owner, root: "/", state: async () => "running",
    start: async () => {}, pause: async () => {}, stop: async () => {}, destroy: async () => {}, command: (argv, env = {}) => ({ argv: [...argv], env: { ...env } }),
  }),
  list: async () => [],
};

async function until(test: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !test(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!test()) throw new Error("timed out");
}

afterEach(() => vi.unstubAllEnvs());

describe("chat", () => {
  it("sends what the user types and shows the agent's answer", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    // The first answer waits until the terminal has shown that the agent is at work.
    const shownWorking = Promise.withResolvers<void>();
    faux.setResponses([
      async () => {
        await shownWorking.promise;
        return fauxAssistantMessage("Hello from the terminal.");
      },
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
    ]);
    const model = faux.getModel();
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-chat-")), workspaces: nowhere, models: () => models,
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const host = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    const terminal = new ScriptedTerminal();
    try {
      const running = chat(host, terminal);
      await until(() => terminal.screen().includes("ready"));
      terminal.type("Hi there.");
      terminal.type("\r");
      await until(() => terminal.screen().includes("Working… esc stops it"));
      shownWorking.resolve();
      await until(() => terminal.screen().includes("Hello from the terminal."));
      expect(terminal.screen()).toContain("› Hi there.");
      // An answer that failed says so in the conversation, and the status line stays on what is going on.
      const asked = terminal.output.length;
      terminal.type("Again.");
      terminal.type("\r");
      // The harness retries a failed request, so whatever its last try met is what the user is told.
      await until(() => plain(terminal.output.slice(asked)).includes("Error: model_error:"));
      await until(() => plain(terminal.output.slice(asked)).includes("full · ready"));
      // A /mode it does not know is a usage error, never a message to the agent.
      terminal.type("/mode readonly");
      terminal.type("\r");
      await until(() => terminal.screen().includes("usage: /mode read|full"));
      expect(terminal.screen()).not.toContain("› /mode readonly");
      // The refused command is back in the editor, to be fixed rather than retyped; this one is cleared instead.
      for (const _ of "/mode readonly") terminal.type("\x7f");
      terminal.type("/nwe");
      terminal.type("\r");
      await until(() => terminal.screen().includes("unknown command /nwe"));
      // What is typed while /new starts a conversation is meant for that one: given back, not sent to this one.
      for (const _ of "/nwe") terminal.type("\x7f");
      terminal.type("/new");
      terminal.type("\r");
      terminal.type("Next words.");
      const sent = terminal.output.length;
      terminal.type("\r");
      const after = () => plain(terminal.output.slice(sent));
      await until(() => after().includes("ready"));
      expect(after()).toContain("Next words.");
      expect(after()).not.toContain("› Next words.");
      expect(after()).not.toContain("› Hi there.");
      terminal.type("\x03");
      await running;
    } finally {
      await host.close();
      await server.close();
      await service.close(context);
    }
  }, 20_000);

  it("moves the conversation to the model picked with /model and keeps it for new ones", async () => {
    const home = await mkdtemp(join(tmpdir(), "chopin-home-"));
    vi.stubEnv("CHOPIN_HOME", home);
    const faux = fauxProvider({ models: [{ id: "alpha" }, { id: "beta" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-chat-")), workspaces: nowhere, models: () => models,
      agent: async () => ({ model: { provider: faux.provider.id, modelId: "alpha" } }),
    });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const host = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    const terminal = new ScriptedTerminal();
    try {
      const running = chat(host, terminal, { models, credentials: new FileCredentialStore(join(home, "auth.json")) });
      await until(() => terminal.screen().includes("alpha · full · ready"));
      terminal.type("/model");
      terminal.type("\r");
      await until(() => terminal.screen().includes("Select a model"));
      expect(terminal.screen()).toContain("✓ alpha");
      for (const key of "beta") terminal.type(key);
      terminal.type("\r");
      await until(() => terminal.screen().includes("beta · full · now on beta"));
      expect(JSON.parse(await readFile(join(home, "config.json"), "utf8")).model).toBe(`${faux.provider.id}/beta`);

      // Nothing signed in here: /logout says so rather than asking.
      terminal.type("/logout");
      terminal.type("\r");
      await until(() => terminal.screen().includes("nothing is signed in here"));
      terminal.type("\x03");
      await running;
    } finally {
      await host.close();
      await server.close();
      await service.close(context);
    }
  }, 20_000);

  it("keeps going when the service goes away, and gives back a message it could not send", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-chat-")), workspaces: nowhere, models: () => models,
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const host = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    const terminal = new ScriptedTerminal();
    try {
      const running = chat(host, terminal, { timeoutMs: 300 });
      await until(() => terminal.screen().includes("ready"));
      await server.close();
      await until(() => terminal.screen().includes("reconnecting"));
      terminal.type("Lost words.");
      const sent = terminal.output.length;
      terminal.type("\r");
      // Drawn after the editor cleared on enter: the failure, and the message back in the editor.
      const after = () => plain(terminal.output.slice(sent));
      await until(() => after().includes("Error: the agent service did not answer in time") && after().includes("Lost words."));
      terminal.type("\x03");
      await running;
    } finally {
      await host.close();
      await service.close(context);
    }
  }, 20_000);

  it("comes up before its first conversation, and says why there is none", async () => {
    // A port nothing listens on: the service never answers.
    const vacant = createServer().listen(0, "127.0.0.1");
    await once(vacant, "listening");
    const { port } = vacant.address() as { port: number };
    vacant.close();
    const host = connect(`ws://127.0.0.1:${port}/?token=secret`);
    const terminal = new ScriptedTerminal();
    try {
      const running = chat(host, terminal, { timeoutMs: 1_000 });
      await until(() => terminal.screen().includes("a conversation is starting…"));
      // A message typed meanwhile is refused and given back.
      terminal.type("Early words.");
      const sent = terminal.output.length;
      terminal.type("\r");
      const after = () => plain(terminal.output.slice(sent));
      await until(() => after().includes("Early words."));
      expect(after()).not.toContain("› Early words.");
      await until(() => terminal.screen().includes("Error: the agent service did not answer in time"));
      await until(() => terminal.screen().includes("no conversation; /new starts one"));
      terminal.type("\x03");
      await running;
    } finally {
      await host.close();
    }
  }, 20_000);
});
