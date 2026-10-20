import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import {
  CompactionEntry,
  createRegistry,
  Harness,
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
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { checkGates, isMcpToolOf, withChopinMeta, type Layer, type TaskRun, type TranscriptEntry } from "@chopin-ai/core";
import { diff, reclaimIdle, snapshot, type Workspace, type WorkspaceProvider } from "@chopin-ai/workspace";
import { entryTranscript, stopReason, totalUsage, unansweredText, userText } from "./acp.js";
import { layerExtension } from "./layer.js";
import { McpServers } from "./mcp.js";
import { drain } from "./pages.js";
import { modeExtension, NameDoc } from "./mode.js";
import type { Loaded, Summary } from "./protocol.js";
import { runShell, ShellEntry, type ShellRun } from "./shell.js";

/** Built-in tools that change nothing, so a read-only conversation may still use them. */
const READ_ONLY = new Set(["read", "skill"]);

/** How long an open under way counts as an agent at work. */
const OPEN_PATIENCE_MS = 10 * 60_000;

/** How often an owner's unreachable MCP servers are tried again. */
const MCP_RETRY_MS = 30_000;

/** Where the workspace image keeps the execution daemon. */
export const DAEMON_PATH = "/usr/local/bin/pi-env";

export interface AgentServiceOptions {
  /** Holds one store per owner. It must not be reachable from any workspace. */
  dataDir: string;
  workspaces: WorkspaceProvider;
  /** The models an owner's agent may use, carrying that owner's credentials. */
  models: (owner: string) => Models;
  /** What a new conversation of an owner runs with, such as its model; asked again for each, so a default may change. */
  agent?: AgentChange | ((owner: string) => Promise<AgentChange | undefined>);
  /** The portable layer every agent loads. */
  layer?: Layer;
  /** Installed after the coding tools and the layer. */
  extensions?: readonly Extension[];
  /** Failures that do not fail the call at hand, such as an unreachable MCP server. */
  report?: (error: unknown) => void;
  /** The execution daemon as the workspace runs it; the workspace image's by default. */
  daemon?: string;
  /** Stops workspaces whose owner has been idle this long, keeping their volumes; never when absent. */
  reclaimAfterMs?: number;
}

interface Opened {
  harness: Harness;
  storage: Storage;
  /** The owner's workspace as the agent's tools reach it. */
  env(): RemoteExecutionEnv;
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
 * Hosts one durable harness per owner. The agent and its store live here; its tools reach the owner's workspace
 * only through the execution daemon, which starts the workspace on first use and again after it was reclaimed.
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
  /** When this service started, which is as recent as anything it knows of an owner it has not seen. */
  readonly #started = Date.now();
  readonly #lastActive = new Map<string, number>();
  readonly #reclaiming: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: AgentServiceOptions) {
    this.#options = options;
    this.#reclaiming = options.reclaimAfterMs === undefined ? undefined : this.#reclaim(options.reclaimAfterMs);
    // MCP tools are only known once their servers answer; gates on them are checked again when an owner opens.
    this.#checkGates(new Set(toolNames(this.#extensions(new Set()))));
  }

  /**
   * The owner's harness, opened on first use; unfinished work resumes. Every caller shares the one opening, so it
   * runs on the service's own context: a caller that gives up fails no other.
   */
  async harness(owner: string): Promise<Harness> {
    return (await this.#openedFor(owner)).harness;
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
   * messages it holds, and when it began and last changed.
   */
  async summaries(owner: string, context: Context): Promise<Summary[]> {
    const harness = await this.harness(owner);
    const lines = await Promise.all((await this.conversations(owner)).map(async (id): Promise<Summary> => {
      const conversation = await harness.conversation(id as ConversationId, context);
      const messages = conversation === undefined ? [] : (await allEntries(conversation, context))
        .flatMap((entry) => entry.kind === CompactionEntry.kind || entry.kind === ShellEntry.kind ? [] : entry.model ?? [])
        .filter((message) => message.role === "user" || message.role === "assistant");
      const first = messages.find((message) => message.role === "user");
      const times = messages.map((message) => message.timestamp).filter((time) => Number.isFinite(time));
      return {
        id,
        name: (await harness.snapshot(NameDoc, id as ConversationId, context))?.name ?? "",
        first: first === undefined ? "" : userText(first.content),
        messages: messages.length,
        created: times.length === 0 ? 0 : Math.min(...times),
        modified: times.length === 0 ? 0 : Math.max(...times),
      };
    }));
    return lines.sort((a, b) => b.modified - a.modified);
  }

  /** What every agent here loads besides its tools: whether it has instructions, its skills and its MCP servers. */
  get loaded(): Loaded {
    const layer = this.#options.layer;
    return { instructions: layer?.instructions !== undefined, skills: layer?.skills.map((skill) => skill.name) ?? [], mcpServers: Object.keys(layer?.mcpServers ?? {}) };
  }

  /** A conversation of the owner's whole, as transcript lines. */
  async transcript(owner: string, conversation: Conversation, context: Context): Promise<TranscriptEntry[]> {
    this.touch(owner);
    return entryTranscript(String(conversation.id), await allEntries(conversation, context));
  }

  /** Runs a command of the owner's in their workspace, as the agent's shell tool runs its own. */
  async shell(owner: string, command: string, onOutput: (kept: string) => Promise<unknown>, context: Context): Promise<Omit<ShellRun, "command" | "excluded">> {
    const env = (await this.#openedFor(owner)).env();
    // A command at work is the agent at work: nothing hands over or reclaims under it.
    this.#commands.set(owner, (this.#commands.get(owner) ?? 0) + 1);
    try {
      return await runShell(env, command, onOutput, context);
    } finally {
      const left = (this.#commands.get(owner) ?? 1) - 1;
      if (left > 0) this.#commands.set(owner, left);
      else this.#commands.delete(owner);
      this.touch(owner);
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

  async #agent(owner: string): Promise<AgentChange | undefined> {
    const agent = this.#options.agent;
    return typeof agent === "function" ? agent(owner) : agent;
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
    const workspace = this.#options.workspaces.open(owner);
    this.touch(owner);
    await workspace.start();
    const base = await snapshot(workspace);
    const conversation = await this.newConversation(owner, context);
    const settled = await (await conversation.submit({ type: "input", content: prompt }, context)).wait(context);
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
      // One still opening is working, for a while: it is not waited on, so a slow open holds up nobody else, and
      // one that never finishes does not keep its workspace from being reclaimed.
      if (agent.ready === undefined) return Date.now() - agent.since < OPEN_PATIENCE_MS ? [owner] : [];
      try {
        const inspection = await agent.ready.harness.inspect(BACKGROUND_CONTEXT);
        agent.unclear = false;
        return inspection.tasks.length > 0 || inspection.submissions.length > 0 ? [owner] : [];
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
    const { storage } = await this.#openedFor(owner);
    const records = await drain(
      (cursor: Cursor | undefined) => storage.scanConversations({ order: "ascending" }, 256, cursor, BACKGROUND_CONTEXT),
      topLevel,
    );
    return records.map((record) => Number(record.id));
  }

  /** Whether `conversation` is one of the owner's top-level conversations, the only ones clients may use. */
  async isTopLevel(owner: string, conversation: number): Promise<boolean> {
    const { storage } = await this.#openedFor(owner);
    const record = await storage.conversation(conversation as ConversationId, BACKGROUND_CONTEXT);
    return record !== undefined && topLevel(record);
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
    const workspace = this.#options.workspaces.open(owner);
    const mcp = new McpServers(this.#options.layer?.mcpServers ?? {}, workspace);
    const connection = new Connection({ command: () => this.#daemon(workspace) });
    let storage: Storage | undefined;
    let harness: Harness | undefined;
    try {
      const registered = new Set<string>();
      const extensions = this.#extensions(
        registered,
        ...(await mcp.connect(report)),
        modeExtension((tool) => READ_ONLY.has(tool) || mcp.readOnly.has(tool)),
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

      const id = `workspace:${fingerprint(owner)}`;
      const env = (cwd = workspace.root) => {
        this.touch(owner);
        return new RemoteExecutionEnv({ connection, id, cwd });
      };
      // Conversations are private to their owner; nobody else on the machine reads the store.
      await mkdir(this.#options.dataDir, { recursive: true });
      await chmod(this.#options.dataDir, 0o700);
      storage = await openNodeSqliteStorage(join(this.#options.dataDir, `${fingerprint(owner)}.sqlite`));
      harness = await Harness.open(storage, {
        models: this.#options.models(owner),
        registry,
        env: ({ cwd }) => env(cwd),
        onReport: report,
      }, context);
      const agent = await this.#agent(owner);
      if (agent !== undefined) await harness.root(context, { agent });
      harness.resume();
      let trying = false;
      const retrying = mcp.unavailable.size === 0 ? undefined : setInterval(() => {
        // A server slow to answer is still being tried when the next try is due; that try is skipped.
        if (trying) return;
        trying = true;
        mcp.retry(report).then((back) => {
          for (const extension of back) {
            registry.install(extension);
            for (const tool of extension.tools ?? []) registered.add(tool.name);
          }
          // Gates on the tools of a server that answered at last are checked now, as they could not be at open.
          if (back.length > 0) tellMissing();
          if (mcp.unavailable.size === 0) clearInterval(retrying);
        }).catch(report).finally(() => void (trying = false));
      }, MCP_RETRY_MS);
      retrying?.unref();
      const opened = harness;
      return {
        harness: opened,
        storage,
        env,
        close: async (closing) => {
          clearInterval(retrying);
          try {
            await opened.close(closing);
          } finally {
            await mcp.close();
            connection.close();
          }
        },
      };
    } catch (error) {
      // An open harness owns its store; before that, the store is still this call's to close.
      await (harness === undefined ? storage?.close(context) : harness.close(context))?.catch(() => {});
      await mcp.close();
      connection.close();
      throw error;
    }
  }

  #extensions(registered: ReadonlySet<string>, ...more: Extension[]): Extension[] {
    const layer = this.#options.layer === undefined ? [] : [layerExtension(this.#options.layer, registered)];
    return [CodingTools, ...layer, ...(this.#options.extensions ?? []), ...more];
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

  #reclaim(idleMs: number): NodeJS.Timeout {
    // A sweep still stopping workspaces when the next is due is left to finish rather than joined by another.
    let sweeping = false;
    const sweep = setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      this.#sweep(idleMs).catch((error: unknown) => this.#options.report?.(error)).finally(() => void (sweeping = false));
    }, Math.min(idleMs, 5 * 60_000));
    sweep.unref();
    return sweep;
  }

  /** Stops idle owners' workspaces; an owner whose agent still has work counts as active, however long it runs. */
  async #sweep(idleMs: number): Promise<void> {
    const now = Date.now();
    // An agent at work is in use now, so its idle time runs from when it stops, not from its last tool call.
    for (const owner of await this.working()) this.touch(owner);
    const { failed } = await reclaimIdle(this.#options.workspaces, (owner) => this.lastActive(owner), idleMs, now);
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

  async #daemon(workspace: Workspace): Promise<readonly string[]> {
    await workspace.start();
    // No variables are carried, so the command line is the whole launch.
    return workspace.command([this.#options.daemon ?? DAEMON_PATH]).argv;
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

/** A conversation clients see and use: neither the harness's reserved root nor one a task made. */
function topLevel(record: { id: ConversationId; owner?: unknown }): boolean {
  return record.owner === undefined && record.id !== ROOT_CONVERSATION_ID;
}
