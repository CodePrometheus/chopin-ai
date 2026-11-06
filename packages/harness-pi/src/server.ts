import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { acceptWebSockets, createHost, forbidden, invalid, type Context, type Ctx, type Host } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { AuthEvent, AuthPrompt, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { configure, InboxDoc, type ConversationId, type ConversationView, type ModelRef, type Submission, type SubmissionId, type UserInput } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { WebSocketServer } from "ws";
import { credentialOf, type Authenticate } from "./auth.js";
import { statusHandler } from "./http.js";
import { ClientContextDoc } from "./client-context.js";
import { ModeDoc, NameDoc } from "./mode.js";
import { isRunning, userText } from "./acp.js";
import {
  Conversation, Conversations, CredentialSchema, Credentials, Environment, HOST, LoginSchema, Loop, Mcp, McpServerSchema, ModeSchema, REWIND_KIND, RunningSchema, SubmissionSchema, Vault,
  errorChain, errorText, type Image, type LoginEvent, type LoginPrompt, type LoginState, type LoopControl, type Principal,
} from "./protocol.js";
import { backoff } from "./backoff.js";
import { AgentService } from "./service.js";
import { shellEntry } from "./shell.js";
import { lost, merge, outcomeOf, progressOf, RECENT_SUBMISSIONS, type Outcome } from "./submissions.js";

/** A login nobody finishes ends after this, which outlasts the device codes providers hand out. */
const LOGIN_LIMIT_MS = 20 * 60_000;
/** How much of what a login said its state keeps, the latest first to go last. */
const LOGIN_EVENTS = 8;

/**
 * A service that opens only once a client hands it its key, so nothing of its owner's is read before: until then,
 * clients reach the vault alone.
 */
export interface Sealed {
  /** The service, once open. */
  readonly service: AgentService | undefined;
  /** Opens the service with `key`, or checks the key once it is open; a key it was not first unlocked with fails with `WrongKey`. */
  unlock(key: Uint8Array): Promise<void>;
}

/** A key other than the one a sealed service was first unlocked with. */
export class WrongKey extends Error {
  constructor() {
    super("this is not the key the service was first unlocked with");
  }
}

/**
 * Serves the client protocol for `source`, and `loop` if it has one; every object belongs to the owner that asked for
 * it. A sealed source serves the vault alone until it is unlocked.
 */
export function createAgentHost(source: AgentService | Sealed, loop?: LoopControl): Host<Principal> {
  const host = createHost<Principal>({
    name: HOST,
    self: { kind: "host" },
    principalKey: (principal) => (principal.kind === "owner" ? `owner:${principal.owner}` : "host"),
  });
  const sealed = source instanceof AgentService ? undefined : source;
  // Objects are made anew for each client that asks, so one asked for while locked is refused, and made once open.
  const current = (): AgentService => {
    const service = sealed === undefined ? source as AgentService : sealed.service;
    if (service === undefined) throw invalid("locked", "the service is locked until a client unlocks it with its key");
    return service;
  };
  /** Tells every vault a client holds that the service is open. */
  const unlocked = new Set<() => void>();

  host.serve(Vault, (_input, principal, self) => {
    ownerOf(principal);
    const locked = self.state("locked", Type.Boolean(), { init: () => sealed !== undefined && sealed.service === undefined });
    self.resource("unlocked", {
      version: 1,
      open: () => {
        const tell = () => void host.root((root) => locked.replace(root, false)).catch(() => {});
        unlocked.add(tell);
        return tell;
      },
      close: (tell) => void unlocked.delete(tell),
    });
    return {
      variant: "owner",
      locked,
      unlock: async ({ key }) => {
        if (sealed === undefined) throw invalid("not_sealed", "this service keeps nothing sealed, so it takes no key");
        await sealed.unlock(Buffer.from(key, "base64url")).catch((error: unknown) => {
          throw error instanceof WrongKey ? invalid("wrong_key", error.message) : invalid("unlock_failed", errorChain(error));
        });
        for (const tell of unlocked) tell();
      },
    };
  });

  host.serve(Conversations, (_input, principal, self) => {
    const owner = ownerOf(principal);
    const service = current();
    // A conversation made anywhere, such as by a task run, joins the list while it is held.
    let unhear = () => {};
    const harness = self.resource("harness", {
      version: 1,
      open: async () => {
        const held = await service.hold(owner);
        unhear = service.onConversation((maker, id) => {
          if (maker === owner) void host.root((root) => add(root, id)).catch(() => {});
        });
        return held;
      },
      close: () => {
        unhear();
        service.release(owner);
      },
    });
    const ids = self.state("ids", Type.Array(Type.Number()), { init: () => service.conversations(owner) });
    const add = (ctx: Ctx<Principal>, id: number) => ids.change(ctx, (draft) => {
      if (!draft.includes(id)) draft.push(id);
    });
    return {
      variant: "owner",
      ids,
      loaded: (ctx) => service.loaded(owner, durable(ctx)),
      create: async (ctx) => {
        const conversation = await service.newConversation(owner, durable(ctx));
        add(ctx, conversation.id);
        return conversation.id;
      },
      summaries: (ctx) => service.summaries(owner, durable(ctx)),
      models: () => service.modelChoices(owner),
      fork: async ({ conversation, at }, ctx) => {
        const fork = await service.fork(owner, conversation, at, durable(ctx));
        if (fork === undefined) throw invalid("unknown_conversation", `no conversation ${conversation}`);
        add(ctx, fork);
        return fork;
      },
    };
  });

  host.serve(Conversation, ({ conversation: id }, principal, self) => {
    const owner = ownerOf(principal);
    const service = current();
    const opened = self.resource("conversation", {
      version: 1,
      open: async () => {
        const harness = await service.hold(owner);
        try {
          // Only a top-level conversation is the owner's to use; the harness's root and a task's own are not.
          const conversation = await service.isTopLevel(owner, id) ? await harness.conversation(id as ConversationId, BACKGROUND_CONTEXT) : undefined;
          if (conversation === undefined) throw invalid("unknown_conversation", `no conversation ${id}`);
          return { harness, conversation, view: await conversation.viewState(BACKGROUND_CONTEXT) };
        } catch (error) {
          service.release(owner);
          throw error;
        }
      },
      close: ({ view }) => {
        service.release(owner);
        // What was started for this object stops with it: retries, and waits for submissions to end.
        closed = true;
        clearTimeout(retry);
        closing.abort();
        view.dispose();
      },
    });
    let closed = false;
    const closing = new AbortController();
    const alive = withAbortSignal(closing.signal, BACKGROUND_CONTEXT);
    let retry: ReturnType<typeof setTimeout> | undefined;
    const view = self.state("view", Type.Unknown(), { init: () => opened.value.view.value });
    const mode = self.state("mode", ModeSchema, {
      init: async (ctx) => (await opened.value.harness.snapshot(ModeDoc, id as ConversationId, durable(ctx)))?.mode ?? "full",
    });
    const name = self.state("name", Type.String(), {
      init: async (ctx) => (await opened.value.harness.snapshot(NameDoc, id as ConversationId, durable(ctx)))?.name ?? "",
    });
    // How submissions ended is the store's to say: every one the harness has not settled, the latest few, and any
    // a client still waits on, however old.
    const read = async (running: readonly number[]) => {
      const known: Record<string, Outcome> = {};
      for (const id of running) known[String(id)] = lost("the store no longer has it");
      for (const record of await service.submissions(owner, opened.value.conversation.id, RECENT_SUBMISSIONS, running)) {
        known[String(record.id)] = outcomeOf(record);
        if (known[String(record.id)]?.status === "pending") awaitEnd(record.id);
      }
      return known;
    };
    // Submissions end as entries arrive or a run's inputs change; tokens streaming in between change neither.
    let progress = "";
    const submissions = self.state("submissions", Type.Record(Type.String(), SubmissionSchema), {
      // A store that cannot be read yet leaves the list empty for a retry to fill, rather than failing the object.
      init: async () => {
        progress = progressOf(opened.value.view.value as ConversationView);
        return read([]).catch((): Record<string, Outcome> => {
          retryRead();
          return {};
        });
      },
    });
    const unsettled = () => Object.keys(submissions.value).filter((id) => submissions.value[id]?.status === "pending").map(Number);
    let reading = false;
    let stale = false;
    const retries = backoff(1_000, 30_000);
    const reread = (): void => {
      if (closed) return;
      if (reading) return void (stale = true);
      reading = true;
      void (async () => {
        do {
          stale = false;
          const known = await read(unsettled());
          await host.root((root) => submissions.change(root, (draft) => merge(draft, known)));
        } while (stale);
        clearTimeout(retry);
        retries.reset();
      })().catch(retryRead).finally(() => void (reading = false));
    };
    // A store that cannot be read is tried again, waiting longer each time, for as long as anyone holds this object.
    function retryRead(): void {
      if (closed) return;
      clearTimeout(retry);
      retry = setTimeout(reread, retries.next());
      retry.unref();
    }
    self.on("view", opened, ({ view: source }) => source, (value, ctx) => {
      view.replace(ctx, value);
      const now = progressOf(value as ConversationView);
      if (now === progress) return;
      progress = now;
      reread();
    });
    // One command of the user's runs at a time, until it ends, esc stops it, or this object closes.
    const running = self.state("running", RunningSchema, { init: () => null });
    let stopCommand: AbortController | undefined;
    // Each unsettled submission is waited on once, so its end is read from the store however it comes about, with
    // or without a new entry; however the wait ends, the store says how it did.
    const awaited = new Set<number>();
    function awaitEnd(id: SubmissionId | number, submission?: Submission): void {
      if (closed || awaited.has(Number(id))) return;
      awaited.add(Number(id));
      void Promise.resolve(submission ?? opened.value.harness.submission(id as SubmissionId, alive))
        .then((found) => found?.wait(alive))
        // Settled or failed, the wait is over; a read that still finds the submission running starts another.
        .finally(() => awaited.delete(Number(id)))
        .then(reread, reread);
    }
    // A message taken in, as `submit` and `requeue` both put one, followed to its end like every submission.
    const admit = async (content: UserInput, steer: boolean, request: string | undefined, ctx: Ctx<Principal>) => {
      const submission = await opened.value.conversation.submit({
        type: "input",
        content,
        ...(steer && { whenBusy: "steer" as const }),
        ...(request !== undefined && { requestId: request }),
      }, durable(ctx));
      submissions.change(ctx, (draft) => void (draft[String(submission.id)] ??= { status: "pending" }));
      awaitEnd(submission.id, submission);
      reread();
      return submission.id;
    };
    return {
      variant: "owner",
      view,
      mode,
      name,
      submissions,
      running,
      submit: async ({ text, images = [], steer, request }, ctx) => {
        service.touch(owner);
        return admit(messageContent(text, images), steer === true, request, ctx);
      },
      retry: async ({ text, images = [] }, ctx) => {
        service.touch(owner);
        const { conversation } = opened.value;
        if (isRunning(opened.value.view.value as ConversationView)) throw invalid("busy", "the agent is still at work; stop it first");
        const { entries } = await conversation.context(durable(ctx));
        const at = entries.findLastIndex((entry) => entry.kind === "pi.user");
        const asked = entries[at]?.model?.find((message) => message.role === "user");
        if (asked?.role !== "user") throw invalid("nothing_to_retry", "no message has been sent yet");
        const content = text === undefined && images.length === 0 ? asked.content : messageContent(text ?? "", images);
        await conversation.submit({
          type: "write",
          entry: { kind: REWIND_KIND, edits: entries.slice(at).map((entry) => ({ target: entry.id, action: "omit" as const })) },
        }, durable(ctx));
        return admit(content, false, undefined, ctx);
      },
      reset: async ({ handoff }, ctx) => {
        service.touch(owner);
        await opened.value.conversation.reset(handoff, durable(ctx));
      },
      requeue: async ({ queue }, ctx) => {
        service.touch(owner);
        const { harness, conversation } = opened.value;
        const queued = ((await harness.snapshot(InboxDoc, conversation.id, durable(ctx)))?.items ?? []).filter((item) => item.mode !== "write");
        const byId = new Map(queued.map((item) => [Number(item.id), item]));
        if (new Set(queue.map(({ id }) => id)).size !== queue.length) throw invalid("listed_twice", "the new queue lists each message once");
        // One no longer queued, as the agent took it up since the client looked, stays sent and is passed over.
        const wanted = queue.flatMap(({ id, text, steer }) => {
          const item = byId.get(id);
          if (item === undefined) return [];
          const content = item.content as UserInput;
          return [{ item, content: text === undefined ? content : retext(content, text), steer: steer ?? item.mode === "steer" }];
        });
        // What comes before the first change stays queued as it is; from there on, what can still be taken back is, and
        // is put again as wanted. One the agent took up meanwhile stays sent.
        let from = 0;
        while (from < queued.length && wanted[from]?.item === queued[from] && wanted[from]?.content === queued[from]?.content
          && wanted[from]?.steer === (queued[from]?.mode === "steer")) from++;
        const taken = new Set<unknown>();
        for (const item of queued.slice(from)) {
          if ((await harness.abortSubmission(item.id, durable(ctx), conversation.id).catch(() => undefined)) === "aborted") taken.add(item);
        }
        for (const { item, content, steer } of wanted.slice(from)) if (taken.has(item)) await admit(content, steer, undefined, ctx);
      },
      abort: async (_args, ctx) => {
        service.touch(owner);
        await opened.value.conversation.abort(durable(ctx));
      },
      stopCommand: async () => {
        service.touch(owner);
        stopCommand?.abort();
      },
      transcript: async (_args, ctx) => service.transcript(owner, opened.value.conversation, durable(ctx)),
      shell: async ({ command, excluded = false }, ctx) => {
        service.touch(owner);
        if (stopCommand !== undefined) throw invalid("command_running", "a command is already running; esc stops it");
        const stop = (stopCommand = new AbortController());
        const shown = { command, output: "", excluded };
        running.replace(ctx, shown);
        try {
          const run = await service.shell(owner, command, (output) => host.root((root) => running.replace(root, { ...shown, output })),
            withAbortSignal(AbortSignal.any([stop.signal, closing.signal]), BACKGROUND_CONTEXT));
          await opened.value.conversation.submit({ type: "write", entry: shellEntry({ command, excluded, ...run }) }, BACKGROUND_CONTEXT);
        } finally {
          stopCommand = undefined;
          await host.root((root) => running.replace(root, null)).catch(() => {});
        }
      },
      withdraw: async (_args, ctx) => {
        service.touch(owner);
        const { harness, conversation } = opened.value;
        const inbox = await harness.snapshot(InboxDoc, conversation.id, durable(ctx));
        const texts: string[] = [];
        for (const item of inbox?.items ?? []) {
          if (item.mode === "write") continue;
          // One the agent took up meanwhile is no longer queued, and stays sent; one that cannot be withdrawn stays
          // queued, so what was taken back is still given back.
          const withdrawn = await harness.abortSubmission(item.id, durable(ctx), conversation.id).catch(() => undefined);
          if (withdrawn === "aborted") texts.push(userText(item.content as UserInput));
        }
        reread();
        return texts;
      },
      setModel: async ({ provider, modelId }, ctx) => {
        service.touch(owner);
        const problem = await service.modelProblem(owner, { provider, modelId });
        if (problem !== undefined) throw invalid("unusable_model", problem);
        await opened.value.conversation.commit((tx) => configure(tx, opened.value.conversation.id, { model: { provider, modelId } }), durable(ctx));
      },
      setName: async ({ name: next }, ctx) => {
        service.touch(owner);
        await opened.value.conversation.commit(async (tx) => {
          (await tx.doc(NameDoc, opened.value.conversation.id)).name = next;
        }, durable(ctx));
        name.replace(ctx, next);
      },
      setContext: async ({ text }, ctx) => {
        await opened.value.conversation.commit(async (tx) => {
          (await tx.doc(ClientContextDoc, opened.value.conversation.id)).text = text;
        }, durable(ctx));
      },
      setThinking: async ({ level }, ctx) => {
        service.touch(owner);
        const model = (view.value as ConversationView).docs["pi.agent"]?.model as ModelRef | undefined;
        const problem = model === undefined ? "the conversation has no model yet" : service.thinkingProblem(owner, model, level);
        if (problem !== undefined) throw invalid("unusable_thinking", problem);
        await opened.value.conversation.commit((tx) => configure(tx, opened.value.conversation.id, { thinkingLevel: level as ModelThinkingLevel }), durable(ctx));
      },
      compact: async ({ instructions }, ctx) => {
        service.touch(owner);
        await opened.value.conversation.compact(instructions, durable(ctx));
      },
      setMode: async ({ mode: next }, ctx) => {
        service.touch(owner);
        await opened.value.conversation.commit(async (tx) => {
          (await tx.doc(ModeDoc, opened.value.conversation.id)).mode = next;
        }, durable(ctx));
        mode.replace(ctx, next);
      },
    };
  });

  host.serve(Credentials, (_input, principal, self) => {
    const owner = ownerOf(principal);
    const service = current();
    const listed = async () => (await service.credentials(owner)).map(({ providerId, type }) => ({ provider: providerId, type }));
    const providers = self.state("providers", Type.Array(CredentialSchema), { init: listed });
    const settled = async (problem: string | undefined, ctx: Ctx<Principal>) => {
      if (problem !== undefined) throw invalid("credential_refused", problem);
      providers.replace(ctx, await listed());
    };
    // A login outlives the call that starts it: it waits on the owner's answers and the provider, until it ends, a
    // newer one replaces it, the bound passes or this object closes.
    const login = self.state("login", Type.Union([LoginSchema, Type.Null()]), null);
    let running: { id: number; stop: AbortController; asked: Map<number, (value: string) => void> } | undefined;
    let ids = 0;
    self.resource("logins", { version: 1, open: () => true, close: () => running?.stop.abort() });
    return {
      variant: "owner",
      providers,
      login,
      setKey: async ({ provider, key }, ctx) => settled(await service.setKey(owner, provider, key), ctx),
      remove: async ({ provider }, ctx) => settled(await service.removeKey(owner, provider), ctx),
      catalog: async () => service.catalog(owner),
      startLogin: async ({ provider, type }, ctx) => {
        const problem = service.loginRefusal(owner, provider, type);
        if (problem !== undefined) throw invalid("credential_refused", problem);
        running?.stop.abort();
        const mine = { id: ++ids, stop: new AbortController(), asked: new Map<number, (value: string) => void>() };
        running = mine;
        let shown: LoginState = { id: mine.id, provider, type, status: "running", events: [] };
        login.replace(ctx, shown);
        const show = (next: LoginState) => {
          if (running !== mine) return;
          shown = next;
          void host.root((root) => login.replace(root, next)).catch(() => {});
        };
        let late = false;
        const bound = setTimeout(() => {
          late = true;
          mine.stop.abort();
        }, LOGIN_LIMIT_MS);
        const end = (status: LoginState["status"], error?: string) => {
          const { prompt: _asked, ...rest } = shown;
          show({ ...rest, status, ...(error === undefined ? {} : { error }) });
          if (running === mine) running = undefined;
        };
        void service.login(owner, provider, type, {
          signal: mine.stop.signal,
          notify: (event) => show({ ...shown, events: [...shown.events, loginEvent(event)].slice(-LOGIN_EVENTS) }),
          prompt: (asking) => new Promise<string>((resolve, reject) => {
            const id = ++ids;
            const signals = [mine.stop.signal, ...(asking.signal === undefined ? [] : [asking.signal])];
            const settle = () => {
              mine.asked.delete(id);
              for (const signal of signals) signal.removeEventListener("abort", cancel);
              if (shown.prompt?.id !== id) return;
              const { prompt: _done, ...rest } = shown;
              show(rest);
            };
            const cancel = () => {
              settle();
              reject(new Error("Login cancelled"));
            };
            if (signals.some((signal) => signal.aborted)) return cancel();
            for (const signal of signals) signal.addEventListener("abort", cancel, { once: true });
            mine.asked.set(id, (value) => {
              settle();
              resolve(value);
            });
            show({ ...shown, prompt: loginPrompt(id, asking) });
          }),
        }).then(
          async () => {
            await host.root(async (root) => providers.replace(root, await listed())).catch(() => {});
            end("done");
          },
          (error: unknown) => {
            if (late) end("failed", `the login was not finished within ${LOGIN_LIMIT_MS / 60_000} minutes`);
            else if (mine.stop.signal.aborted) end("cancelled");
            else end("failed", errorText(error));
          },
        ).finally(() => clearTimeout(bound));
        return mine.id;
      },
      answer: async ({ prompt, value }) => {
        const reply = running?.asked.get(prompt);
        if (reply === undefined) throw invalid("no_prompt", `the login asks nothing as ${prompt} now`);
        reply(value);
      },
      cancelLogin: async ({ login: id }) => {
        if (running?.id === id) running.stop.abort();
      },
    };
  });

  host.serve(Loop, (_input, principal) => {
    ownerOf(principal);
    // The loop's records are the owner's too, kept where the service keeps the rest.
    current();
    const control = () => {
      if (loop === undefined) throw invalid("no_loop", "this service runs no RSI loop");
      return loop;
    };
    const done = (problem: string | undefined) => {
      if (problem !== undefined) throw invalid("loop_refused", problem);
    };
    return {
      variant: "owner",
      standing: () => control().standing(),
      changes: () => control().changes(),
      undo: async ({ id }) => done(await control().undo(id)),
      corrections: () => control().corrections(),
      answer: async ({ key, learn }) => done(await control().answer(key, learn)),
      held: () => control().held(),
      decide: async ({ id, approve }) => done(await control().decide(id, approve)),
      settings: () => control().settings(),
      setSettings: (change) => control().setSettings(change),
    };
  });

  host.serve(Mcp, (_input, principal, self) => {
    const owner = ownerOf(principal);
    const service = current();
    const servers = self.state("servers", Type.Array(McpServerSchema), { init: () => service.mcpServers(owner) });
    return {
      variant: "owner",
      servers,
      set: async ({ name, url, headers = {} }, ctx) => {
        const problem = await service.setMcpServer(owner, name, url, headers);
        if (problem !== undefined) throw invalid("mcp_refused", problem);
        servers.replace(ctx, await service.mcpServers(owner));
      },
      remove: async ({ name }, ctx) => {
        await service.removeMcpServer(owner, name);
        servers.replace(ctx, await service.mcpServers(owner));
      },
    };
  });

  host.serve(Environment, (_input, principal, self) => {
    const owner = ownerOf(principal);
    const service = current();
    const names = self.state("names", Type.Array(Type.String()), { init: () => service.variableNames(owner) });
    return {
      variant: "owner",
      names,
      set: async ({ name, value }, ctx) => {
        const problem = service.setVariable(owner, name, value);
        if (problem !== undefined) throw invalid("variable_refused", problem);
        names.replace(ctx, service.variableNames(owner));
      },
      remove: async ({ name }, ctx) => {
        service.removeVariable(owner, name);
        names.replace(ctx, service.variableNames(owner));
      },
    };
  });

  return host;
}

export interface ListenOptions {
  authenticate: Authenticate;
  /** 0, the default, picks a free port. */
  port?: number;
  /** Loopback by default; anything wider needs TLS in front, or a private network. */
  hostname?: string;
  /** Whether the service has work in hand, as `GET /status` tells it; whether its agents are working by default. */
  busy?: () => Promise<boolean>;
  /** The owner's RSI loop, which clients may then read and decide for. */
  loop?: LoopControl;
}

export interface Listening {
  readonly port: number;
  /** Clients connected right now. */
  readonly clients: number;
  /** When an authenticated request or connection last arrived, in milliseconds since the epoch. */
  readonly reachedAt: number;
  close(): Promise<void>;
}

/** Serves the client protocol over WebSocket, and over HTTP only whether it is busy or locked, on one port. */
export async function listen(source: AgentService | Sealed, options: ListenOptions): Promise<Listening> {
  const host = createAgentHost(source, options.loop);
  const service = () => (source instanceof AgentService ? source : source.service);
  let reachedAt = Date.now();
  // Only someone who may use the service keeps it from being idle.
  const authenticated = async (credential: string | undefined): Promise<Principal | undefined> => {
    const principal = credential === undefined ? undefined : await options.authenticate(credential);
    if (principal !== undefined) reachedAt = Date.now();
    return principal;
  };
  const status = statusHandler(options.authenticate, {
    busy: options.busy ?? (async () => (await service()?.working() ?? []).length > 0),
    locked: () => service() === undefined,
  });
  const http = createServer((request, response) => {
    if (URL.parse(request.url ?? "/", "http://localhost")?.pathname !== "/status") return void response.writeHead(404).end("not found");
    status(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  const sockets = new WebSocketServer({ server: http });
  acceptWebSockets(sockets, host, {
    principal: (request) => authenticated(sameOrigin(request) ? credentialOf(request) : undefined),
  });
  http.listen(options.port ?? 0, options.hostname ?? "127.0.0.1");
  await once(http, "listening");
  return {
    port: (http.address() as AddressInfo).port,
    get clients() {
      return sockets.clients.size;
    },
    get reachedAt() {
      return reachedAt;
    },
    close: async () => {
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await host.close();
    },
  };
}

/**
 * A browser always says which page opened a WebSocket, and a page cannot set that itself. The service serves no
 * page, so a page of another site is refused even when it holds a credential; only a page at the address the
 * service was reached by, or the one a proxy in front names, may connect. Clients that are not browsers, a proxy
 * among them, send no origin.
 */
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  const page = URL.parse(origin);
  if (page === null) return false;
  const forwarded = request.headers["x-forwarded-host"];
  const proxied = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  // Read as the page's own scheme would, so case and a default port written out make no difference.
  const named = (host: string | undefined) => host !== undefined && URL.parse(`${page.protocol}//${host}`)?.host === page.host;
  return named(request.headers.host) || named(proxied);
}

/** Durable calls take the call's cancellation, not the call itself. */
function durable(ctx: Ctx<Principal>): Context {
  return withAbortSignal(ctx.signal, BACKGROUND_CONTEXT);
}

function ownerOf(principal: Principal): string {
  if (principal.kind !== "owner") throw forbidden();
  return principal.owner;
}

/** What a message says and shows, as the model takes it; refused when it does neither. */
function messageContent(text: string, images: readonly Image[]): UserInput {
  if (text === "" && images.length === 0) throw invalid("empty_message", "a message says something, shows something, or both");
  return images.length === 0 ? text : [...(text === "" ? [] : [{ type: "text" as const, text }]), ...images.map((image) => ({ type: "image" as const, ...image }))];
}

/** `content` saying `text` instead, still showing what it shows. */
function retext(content: UserInput, text: string): UserInput {
  return typeof content === "string" ? text : [{ type: "text", text }, ...content.filter((block) => block.type !== "text")];
}


/** A login's news in the protocol's words, without what a provider adds beyond them. */
function loginEvent(event: AuthEvent): LoginEvent {
  switch (event.type) {
    case "auth_url":
      return { type: "auth_url", url: event.url, ...(event.instructions === undefined ? {} : { instructions: event.instructions }) };
    case "device_code":
      return { type: "device_code", userCode: event.userCode, verificationUri: event.verificationUri, ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }) };
    case "info":
      return { type: "info", message: event.message, ...(event.links === undefined ? {} : { links: event.links.map(({ url, label }) => (label === undefined ? { url } : { url, label })) }) };
    case "progress":
      return { type: "progress", message: event.message };
  }
}

/** What a login asks, as clients answer it by `id`. */
function loginPrompt(id: number, asking: AuthPrompt): LoginPrompt {
  const placeholder = asking.type !== "select" && asking.placeholder !== undefined ? { placeholder: asking.placeholder } : {};
  const options = asking.type === "select"
    ? { options: asking.options.map(({ id: option, label, description }) => (description === undefined ? { id: option, label } : { id: option, label, description })) }
    : {};
  return { id, type: asking.type, message: asking.message, ...placeholder, ...options };
}
