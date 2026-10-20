import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { PromptInput } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { describe, expect, it } from "vitest";
import { AgentService, contextFiles, launchToken, listen, projectContext } from "../src/index.js";
import { connect, Conversation, Conversations } from "../src/protocol.js";
import { localWorkspace } from "./local-workspace.js";

const git = (args: string[]) => promisify(execFile)("git", args);

/** A fresh directory, by its real path, as the environment reports paths. */
const fresh = async () => realpath(await mkdtemp(join(tmpdir(), "chopin-context-")));

/** The files found under `root`, leaving out any of the machine's own above it. */
const within = async (root: string, cwd: string) =>
  (await contextFiles(new NodeExecutionEnv({ cwd }), context)).filter((file) => file.path.startsWith(`${root}/`));

describe("contextFiles", () => {
  it("reads one file per directory, the root's first, the first name present winning", async () => {
    const root = await fresh();
    const deep = join(root, "a", "b");
    await mkdir(deep, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "﻿top");
    await writeFile(join(root, "a", "CLAUDE.md"), "middle");
    await writeFile(join(deep, "AGENTS.md"), "shadowed by the override");
    await writeFile(join(deep, "AGENTS.override.md"), "bottom");
    expect(await within(root, deep)).toEqual([
      { path: join(root, "AGENTS.md"), content: "top" },
      { path: join(root, "a", "CLAUDE.md"), content: "middle" },
      { path: join(deep, "AGENTS.override.md"), content: "bottom" },
    ]);
  });

  it("takes a nested worktree's file in place of its main repository's", async () => {
    const repo = await fresh();
    await git(["-C", repo, "init", "--quiet"]);
    await writeFile(join(repo, "AGENTS.md"), "main");
    await git(["-C", repo, "add", "AGENTS.md"]);
    await git(["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "base"]);
    await git(["-C", repo, "worktree", "add", "--quiet", join(repo, "feature")]);
    await writeFile(join(repo, "feature", "AGENTS.md"), "feature");
    expect(await within(repo, join(repo, "feature"))).toEqual([{ path: join(repo, "feature", "AGENTS.md"), content: "feature" }]);
    // The main repository itself still reads its own.
    expect(await within(repo, repo)).toEqual([{ path: join(repo, "AGENTS.md"), content: "main" }]);
  });
});

describe("projectContext", () => {
  const render = (env: ExecutionEnv) => projectContext.sections?.[0]?.render({ env } as PromptInput, context);

  it("gives the model the files as the coding agent does, and nothing when there are none", async () => {
    const root = await fresh();
    await writeFile(join(root, "AGENTS.md"), "Use tabs.");
    const text = await render(new NodeExecutionEnv({ cwd: root }));
    expect(text).toMatch(/^Project-specific instructions and guidelines:\n\n/);
    expect(text).toContain(`<project_instructions path="${join(root, "AGENTS.md")}">\nUse tabs.\n</project_instructions>`);
    const bare = { cwd: "/project", listDir: async () => ({ ok: true, value: [] }) } as unknown as ExecutionEnv;
    expect(await render(bare)).toBeUndefined();
  });

  it("reaches the model of an agent working in the project, and is named among what it loaded", async () => {
    const root = await fresh();
    await writeFile(join(root, "AGENTS.md"), "Answer in one word.");
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    let prompt = "";
    faux.setResponses([(request) => {
      prompt = request.messages.flatMap((message) => (message.role === "system" ? Object.values(message.sections ?? {}) : [])).join("\n");
      return fauxAssistantMessage("Done.");
    }]);
    const model = faux.getModel();
    const service = new AgentService({
      dataDir: await mkdtemp(join(tmpdir(), "chopin-context-data-")), workspaces: localWorkspace(root), models: () => models,
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const server = await listen(service, { authenticate: launchToken("secret") });
    const client = connect(`ws://127.0.0.1:${server.port}/?token=secret`);
    try {
      const conversations = await client.get(Conversations, {});
      expect((await client.root((ctx) => conversations.loaded(ctx))).projectInstructions).toContain(join(root, "AGENTS.md"));
      const conversation = await client.get(Conversation, { conversation: await client.root((ctx) => conversations.create(ctx)) });
      await client.root((ctx) => conversation.submit({ text: "Hi." }, ctx));
      for (let i = 0; i < 300 && prompt === ""; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(prompt).toContain(`<project_instructions path="${join(root, "AGENTS.md")}">\nAnswer in one word.\n</project_instructions>`);
    } finally {
      await client.close();
      await server.close();
      await service.close(context);
    }
  });
});
