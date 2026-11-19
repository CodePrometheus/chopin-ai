import { createHash } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { ExecutionError, Result, ShellExecOptions, ShellExecResult } from "@earendil-works/pi-durable/env";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type AssistantMessage, type AuthInteraction, type AuthType, type CredentialInfo, type CredentialStore, type Models } from "@earendil-works/pi-ai";
import {
  CompactionEntry,
  createRegistry,
  defineExtension,
  Harness,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type AgentChange,
  type Conversation,
  type ConversationId,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Extension,
  type ModelRef,
  type Storage,
  type SubmissionId,
  type SubmissionQuery,
  type SubmissionRecord,
  type Wake,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { checkGates, isMcpToolOf, readJsonObject, withChopinMeta, type Layer, type McpServer, type TaskRun, type TranscriptEntry } from "@chopin-ai/core";
import { diff, reclaimIdle, snapshot, type Workspace, type WorkspaceProvider } from "@chopin-ai/workspace";
import { entryTranscript, stopReason, totalUsage, userText } from "./acp.js";
import { IdleCompaction } from "./idle-compaction.js";
import { layerExtension, pinLayerVersions, type LayerSource } from "./layer.js";
import { mcpExtensionName, McpServers } from "./mcp.js";
import { drain } from "./pages.js";
import { ListingDoc, modeExtension, NameDoc, withMode } from "./mode.js";
import { unansweredText, type Loaded, type McpServerState, type ModelChoices, type ProviderEntry, type Summary } from "./protocol.js";
import { clientContext } from "./client-context.js";
import { contextFiles, projectContext } from "./project-context.js";
import { runShell, ShellEntry, type ShellRun } from "./shell.js";
import { GoalEngine, type GoalOptions } from "./goals/engine.js";
import type { EngineCommand, EngineReceipt } from "./goals/contracts.js";
import { ActiveGoals } from "./goals/store.js";
import { WakePublisher } from "./wake.js";
import { refusal } from "./service-error.js";

/** Built-in tools that change nothing, so a read-only conversation may still use them. */
const READ_ONLY = new Set(["read", "skill", "command_output"]);

const EMPTY_LAYER: Layer = { instructions: undefined, skills: [], mcpServers: {}, gates: [] };

/** How often an owner's unreachable MCP servers are tried again. */
const MCP_RETRY_MS = 30_000;

const FIXED_CREDENTIALS = "this service takes its credentials from where it runs, not from its clients";

/** Where the workspace image keeps the execution daemon. */
export const DAEMON_PATH = "/usr/local/bin/pi-env";

export interface AgentServiceOptions {
  /** Explicit goal authorization, verification and effect-reconciliation adapters for each owner. */
  goals?: (owner: string) => GoalOptions;
  /** Restore pending work without scheduling it until an admitted command or explicit resume. */
  startPaused?: boolean;
  /** Durable wake sink. The host arms a recovery fallback before enabling work and resumes sleeping tasks itself. */
  onWake?: (owner: string, wake: Wake) => void | Promise<void>;
  /** Holds one store per owner. It must not be reachable from any workspace. */
  dataDir: string;
  /** Provides the daemon-backed tools and shell. An omitted provider leaves execution to installed extensions. */
  workspaces?: WorkspaceProvider;
  /** The models an owner's agent may use, carrying that owner's credentials. */
  models: (owner: string) => Models;
  /** Where an owner's models read their credentials, which clients may then set; absent, they cannot. */
  credentials?: (owner: string) => CredentialStore;
  /** What a new conversation of an owner runs with, such as its model; asked again for each, so a default may change. */
  agent?: AgentChange | ((owner: string) => Promise<AgentChange | undefined>);
  /** The portable layer every agent loads. */
  layer?: Layer;
  /** The loop's versions laid over `layer`; each conversation keeps the ones in use when it was made. */
  layerVersions?: LayerSource;
  /** Installed after the coding tools and layer. Owner factories run only after storage admission. */
  extensions?: readonly Extension[] | ((owner: string) => readonly Extension[] | Promise<readonly Extension[]>);
  /** Failures that do not fail the call at hand, such as an unreachable MCP server. */
  report?: (error: unknown) => void;
  /** The execution daemon as the workspace runs it; the workspace image's by default. */
  daemon?: string;
  /** Stops workspaces whose owner has been idle this long, keeping their volumes; never when absent. */
  reclaimAfterMs?: number;
  /** Allows clients to register their own MCP endpoints. Defaults to enabled. */
  allowClientMcp?: boolean;
  /**
   * Keeps the MCP servers an owner's clients set in `dataDir`, headers and all, so they outlast a restart; only where
   * that directory is sealed at rest. In memory alone when absent.
   */
  keepClientMcp?: boolean;
  /** Opens an owner's store; an SQLite file in `dataDir` by default. */
  store?: (owner: string) => Promise<Storage>;
  /**
   * Makes a file the service wrote in `dataDir` outlast a crash, as sealing it at once does, before the client that
   * asked for the write is answered; the write alone by default.
   */
  persist?: (file: string) => Promise<void>;
}

/** A conversation that changed, as `changedSince` gives it. */
export interface Changed {
  id: number;
  modified: number;
  transcript: TranscriptEntry[];
}

interface Opened {
  harness: Harness;
  storage: Storage;
  idle: IdleCompaction;
  mode: Extension;
  goals?: GoalEngine;
  wake?: WakePublisher;
  /** The owner's workspace as the agent's tools reach it. */
  env?: (cwd?: string) => RemoteExecutionEnv;
  mcp: McpServers;
  /** Serves an MCP server under `name` from now on, in place of any by that name, or none when `server` is absent. */
  serve(name: string, server: McpServer | undefined): Promise<void>;
  close(context: Context): Promise<void>;
}

interface Agent {
  readonly opened: Promise<Opened>;
  /** When the open began. */
  readonly since: number;
  ready?: Opened;
  /** Whether its state could not be told when last asked. */
  unclear: boolean;
}

/**
 * Hosts one durable harness per owner. A workspace provider enables daemon-backed execution for that owner.
 * Services with a separate execution authority can install its tools without a workspace provider.
 */
export class AgentService {
  readonly #options: AgentServiceOptions;
  /** Each owner's agent: its opening, and once that finished, what it opened. */
  readonly #agents = new Map<string, Agent>();
  /** Agents a sweep is closing, until they have. */
  readonly #closing = new Map<string, Promise<void>>();
  /** Who hears of conversations this service makes, so lists already held show them. */
  readonly #made = new Set<(owner: string, conversation: number) => void>();
  /** How many client objects hold each owner's agent. */
  readonly #holds = new Map<string, number>();
  /** How many of each owner's own commands are running. */
  readonly #commands = new Map<string, number>();
  /** The MCP servers each owner's clients set, headers and all, as far as they are read. */
  readonly #clientMcp = new Map<string, Record<string, McpServer>>();
  /** The variables each owner's commands get, set by their clients; in memory alone. */
  readonly #variables = new Map<string, Map<string, string>>();
  /** Keeping the servers clients set, one write at a time, so none overtakes a later one. */
  #keeping: Promise<unknown> = Promise.resolve();
  /** When this service started, which is as recent as anything it knows of an owner it has not seen. */
  readonly #started = Date.now();
  readonly #lastActive = new Map<string, number>();
  readonly #reclaiming: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: AgentServiceOptions) {
    this.#options = options;
    this.#reclaiming = options.reclaimAfterMs === undefined || options.workspaces === undefined
      ? undefined : this.#reclaim(options.workspaces, options.reclaimAfterMs);
    // MCP tools are only known once their servers answer; gates on them are checked again when an owner opens.
    if (typeof options.extensions !== "function") this.#checkGates(new Set(toolNames(this.#extensions(new Set(), options.extensions ?? []))));
  }

  /**
   * The owner's harness, opened on first use; unfinished work resumes. Every caller shares the one opening, so it
   * runs on the service's own context: a caller that gives up fails no other.
   */
  async harness(owner: string): Promise<Harness> {
    return (await this.#openedFor(owner)).harness;
  }
  /** Execution-owned goal coordinator; absence is an explicit unsupported capability. */
  async goals(owner: string): Promise<GoalEngine> {
    const goals = (await this.#openedFor(owner)).goals;
    if (goals === undefined) throw refusal("goals_unavailable", "this service has no goal execution adapters");
    return goals;
  }
  /** Whether a conversation may accept legacy direct execution commands. */
  async directConversation(owner: string, conversation?: number): Promise<boolean> {
    const goals = (await this.#openedFor(owner)).goals;
    if (goals === undefined) return true;
    if (!goals.allowDirectConversations) return false;
    return conversation === undefined || await goals.store.forConversation(conversation as ConversationId, BACKGROUND_CONTEXT) === undefined;
  }
  /** Admit through execution and publish the new visible conversation only after its receipt is durable. */
  async executeGoal(owner: string, envelope: EngineCommand, context: Context): Promise<EngineReceipt> {
    const goals = await this.goals(owner);
    const receipt = await goals.execute(envelope, await this.#agent(owner), context);
    if (envelope.command.kind === "goal.submit") {
      const goal = await goals.store.snapshot(receipt.goalId, context);
      for (const listener of this.#made) listener(owner, goal.conversationId);
    }
    return receipt;
  }

  /** A new top-level conversation of the owner's agent, running with the configured agent choices. */
  async newConversation(owner: string, context: Context): Promise<Conversation> {
    const harness = await this.harness(owner);
    const agent = await this.#agent(owner);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, ...(agent && { agent }) }, context);
    for (const listener of this.#made) listener(owner, Number(conversation.id));
    return conversation;
  }

  /**
   * A fork of the owner's `conversation` at `entry`, made top-level like any other conversation of the owner;
   * undefined when the owner has no such conversation.
   */
  async fork(owner: string, conversation: number, entry: number, context: Context): Promise<number | undefined> {
    const harness = await this.harness(owner);
    const source = await this.isTopLevel(owner, conversation) ? await harness.conversation(conversation as ConversationId, context) : undefined;
    if (source === undefined) return undefined;
    const fork = await source.fork(entry as EntryId, { ownership: { kind: "ownerless" } }, context);
    for (const listener of this.#made) listener(owner, Number(fork.id));
    return Number(fork.id);
  }

  /**
   * A line about each of the owner's conversations, last changed first: its name, its first message, how many
   * messages it holds, when it began and last changed, whether it is answering or its latest answer failed, and how its
   * owner keeps it in the list.
   */
  async summaries(owner: string, context: Context): Promise<Summary[]> {
    const harness = await this.harness(owner);
    const lines = await Promise.all((await this.conversations(owner)).map(async (id): Promise<Summary> => {
      const conversation = await harness.conversation(id as ConversationId, context);
      const messages = conversation === undefined ? [] : (await allEntries(conversation, context))
        .flatMap((entry) => entry.kind === CompactionEntry.kind || entry.kind === ShellEntry.kind ? [] : entry.model ?? [])
        .filter((message) => message.role === "user" || message.role === "assistant");
      const first = messages.find((message) => message.role === "user");
      const answer = messages.findLast((message) => message.role === "assistant");
      const times = messages.map((message) => message.timestamp).filter((time) => Number.isFinite(time));
      const listing = await harness.snapshot(ListingDoc, id as ConversationId, context);
      return {
        id,
        name: (await harness.snapshot(NameDoc, id as ConversationId, context))?.name ?? "",
        first: first === undefined ? "" : userText(first.content),
        messages: messages.length,
        created: times.length === 0 ? 0 : Math.min(...times),
        modified: times.length === 0 ? 0 : Math.max(...times),
        running: (await harness.snapshot(LiveDoc, id as ConversationId, context))?.run !== undefined,
        failed: answer?.role === "assistant" && answer.stopReason === "error",
        pinned: listing?.pinned ?? false,
        archived: listing?.archived ?? false,
        seen: listing?.seen ?? 0,
      };
    }));
    return lines.sort((a, b) => b.modified - a.modified);
  }

  /** What the owner's agent loads besides its tools: the layer's instructions, skills and MCP servers, and the project's instructions. */
  async loaded(owner: string, context: Context): Promise<Loaded> {
    const layer = this.#options.layer;
    const env = (await this.#openedFor(owner)).env?.();
    const project = env === undefined ? [] : await contextFiles(env, context);
    return {
      instructions: layer?.instructions !== undefined,
      projectInstructions: project.map((file) => file.path),
      skills: layer?.skills.map((skill) => skill.name) ?? [],
      mcpServers: [...Object.keys(layer?.mcpServers ?? {}), ...Object.keys(await this.#clientServers(owner))],
    };
  }

  /** A conversation of the owner's whole, as transcript lines. */
  async transcript(owner: string, conversation: Conversation, context: Context): Promise<TranscriptEntry[]> {
    this.touch(owner);
    return entryTranscript(String(conversation.id), await allEntries(conversation, context));
  }

  /**
   * For readers outside the service, such as the loop that learns from them: the owner's top-level conversations
   * changed since the times in `since`, by id, with when each last changed and its transcript. It reads only an agent
   * already open, so it neither opens a store nor counts as the owner at work; none while the agent is closed.
   */
  async changedSince(owner: string, since: Readonly<Record<string, number>>, context: Context): Promise<Changed[]> {
    const agent = this.#agents.get(owner);
    const opened = agent === undefined ? undefined : await agent.opened.catch(() => undefined);
    if (opened === undefined) return [];
    const records = await drain(
      (cursor: Cursor | undefined) => opened.storage.scanConversations({ order: "ascending" }, 256, cursor, context),
      topLevel,
    );
    const changed: Changed[] = [];
    for (const record of records) {
      const conversation = await opened.harness.conversation(record.id, context);
      if (conversation === undefined) continue;
      const entries = await allEntries(conversation, context);
      const times = entries.flatMap((entry) => (entry.model ?? []).map((message) => message.timestamp)).filter(Number.isFinite);
      const modified = times.length === 0 ? 0 : Math.max(...times);
      if (modified <= (since[String(record.id)] ?? 0)) continue;
      changed.push({ id: Number(record.id), modified, transcript: entryTranscript(String(record.id), entries) });
    }
    return changed;
  }

  /** Runs a command of the owner's in their workspace, as the agent's shell tool runs its own. */
  async shell(owner: string, command: string, onOutput: (kept: string) => Promise<unknown>, context: Context): Promise<Omit<ShellRun, "command" | "excluded">> {
    const opened = await this.#openedFor(owner);
    const env = opened.env?.();
    if (env === undefined) throw refusal("workspace_unavailable", "this service has no direct workspace shell");
    // A command at work is the agent at work: nothing hands over or reclaims under it.
    this.#commands.set(owner, (this.#commands.get(owner) ?? 0) + 1);
    opened.wake?.offer();
    try {
      return await runShell(env, command, onOutput, context);
    } finally {
      const left = (this.#commands.get(owner) ?? 1) - 1;
      if (left > 0) this.#commands.set(owner, left);
      else this.#commands.delete(owner);
      this.touch(owner);
      opened.wake?.offer();
    }
  }

  /** Why the owner's agent cannot think at `level` with `model`, or undefined when it can. */
  thinkingProblem(owner: string, model: ModelRef, level: string): string | undefined {
    const found = this.#options.models(owner).getModel(model.provider, model.modelId);
    if (found === undefined) return `there is no model ${model.provider}/${model.modelId}`;
    const levels: readonly string[] = getSupportedThinkingLevels(found);
    return levels.includes(level) ? undefined : `${model.modelId} thinks at ${levels.join(", ")}, not ${level}`;
  }

  /**
   * Why the owner's agent cannot run with `model`: no such model, or no credentials for its provider; else undefined.
   * A model the catalogs here do not know yet is looked for again in those kept on disk, which a client may have
   * refreshed meanwhile.
   */
  async modelProblem(owner: string, model: ModelRef): Promise<string | undefined> {
    const models = this.#options.models(owner);
    if (models.getModel(model.provider, model.modelId) === undefined) await models.refresh({ allowNetwork: false });
    if (models.getModel(model.provider, model.modelId) === undefined) return `there is no model ${model.provider}/${model.modelId}`;
    if ((await models.checkAuth(model.provider)) === undefined) return `there are no credentials for ${model.provider}`;
    return undefined;
  }

  /** The models the owner's agent can use now, those whose providers have credentials, and its model for a new conversation. */
  async modelChoices(owner: string): Promise<ModelChoices> {
    const available = await this.#options.models(owner).getAvailable();
    const model = (await this.#agent(owner))?.model;
    return {
      models: available.map((each) => ({
        provider: each.provider,
        modelId: each.id,
        name: each.name,
        contextWindow: each.contextWindow,
        images: each.input.includes("image"),
        thinkingLevels: [...getSupportedThinkingLevels(each)],
      })),
      current: model == null ? null : { provider: model.provider, modelId: model.modelId },
    };
  }

  /**
   * The MCP servers the owner's clients set, each with how many tools it offers, or why it offers none yet. Asking
   * opens nothing: an agent not open now offers none of their tools.
   */
  async mcpServers(owner: string): Promise<McpServerState[]> {
    const servers = await this.#clientServers(owner);
    const opened = this.#agents.get(owner)?.ready;
    return Object.entries(servers).map(([name, server]) => ({ name, url: "url" in server ? server.url : "", ...opened?.mcp.status(name) ?? { tools: 0 } }));
  }

  /**
   * Serves an MCP server a client sets for the owner, in place of any it set by that name; else why it cannot: the
   * layer has one by that name, or the address is no web address.
   */
  async setMcpServer(owner: string, name: string, url: string, headers: Readonly<Record<string, string>>): Promise<string | undefined> {
    if (this.#options.allowClientMcp === false) return "this service takes MCP servers from its trusted configuration";
    if (name in (this.#options.layer?.mcpServers ?? {})) return `the layer already serves an MCP server named ${name}`;
    if (!/^https?:$/.test(URL.parse(url)?.protocol ?? "")) return `${url} is no http or https address`;
    const server: McpServer = { type: "http", url, ...(Object.keys(headers).length > 0 && { headers: { ...headers } }) };
    await this.#keepClientServers(owner, { ...await this.#clientServers(owner), [name]: server });
    await (await this.#openedFor(owner)).serve(name, server);
    return undefined;
  }

  /** Stops serving an MCP server a client set for the owner. */
  async removeMcpServer(owner: string, name: string): Promise<void> {
    const { [name]: gone, ...rest } = await this.#clientServers(owner);
    if (gone === undefined) return;
    await this.#keepClientServers(owner, rest);
    await this.#agents.get(owner)?.ready?.serve(name, undefined);
  }

  /** The names of the variables the owner's commands get, in order; never their values. */
  variableNames(owner: string): string[] {
    return [...this.#variables.get(owner)?.keys() ?? []].sort();
  }

  /** Gives every command of the owner's agent `name` set to `value` from now on. */
  setVariable(owner: string, name: string, value: string): void {
    this.#variables.set(owner, (this.#variables.get(owner) ?? new Map<string, string>()).set(name, value));
  }

  removeVariable(owner: string, name: string): void {
    this.#variables.get(owner)?.delete(name);
  }

  /** The MCP servers the owner's clients set, read from `dataDir` the first time where they are kept there. */
  async #clientServers(owner: string): Promise<Record<string, McpServer>> {
    if (this.#options.allowClientMcp === false) return {};
    const known = this.#clientMcp.get(owner);
    if (known !== undefined || this.#options.keepClientMcp !== true) return known ?? {};
    const read = (await readJsonObject(this.#clientMcpFile(owner), "MCP servers")) ?? {};
    // One set meanwhile is newer than what was read.
    const kept = this.#clientMcp.get(owner) ?? read as Record<string, McpServer>;
    this.#clientMcp.set(owner, kept);
    return kept;
  }

  async #keepClientServers(owner: string, servers: Record<string, McpServer>): Promise<void> {
    this.#clientMcp.set(owner, servers);
    if (this.#options.keepClientMcp !== true) return;
    const file = this.#clientMcpFile(owner);
    const write = this.#keeping.then(async () => {
      await mkdir(this.#options.dataDir, { recursive: true, mode: 0o700 });
      // Written whole, so a restart midway finds the servers as they were or as they are.
      await writeFile(`${file}.draft`, JSON.stringify(this.#clientMcp.get(owner) ?? {}), { mode: 0o600 });
      await rename(`${file}.draft`, file);
      await this.#options.persist?.(file);
    });
    this.#keeping = write.catch(() => {});
    await write;
  }

  #clientMcpFile(owner: string): string {
    return join(this.#options.dataDir, `${fingerprint(owner)}.mcp.json`);
  }

  /** The providers the owner holds a credential for, never the secrets; none where clients cannot set them. */
  async credentials(owner: string): Promise<CredentialInfo[]> {
    return [...((await this.#options.credentials?.(owner).list()) ?? [])];
  }

  /**
   * Keeps `key` as the owner's credential for `provider`, so the next request reaches it with the key; else why it
   * cannot: credentials here are not the clients' to set, or no such provider takes an API key.
   */
  async setKey(owner: string, provider: string, key: string): Promise<string | undefined> {
    const store = this.#options.credentials?.(owner);
    if (store === undefined) return FIXED_CREDENTIALS;
    if (this.#options.models(owner).getProvider(provider)?.auth.apiKey === undefined) return `there is no provider ${provider} that takes an API key`;
    await store.modify(provider, async () => ({ type: "api_key", key }));
    return undefined;
  }

  /** Forgets the owner's credential for `provider`; else why it cannot, as for `setKey`. */
  async removeKey(owner: string, provider: string): Promise<string | undefined> {
    const store = this.#options.credentials?.(owner);
    if (store === undefined) return FIXED_CREDENTIALS;
    await store.delete(provider);
    return undefined;
  }

  /** Every provider the owner's models know that a client can sign in to, each way in, and where its models are reached. */
  catalog(owner: string): ProviderEntry[] {
    const models = this.#options.models(owner);
    return models.getProviders().flatMap((provider) => {
      const { oauth, apiKey } = provider.auth;
      const ways = [
        ...(oauth === undefined ? [] : [{ type: "oauth" as const, name: oauth.loginLabel ?? oauth.name, subscription: oauth.isSubscription === true }]),
        ...(apiKey?.login === undefined ? [] : [{ type: "api_key" as const, name: apiKey.name, subscription: false }]),
      ];
      if (ways.length === 0) return [];
      const urls = [provider.baseUrl, ...models.getModels(provider.id).map((model) => model.baseUrl)];
      const hosts = [...new Set(urls.flatMap(hostOf))].sort();
      return [{ id: provider.id, name: provider.name, ways, hosts }];
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Why the owner cannot sign in to `provider` the `type` way here, or undefined when they can. */
  loginRefusal(owner: string, provider: string, type: AuthType): string | undefined {
    if (this.#options.credentials?.(owner) === undefined) return FIXED_CREDENTIALS;
    const auth = this.#options.models(owner).getProvider(provider)?.auth;
    const takes = type === "oauth" ? auth?.oauth !== undefined : auth?.apiKey?.login !== undefined;
    return takes ? undefined : `there is no provider ${provider} that takes ${type === "oauth" ? "a sign-in" : "a key"} here`;
  }

  /** Runs `provider`'s own `type` login with the owner through `interaction`, keeping what it yields as their credential. */
  async login(owner: string, provider: string, type: AuthType, interaction: AuthInteraction): Promise<void> {
    const problem = this.loginRefusal(owner, provider, type);
    if (problem !== undefined) throw new Error(problem);
    await this.#options.models(owner).login(provider, type, interaction, { agentName: "chopin", getDeviceId: () => fingerprint(owner) });
  }

  async #agent(owner: string, mode?: Extension): Promise<AgentChange | undefined> {
    const agent = this.#options.agent;
    const selected = typeof agent === "function" ? await agent(owner) : agent;
    if (selected?.extensions == null) return selected;
    return withMode(selected, mode ?? (await this.#openedFor(owner)).mode);
  }

  /** Hears of each conversation this service makes, until the returned function is called. */
  onConversation(listener: (owner: string, conversation: number) => void): () => void {
    this.#made.add(listener);
    return () => this.#made.delete(listener);
  }

  /**
   * Runs one prompt to its end in a new conversation of the owner's agent, and reports what happened in ACP together
   * with what it changed in the workspace.
   */
  async runTask(owner: string, prompt: string, context: Context): Promise<TaskRun> {
    const workspace = this.#options.workspaces?.open(owner);
    if (workspace === undefined) throw refusal("workspace_unavailable", "this service has no direct task workspace");
    this.touch(owner);
    await workspace.start();
    const base = await snapshot(workspace);
    const conversation = await this.newConversation(owner, context);
    const settled = await (await conversation.submit({ type: "input", content: prompt }, context)).wait(context);
    // Nobody comes back to a task's conversation, so it is not kept short for them.
    (await this.#openedFor(owner)).idle.cancel(conversation.id);
    const entries = await allEntries(conversation, context);
    const sessionId = String(conversation.id);
    const now = new Date().toISOString();
    const transcript: TranscriptEntry[] = entryTranscript(sessionId, entries, now);
    const answers = entries.flatMap((entry) => (entry.model ?? []).filter((m): m is AssistantMessage => m.role === "assistant"));
    const last = answers.at(-1);
    const { usage, cost } = totalUsage(answers);
    transcript.push({
      at: now,
      sessionId,
      turnEnd: withChopinMeta({ stopReason: stopReason(last), usage }, {
        ...(last && { model: { provider: last.provider, id: last.model } }),
        cost: { amount: cost, currency: "USD" },
        ...(settled.status === "unanswered" && { error: unansweredText(settled) }),
      }),
    });
    // Reclaim may have stopped the workspace while the agent was thinking.
    this.touch(owner);
    await workspace.start();
    return { transcript, diff: base === undefined ? undefined : await diff(workspace, base) };
  }

  /**
   * A conversation's input submissions as the owner's store records them: every one not settled yet, the latest
   * `limit`, newest first, and those of `also` the store still has, however old.
   */
  async submissions(owner: string, conversation: ConversationId, limit: number, also: readonly number[] = []): Promise<SubmissionRecord[]> {
    const { storage } = await this.#openedFor(owner);
    // Passive writes, such as one per compaction, sit among the inputs; they are skipped, not counted.
    // Pages a little larger than what is wanted leave room for the writes skipped among the inputs.
    const inputs = (query: SubmissionQuery, enough?: number) => drain(
      (cursor: Cursor | undefined) => storage.scanSubmissions(query, Math.min(64, (enough ?? 32) * 2), cursor, BACKGROUND_CONTEXT),
      (record) => record.type === "input",
      enough,
    );
    const [latest, queued, placed] = await Promise.all([
      inputs({ conversationId: conversation, order: "descending" }, limit),
      inputs({ conversationId: conversation, status: "queued" }),
      inputs({ conversationId: conversation, status: "placed" }),
    ]);
    const found = new Map([...latest, ...queued, ...placed].map((record) => [Number(record.id), record]));
    const older = await Promise.all(also.filter((id) => !found.has(id)).map((id) => storage.submission(id as SubmissionId, BACKGROUND_CONTEXT)));
    for (const record of older) if (record?.type === "input" && record.conversationId === conversation) found.set(Number(record.id), record);
    return [...found.values()];
  }


  /** Owners whose agents still have work: a live task, an unsettled submission, or a command of theirs running. */
  async working(): Promise<string[]> {
    const owners = await Promise.all([...this.#agents].map(async ([owner, agent]) => {
      if (this.#commands.has(owner)) return [owner];
      if (agent.ready === undefined) return [owner];
      try {
        const inspection = await agent.ready.harness.inspect(BACKGROUND_CONTEXT);
        agent.unclear = false;
        return agent.ready.idle.active || inspection.tasks.length > 0 || inspection.submissions.length > 0 || await agent.ready.goals?.store.active(BACKGROUND_CONTEXT) ? [owner] : [];
      } catch (error) {
        // One whose state cannot be told counts as working, so nothing is stopped under it; it is told once.
        if (!agent.unclear) this.#options.report?.(error);
        agent.unclear = true;
        return [owner];
      }
    }));
    return owners.flat();
  }

  /**
   * The owner's top-level conversations, read from the store without holding up its writes; a subagent's conversation
   * belongs to the task that made it.
   */
  async conversations(owner: string): Promise<number[]> {
    const { storage, goals } = await this.#openedFor(owner);
    const records = await drain(
      (cursor: Cursor | undefined) => storage.scanConversations({ order: "ascending" }, 256, cursor, BACKGROUND_CONTEXT),
    );
    const visible = await Promise.all(records.map(async (record) => topLevel(record) || goals !== undefined && await goals.store.forConversation(record.id, BACKGROUND_CONTEXT) !== undefined));
    return records.filter((_record, index) => visible[index]).map((record) => Number(record.id));
  }

  /** Whether `conversation` is one of the owner's top-level conversations, the only ones clients may use. */
  async isTopLevel(owner: string, conversation: number): Promise<boolean> {
    const { storage, goals } = await this.#openedFor(owner);
    const record = await storage.conversation(conversation as ConversationId, BACKGROUND_CONTEXT);
    return record !== undefined && (topLevel(record) || goals !== undefined && await goals.store.forConversation(record.id, BACKGROUND_CONTEXT) !== undefined);
  }

  /** The owner's harness for a client object, which gives it back with `release` once done with it. */
  async hold(owner: string): Promise<Harness> {
    this.#holds.set(owner, (this.#holds.get(owner) ?? 0) + 1);
    try {
      return await this.harness(owner);
    } catch (error) {
      this.release(owner);
      throw error;
    }
  }

  release(owner: string): void {
    const holds = (this.#holds.get(owner) ?? 1) - 1;
    if (holds > 0) this.#holds.set(owner, holds);
    else this.#holds.delete(owner);
  }

  /** Marks the owner's agent as in use, for what reaches it other than through this service. */
  touch(owner: string): void {
    this.#lastActive.set(owner, Date.now());
  }

  /** When the owner's agent was last in use, as idle reclaim reads it: an owner not seen since the start, from then. */
  lastActive(owner: string): number {
    return this.#lastActive.get(owner) ?? this.#started;
  }

  async close(context: Context): Promise<void> {
    this.#closed = true;
    clearInterval(this.#reclaiming);
    const opened = [...this.#agents.values()].map((agent) => agent.opened);
    this.#agents.clear();
    // An open that failed has already released what it held; agents a sweep is closing are waited for too.
    await Promise.all([
      ...opened.map(async (pending) => (await pending.catch(() => undefined))?.close(context)),
      ...[...this.#closing.values()].map((closing) => closing.catch(() => {})),
    ]);
  }

  #openedFor(owner: string): Promise<Opened> {
    if (this.#closed) return Promise.reject(new Error("the agent service is closed"));
    // Whatever reaches an owner's agent is activity, so its workspace is not reclaimed underneath it.
    this.touch(owner);
    let agent = this.#agents.get(owner);
    if (agent === undefined) {
      // A store belongs to one harness at a time: one still closing is waited for.
      const closing = this.#closing.get(owner) ?? Promise.resolve();
      const opened = closing.then(() => {
        if (this.#closed) throw new Error("the agent service is closed");
        return this.#open(owner, BACKGROUND_CONTEXT);
      });
      const entry: Agent = { opened, since: Date.now(), unclear: false };
      this.#agents.set(owner, entry);
      entry.opened.then((ready) => void (entry.ready = ready), () => {
        if (this.#agents.get(owner) === entry) this.#agents.delete(owner);
      });
      agent = entry;
    }
    return agent.opened;
  }

  async #open(owner: string, context: Context): Promise<Opened> {
    const report = this.#options.report ?? (() => {});
    const opening: { storage?: Storage; harness?: Harness; idle?: IdleCompaction; mcp?: McpServers; connection?: Connection; goals?: GoalEngine; retention?: { stop(): Promise<unknown> }; wake?: WakePublisher } = {};
    let harness: Harness | undefined;
    let goals: GoalEngine | undefined;
    let awake = false;
    const offerWake = () => { if (awake) opening.wake?.offer(); };
    try {
      // Restore and verify the store before invoking adapters that can perform external work.
      await mkdir(this.#options.dataDir, { recursive: true });
      await chmod(this.#options.dataDir, 0o700);
      const storage = opening.storage = await (this.#options.store === undefined
        ? openNodeSqliteStorage(join(this.#options.dataDir, `${fingerprint(owner)}.sqlite`))
        : this.#options.store(owner));
      if (storage === undefined || storage === null) throw new Error("the configured execution storage adapter returned no store");
      const workspace = this.#options.workspaces?.open(owner);
      const mcp = opening.mcp = new McpServers({ ...this.#options.layer?.mcpServers, ...await this.#clientServers(owner) }, workspace);
      const execution = workspace === undefined ? undefined : this.#workspaceEnv(owner, workspace);
      opening.connection = execution?.connection;
      const idle = opening.idle = new IdleCompaction({
        models: this.#options.models(owner),
        eligible: async (id) => {
          const record = await storage.conversation(id, BACKGROUND_CONTEXT);
          return record !== undefined && topLevel(record);
        },
        ...(this.#options.goals !== undefined && { authorize: (id: ConversationId, context: Context) => goals!.allowsModel(id, context) }),
        changed: offerWake,
        report,
      });
      const wake = opening.wake = this.#options.onWake === undefined ? undefined : new WakePublisher(async () => {
        const inspection = await harness!.inspect(BACKGROUND_CONTEXT);
        const unfinished = await goals?.store.active(BACKGROUND_CONTEXT);
        const native = harness!.wake();
        const active = native.active || idle.active || this.#commands.has(owner) || unfinished || inspection.submissions.length > 0 || inspection.tasks.some((task) => task.state.kind === "blocked");
        return { ...native, active: Boolean(active) };
      }, (value) => this.#options.onWake!(owner, value), report);
      const registered = new Set<string>();
      const configured = typeof this.#options.extensions === "function" ? await this.#options.extensions(owner) : this.#options.extensions ?? [];
      const mode = modeExtension((tool) => READ_ONLY.has(tool) || mcp.readOnly.has(tool));
      const extensions = this.#extensions(
        registered,
        configured,
        ...(await mcp.connect(report)),
        mode,
        idle.extension,
      );
      for (const tool of toolNames(extensions)) registered.add(tool);
      const told = new Set<string>();
      const tellMissing = () => {
        const missing = this.#checkGates(registered).filter((tool) => !told.has(tool));
        for (const tool of missing) told.add(tool);
        if (missing.length > 0) {
          report(new Error(`gates name ${missing.join(", ")}, which no MCP server offers yet, or answers; the calls they gate are refused`));
        }
      };
      tellMissing();
      const registry = createRegistry();
      for (const extension of extensions) registry.install(extension);
      // Tools of servers that answered at last, or that a client set since: gates on them are checked as they come.
      const install = (offered: readonly Extension[]) => {
        for (const extension of offered) {
          registry.install(extension);
          for (const tool of extension.tools ?? []) registered.add(tool.name);
        }
        if (offered.length > 0) tellMissing();
      };

      const goalOptions = this.#options.goals?.(owner);
      if (goalOptions !== undefined) { goals = opening.goals = new GoalEngine(goalOptions); for (const extension of goals.extensions) registry.install(extension); }
      harness = opening.harness = await Harness.open(storage, {
        models: this.#options.models(owner),
        registry,
        settings: () => goals?.settings(registry),
        ...(execution !== undefined && {
          env: async ({ conversationId, cwd }, context) => await goals?.isReview(conversationId, context) ? undefined : execution.env(cwd),
        }),
        onReport: report,
        ...(wake !== undefined && { onWake: offerWake }),
        ...(this.#options.layerVersions && { conversationCreated: pinLayerVersions(this.#options.layerVersions) }),
      }, context);
      goals?.attach(harness, storage);
      idle.attach(harness);
      const agent = await this.#agent(owner, mode);
      if (agent !== undefined) await harness.root(context, { agent });
      if (goals !== undefined && !goals.allowDirectConversations) {
        await harness.commit(async (tx) => { await tx.doc(ActiveGoals); }, context);
        const retention = await harness.watchDoc(ActiveGoals, context);
        if (retention === undefined) throw new Error("goal activity observation is missing");
        opening.retention = retention;
        retention.start(async (change) => {
          if (change.kind === "failed") report(change.error);
          else if (change.value.count === 0) idle.cancelAll();
          offerWake();
        });
      }
      awake = true;
      offerWake();
      if (this.#options.startPaused !== true) harness.resume();
      let trying = false;
      let retrying: NodeJS.Timeout | undefined;
      // Unreachable servers are tried again until every one answers, for as long as the agent is open.
      const keepTrying = () => {
        if (retrying !== undefined || mcp.unavailable.size === 0) return;
        retrying = setInterval(() => {
          // A server slow to answer is still being tried when the next try is due; that try is skipped.
          if (trying) return;
          trying = true;
          mcp.retry(report).then((back) => {
            install(back);
            if (mcp.unavailable.size === 0) {
              clearInterval(retrying);
              retrying = undefined;
            }
          }).catch(report).finally(() => void (trying = false));
        }, MCP_RETRY_MS);
        retrying.unref();
      };
      keepTrying();
      const opened = harness;
      return {
        harness: opened,
        storage,
        idle,
        mode,
        ...(wake !== undefined && { wake }),
        ...(goals === undefined ? {} : { goals }),
        ...(execution !== undefined && { env: execution.env }),
        mcp,
        serve: async (name, server) => {
          for (const tool of mcp.remove(name)) registered.delete(tool);
          registry.uninstall(defineExtension({ name: mcpExtensionName(name) }));
          if (server === undefined) return;
          install(await mcp.set(name, server, report));
          keepTrying();
        },
        close: async (closing) => {
          clearInterval(retrying);
          awake = false;
          const failures: unknown[] = [];
          for (const close of [
            () => wake?.close(),
            () => opening.retention?.stop(),
            () => idle.close(),
            () => opened.close(closing),
            () => goals?.close(),
            () => mcp.close(),
            () => execution?.connection.close(),
          ]) {
            try { await close(); }
            catch (error) { failures.push(error); }
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) throw new AggregateError(failures, "the execution service could not close every resource");
        },
      };
    } catch (error) {
      awake = false;
      const failures = [error];
      for (const close of [
        () => opening.wake?.close(),
        () => opening.retention?.stop(),
        () => opening.idle?.close(),
        () => opening.harness === undefined ? opening.storage?.close(context) : opening.harness.close(context),
        () => opening.goals?.close(),
        () => opening.mcp?.close(),
        () => opening.connection?.close(),
      ]) {
        try { await close(); }
        catch (closing) { failures.push(closing); }
      }
      if (failures.length > 1) throw new AggregateError(failures, "the execution service failed to open and close its resources");
      throw error;
    }
  }

  #extensions(registered: ReadonlySet<string>, configured: readonly Extension[], ...more: Extension[]): Extension[] {
    const base = this.#options.layer ?? (this.#options.layerVersions === undefined ? undefined : EMPTY_LAYER);
    const layer = base === undefined ? [] : [layerExtension(base, registered, this.#options.layerVersions)];
    const workspace = this.#options.workspaces !== undefined;
    return [...(workspace ? [CodingTools] : []), ...layer, ...(workspace ? [projectContext] : []), clientContext, ...configured, ...more];
  }

  /**
   * Throws on gate rules naming a tool nothing could ever register. A tool of an MCP server is no such tool: the
   * server may lack it now and offer it later, so it is returned for telling, and calls gated on it are refused.
   */
  #checkGates(registered: ReadonlySet<string>): string[] {
    const gates = this.#options.layer?.gates ?? [];
    const servers = Object.keys(this.#options.layer?.mcpServers ?? {});
    const missing = [...new Set(gates.flatMap((rule) => [rule.tool, ...rule.requires]))].filter((tool) => !registered.has(tool));
    const fromMcp = missing.filter((tool) => servers.some((server) => isMcpToolOf(server, tool)));
    const problems = checkGates(gates, new Set([...registered, ...fromMcp]));
    if (problems.length > 0) throw new Error(`invalid gate rules:\n${problems.join("\n")}`);
    return fromMcp;
  }

  #reclaim(workspaces: WorkspaceProvider, idleMs: number): NodeJS.Timeout {
    // A sweep still stopping workspaces when the next is due is left to finish rather than joined by another.
    let sweeping = false;
    const sweep = setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      this.#sweep(workspaces, idleMs).catch((error: unknown) => this.#options.report?.(error)).finally(() => void (sweeping = false));
    }, Math.min(idleMs, 5 * 60_000));
    sweep.unref();
    return sweep;
  }

  /** Stops idle owners' workspaces; an owner whose agent still has work counts as active, however long it runs. */
  async #sweep(workspaces: WorkspaceProvider, idleMs: number): Promise<void> {
    const now = Date.now();
    // An agent at work is in use now, so its idle time runs from when it stops, not from its last tool call.
    for (const owner of await this.working()) this.touch(owner);
    const { failed } = await reclaimIdle(workspaces, (owner) => this.lastActive(owner), idleMs, now);
    for (const { owner, error } of failed) this.#options.report?.(new Error(`could not reclaim the workspace of ${owner}`, { cause: error }));
    // An agent no client holds that has been idle as long is closed too, so a service that has seen many owners
    // keeps open only those in use; the next use opens it again, resuming what it left.
    const idle = [...this.#agents].flatMap(([owner, { ready }]) =>
      ready === undefined || this.#holds.has(owner) || Date.now() - this.lastActive(owner) < idleMs ? [] : [{ owner, ready }]);
    await Promise.all(idle.map(async ({ owner, ready }) => {
      this.#agents.delete(owner);
      this.#lastActive.delete(owner);
      const closing = ready.close(BACKGROUND_CONTEXT);
      this.#closing.set(owner, closing);
      try {
        await closing;
        if (this.#closing.get(owner) === closing) this.#closing.delete(owner);
      } catch (error) {
        // Its store may still be open, so it stays in #closing: the owner is refused until a restart rather than
        // given a second harness on the same store.
        this.#options.report?.(new Error(`the agent of ${owner} could not be closed; it is refused until the service restarts`, { cause: error }));
      }
    }));
  }

  #workspaceEnv(owner: string, workspace: Workspace) {
    const id = `workspace:${fingerprint(owner)}`;
    const connection = new Connection({ command: async () => {
      await workspace.start();
      return workspace.command([this.#options.daemon ?? DAEMON_PATH]).argv;
    } });
    return { connection, env: (cwd = workspace.root) => {
      this.touch(owner);
      return new OwnerEnv({ connection, id, cwd }, () => this.#variables.get(owner));
    } };
  }
}

function allEntries(conversation: Conversation, context: Context): Promise<EntryRecord[]> {
  return drain((cursor: Cursor | undefined) => conversation.entries({ order: "ascending" }, 256, cursor, context));
}

function toolNames(extensions: readonly Extension[]): string[] {
  return extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name));
}

function fingerprint(owner: string): string {
  return createHash("sha256").update(owner).digest("hex").slice(0, 16);
}

/** The workspace as the owner's agent runs commands in it: each command also gets the variables the owner's clients set. */
class OwnerEnv extends RemoteExecutionEnv {
  readonly #variables: () => ReadonlyMap<string, string> | undefined;

  constructor(options: ConstructorParameters<typeof RemoteExecutionEnv>[0], variables: () => ReadonlyMap<string, string> | undefined) {
    super(options);
    this.#variables = variables;
  }

  override exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const variables = this.#variables();
    if (variables === undefined || variables.size === 0) return super.exec(command, options, context);
    return super.exec(command, { ...options, env: { ...options?.env, ...Object.fromEntries(variables) } }, context);
  }
}

/** The host `url` names, or none for no URL or one that does not parse. */
function hostOf(url: string | undefined): string[] {
  if (url === undefined || !URL.canParse(url)) return [];
  return [new URL(url).hostname];
}

/** A conversation clients see and use: neither the harness's reserved root nor one a task made. */
function topLevel(record: { id: ConversationId; owner?: unknown }): boolean {
  return record.owner === undefined && record.id !== ROOT_CONVERSATION_ID;
}
