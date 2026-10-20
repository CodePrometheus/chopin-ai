import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { acceptWebSockets, createHost, forbidden, invalid, type Context, type Ctx, type Host } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { configure, InboxDoc, type ConversationId, type ConversationView, type ModelRef, type Submission, type SubmissionId, type UserInput } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { WebSocketServer } from "ws";
import { credentialOf, type Authenticate } from "./auth.js";
import { httpHandler } from "./http.js";
import { ModeDoc, NameDoc } from "./mode.js";
import { userText } from "./acp.js";
import { Conversation, Conversations, HOST, ModeSchema, RunningSchema, SubmissionSchema, type Principal } from "./protocol.js";
import { backoff } from "./backoff.js";
import type { AgentService } from "./service.js";
import { shellEntry } from "./shell.js";
import { lost, merge, outcomeOf, progressOf, RECENT_SUBMISSIONS, type Outcome } from "./submissions.js";


/** Serves the client protocol for `service`; every object belongs to the owner that asked for it. */
export function createAgentHost(service: AgentService): Host<Principal> {
  const host = createHost<Principal>({
    name: HOST,
    self: { kind: "host" },
    principalKey: (principal) => (principal.kind === "owner" ? `owner:${principal.owner}` : "host"),
  });

  host.serve(Conversations, (_input, principal, self) => {
    const owner = ownerOf(principal);
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
      loaded: async () => service.loaded,
      create: async (ctx) => {
        const conversation = await service.newConversation(owner, durable(ctx));
        add(ctx, conversation.id);
        return conversation.id;
      },
      summaries: (ctx) => service.summaries(owner, durable(ctx)),
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
    return {
      variant: "owner",
      view,
      mode,
      name,
      submissions,
      running,
      submit: async ({ text, steer, request }, ctx) => {
        service.touch(owner);
        const submission = await opened.value.conversation.submit({
          type: "input",
          content: text,
          ...(steer === true && { whenBusy: "steer" as const }),
          ...(request !== undefined && { requestId: request }),
        }, durable(ctx));
        submissions.change(ctx, (draft) => void (draft[String(submission.id)] ??= { status: "pending" }));
        awaitEnd(submission.id, submission);
        reread();
        return submission.id;
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

  return host;
}

export interface ListenOptions {
  authenticate: Authenticate;
  /** 0, the default, picks a free port. */
  port?: number;
  /** Loopback by default; anything wider needs TLS in front. */
  hostname?: string;
  /** A built web app to serve on the same port. */
  web?: string;
}

export interface Listening {
  readonly port: number;
  /** Clients connected right now. */
  readonly clients: number;
  /** When an authenticated request or connection last arrived, in milliseconds since the epoch. */
  readonly reachedAt: number;
  close(): Promise<void>;
}

/** Serves the client protocol over WebSocket, and the web app over HTTP, on one port. */
export async function listen(service: AgentService, options: ListenOptions): Promise<Listening> {
  const host = createAgentHost(service);
  let reachedAt = Date.now();
  // Only someone who may use the service keeps it from being idle.
  const authenticated = async (credential: string | undefined): Promise<Principal | undefined> => {
    const principal = credential === undefined ? undefined : await options.authenticate(credential);
    if (principal !== undefined) reachedAt = Date.now();
    return principal;
  };
  const handle = httpHandler(authenticated, options.web);
  const http = createServer((request, response) => {
    handle(request, response).catch(() => {
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
 * Browsers attach the cookie to a WebSocket any page opens, and they always say which page that was. Only a page
 * this service served may connect, at the address it was reached by or the one a proxy in front names; a page
 * cannot set either header itself. Clients that are not browsers send no origin.
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

