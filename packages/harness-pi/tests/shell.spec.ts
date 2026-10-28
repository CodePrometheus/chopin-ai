import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type UserMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { localDaemon } from "@earendil-works/pi-env";
import { DirectoryWorkspaceProvider, type WorkspaceProvider } from "@chopin-ai/workspace";
import { describe, expect, it } from "vitest";
import { AgentService, launchToken, listen, ShellEntry, shellText } from "../src/index.js";
import { connect, Conversation, Conversations } from "../src/protocol.js";
import { localWorkspace } from "./local-workspace.js";

const ran = { command: "make", output: "", cancelled: false, truncated: false, excluded: false };

describe("shellText", () => {
  it("words a run as the coding agent words it", () => {
    expect(shellText({ ...ran, output: "built", exitCode: 0 })).toBe("Ran `make`\n```\nbuilt\n```");
    expect(shellText({ ...ran, exitCode: 2 })).toBe("Ran `make`\n(no output)\n\nCommand exited with code 2");
    expect(shellText({ ...ran, output: "half", cancelled: true })).toBe("Ran `make`\n```\nhalf\n```\n\n(command cancelled)");
    expect(shellText({ ...ran, output: "tail", exitCode: 0, truncated: true, fullOutputPath: "/tmp/all" }))
      .toBe("Ran `make`\n```\ntail\n```\n\n[Output truncated. Full output: /tmp/all]");
  });
});

type Setup = (root: string) => { workspaces: WorkspaceProvider; daemon?: string };

async function started(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0] = [], setup: Setup = (root) => ({ workspaces: localWorkspace(root) })) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const model = faux.getModel();
  const root = await realpath(await mkdtemp(join(tmpdir(), "chopin-shell-")));
  const service = new AgentService({
    dataDir: await mkdtemp(join(tmpdir(), "chopin-shell-data-")), ...setup(root), models: () => models,
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  const server = await listen(service, { authenticate: launchToken("secret") });
  const client = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
  const conversations = await client.get(Conversations, {});
  const conversation = await client.get(Conversation, { conversation: await client.root((ctx) => conversations.create(ctx)) });
  const entries = () => (conversation.view.value as ConversationView).entries;
  const until = async (test: () => boolean) => {
    for (let i = 0; i < 500 && !test(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    if (!test()) throw new Error("timed out");
  };
  return {
    root, service, client, conversations, conversation, entries, until,
    close: async () => {
      await client.close();
      await server.close();
      await service.close(context);
    },
  };
}

const shellRuns = (entries: readonly EntryRecord[]) => entries.filter((entry) => ShellEntry.is(entry));

describe("a user's command", () => {
  it("runs in the workspace, and the model reads what it printed unless it is excluded", async () => {
    const { root, client, conversation, entries, until, close } = await started();
    try {
      await client.root((ctx) => conversation.shell({ command: "pwd; printf 'two\\n' >&2; exit 3" }, ctx));
      await until(() => shellRuns(entries()).length === 1);
      const [seen] = shellRuns(entries());
      expect(seen?.data).toMatchObject({ command: "pwd; printf 'two\\n' >&2; exit 3", exitCode: 3, cancelled: false, truncated: false, excluded: false });
      // Both streams are kept; which of them arrived first is the pipes' to say.
      expect((seen?.data as { output: string }).output.split("\n").sort()).toEqual([root, "two"].sort());
      expect((seen?.model?.[0] as UserMessage | undefined)?.content).toBe(shellText(seen?.data as Parameters<typeof shellText>[0]));

      await client.root((ctx) => conversation.shell({ command: "echo secret", excluded: true }, ctx));
      await until(() => shellRuns(entries()).length === 2);
      const unseen = shellRuns(entries())[1];
      expect(unseen?.data).toMatchObject({ output: "secret", exitCode: 0, excluded: true });
      expect(unseen?.model).toBeUndefined();
      expect(conversation.running.value).toBeNull();
    } finally {
      await close();
    }
  });

  it.runIf(process.platform === "darwin")("cannot see a directory the workspace hides, and works as ever around it", async () => {
    const { root, client, conversation, entries, until, close } = await started([], (root) => ({
      workspaces: new DirectoryWorkspaceProvider(root, { hidden: [join(root, "hidden")] }), daemon: localDaemon(),
    }));
    try {
      await mkdir(join(root, "hidden"));
      await writeFile(join(root, "hidden", "auth.json"), "s3cret\n");
      await writeFile(join(root, "notes.txt"), "mine\n");
      await client.root((ctx) => conversation.shell({ command: "cat hidden/auth.json; ls hidden; cat notes.txt" }, ctx));
      await until(() => shellRuns(entries()).length === 1);
      const output = (shellRuns(entries())[0]?.data as { output: string }).output;
      expect(output).not.toContain("s3cret");
      expect(output).not.toContain("auth.json\n");
      expect(output).toContain("Operation not permitted");
      expect(output).toContain("mine");
    } finally {
      await close();
    }
  });

  it("shows its output as it runs, one at a time, until it is stopped", async () => {
    const { service, client, conversation, entries, until, close } = await started();
    try {
      const running = client.root((ctx) => conversation.shell({ command: "printf '\\033[32mstarted\\033[0m\\n'; sleep 30" }, ctx));
      await until(() => conversation.running.value?.output === "started\n");
      // A command at work is the agent at work, so nothing hands over or reclaims under it.
      expect(await service.working()).toContain("local");
      expect(conversation.running.value).toMatchObject({ excluded: false });
      await expect(client.root((ctx) => conversation.shell({ command: "echo again" }, ctx))).rejects.toThrow("a command is already running");

      await client.root((ctx) => conversation.stopCommand({}, ctx));
      await running;
      await until(() => shellRuns(entries()).length === 1);
      expect(shellRuns(entries())[0]?.data).toMatchObject({ output: "started", cancelled: true });
      expect(conversation.running.value).toBeNull();
    } finally {
      await close();
    }
  });
});

describe("withdraw", () => {
  it("takes back the messages still queued, with their texts, and leaves the one at work", async () => {
    const answer = Promise.withResolvers<void>();
    const { client, conversation, until, close } = await started([
      async () => {
        await answer.promise;
        return fauxAssistantMessage("First answered.");
      },
      fauxAssistantMessage("Never asked."),
    ]);
    try {
      await client.root((ctx) => conversation.submit({ text: "First." }, ctx));
      await until(() => JSON.stringify(conversation.view.value).includes("\"run\""));
      await client.root((ctx) => conversation.submit({ text: "Second." }, ctx));
      await client.root((ctx) => conversation.submit({ text: "Third." }, ctx));
      await until(() => JSON.stringify((conversation.view.value as ConversationView).docs["pi.inbox"] ?? {}).includes("Third."));

      expect(await client.root((ctx) => conversation.withdraw({}, ctx))).toEqual(["Second.", "Third."]);
      expect(await client.root((ctx) => conversation.withdraw({}, ctx))).toEqual([]);
      answer.resolve();
      await until(() => JSON.stringify(conversation.view.value).includes("First answered."));
      expect(JSON.stringify(conversation.view.value)).not.toContain("Never asked.");
    } finally {
      await close();
    }
  });
});

describe("loaded", () => {
  it("says what the agents load besides their tools", async () => {
    const { client, conversations, close } = await started();
    try {
      expect(await client.root((ctx) => conversations.loaded(ctx))).toMatchObject({ instructions: false, skills: [], mcpServers: [] });
    } finally {
      await close();
    }
  });
});
