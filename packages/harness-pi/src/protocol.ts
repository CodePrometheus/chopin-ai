import { createHost, hostNamed, isChordError, method, remote, webSocketLink, type Ctx, type Host, type Ref } from "@earendil-works/chord";
import { Type, type Static, type TArray, type TNumber, type TObject, type TSchema, type TUnknown } from "typebox";
import { unansweredText } from "./acp.js";
import { backoff } from "./backoff.js";

/**
 * The client protocol: remote objects over a WebSocket. A client sees each object's state as a snapshot followed by
 * deltas, and after a reconnect it gets the current state again instead of a replay. This module has no Node
 * dependency, so browsers and terminals share it.
 */

/** Who a request acts as: an owner named by the authenticator, or the service's own code. */
export type Principal = { kind: "owner"; owner: string } | { kind: "host" };

export const HOST = "chopin";

/** What a conversation may do: `read` admits only tools that change nothing; `full` admits every tool. */
export const ModeSchema = Type.Union([Type.Literal("read"), Type.Literal("full")]);
export type Mode = Static<typeof ModeSchema>;
export const MODES: readonly Mode[] = ModeSchema.anyOf.map((literal) => literal.const);

/** How a submission made through this object ended, or that it has not yet. */
export const SubmissionSchema = Type.Union([
  Type.Object({ status: Type.Literal("pending") }),
  Type.Object({ status: Type.Literal("done") }),
  Type.Object({ status: Type.Literal("unanswered"), reason: Type.String(), detail: Type.Optional(Type.String()) }),
]);

/**
 * Why the latest submission got no answer, unless it was stopped on purpose; `undefined` while it runs or once it
 * was answered.
 */
export function lastFailure(submissions: Readonly<Record<string, Static<typeof SubmissionSchema>>>): string | undefined {
  const latest = Object.keys(submissions).map(Number).sort((a, b) => b - a)[0];
  const outcome = latest === undefined ? undefined : submissions[String(latest)];
  return outcome?.status === "unanswered" && outcome.reason !== "aborted" ? unansweredText(outcome) : undefined;
}

// Method specs named through the exported `method`, so declaration files can refer to them.
type Call<A extends TSchema> = ReturnType<typeof method<A>> & {};
type Query<A extends TSchema | undefined, R extends TSchema> = ReturnType<typeof method<A, R>> & {};
const ForkArgs = Type.Object({ conversation: Type.Number(), at: Type.Number() });
/** `request`, chosen by the client, makes sending the same message again harmless: it is admitted once. */
const SubmitArgs = Type.Object({
  text: Type.String({ minLength: 1 }),
  steer: Type.Optional(Type.Boolean()),
  request: Type.Optional(Type.String({ minLength: 1 })),
});
const ModeArgs = Type.Object({ mode: ModeSchema });
/** A model as the model library names it: its provider and its id there. */
const ModelArgs = Type.Object({ provider: Type.String({ minLength: 1 }), modelId: Type.String({ minLength: 1 }) });
const NoArgs = Type.Object({});
const NameArgs = Type.Object({ name: Type.String({ maxLength: 200 }) });
/** A thinking level as the model library names them; the service takes only those the conversation's model has. */
const ThinkingArgs = Type.Object({ level: Type.String({ minLength: 1 }) });
const CompactArgs = Type.Object({ instructions: Type.Optional(Type.String()) });
/** A command of the user's, run in the workspace; an excluded one the model never sees. */
const ShellArgs = Type.Object({ command: Type.String({ minLength: 1 }), excluded: Type.Optional(Type.Boolean()) });
const Texts = Type.Array(Type.String());

/** The command the user is running in a conversation and its output so far; null while none runs. */
export const RunningSchema = Type.Union([
  Type.Null(),
  Type.Object({ command: Type.String(), output: Type.String(), excluded: Type.Boolean() }),
]);
export type Running = Static<typeof RunningSchema>;

/** What the service's agents load besides their tools: whether there are instructions, the skills, the MCP servers. */
export const LoadedSchema = Type.Object({ instructions: Type.Boolean(), skills: Type.Array(Type.String()), mcpServers: Type.Array(Type.String()) });
export type Loaded = Static<typeof LoadedSchema>;

/** A line about one conversation, for picking one to resume: times in milliseconds since the epoch. */
export const SummarySchema = Type.Object({
  id: Type.Number(),
  name: Type.String(),
  first: Type.String(),
  messages: Type.Number(),
  created: Type.Number(),
  modified: Type.Number(),
});
export type Summary = Static<typeof SummarySchema>;
const Summaries = Type.Array(SummarySchema);

/** An owner's conversations. */
export const Conversations = remote("chopin.conversations", {
  version: 1,
  input: Type.Object({}),
  host: hostNamed(HOST),
  variants: {
    owner: {
      state: { ids: Type.Array(Type.Number()) },
      methods: {
        create: method(undefined, Type.Number()) as Query<undefined, TNumber>,
        loaded: method(undefined, LoadedSchema) as Query<undefined, typeof LoadedSchema>,
        fork: method(ForkArgs, Type.Number()) as Query<typeof ForkArgs, TNumber>,
        summaries: method(undefined, Summaries) as Query<undefined, typeof Summaries>,
      },
    },
  },
});

/**
 * One conversation: its durable view (transcript, live generation, inbox, usage), what it may do, and how the
 * submissions made through it ended, keyed by the id `submit` returned.
 */
export const Conversation = remote("chopin.conversation", {
  version: 1,
  input: Type.Object({ conversation: Type.Number() }),
  host: hostNamed(HOST),
  variants: {
    owner: {
      state: {
        view: Type.Unknown(),
        mode: ModeSchema,
        name: Type.String(),
        submissions: Type.Record(Type.String(), SubmissionSchema),
        running: RunningSchema,
      },
      methods: {
        submit: method(SubmitArgs, Type.Number()) as Query<typeof SubmitArgs, TNumber>,
        /** Runs to the command's end, which may take long; `stopCommand` ends it sooner. */
        shell: method(ShellArgs) as Call<typeof ShellArgs>,
        stopCommand: method(NoArgs) as Call<TObject<{}>>,
        /** The whole conversation as transcript lines, what compaction took from the view included. */
        transcript: method(NoArgs, Type.Array(Type.Unknown())) as Query<TObject<{}>, TArray<TUnknown>>,
        /** Takes back every message still queued, answering with their texts in the order they were sent. */
        withdraw: method(NoArgs, Texts) as Query<TObject<{}>, typeof Texts>,
        abort: method(NoArgs) as Call<TObject<{}>>,
        setMode: method(ModeArgs) as Call<typeof ModeArgs>,
        setModel: method(ModelArgs) as Call<typeof ModelArgs>,
        setName: method(NameArgs) as Call<typeof NameArgs>,
        setThinking: method(ThinkingArgs) as Call<typeof ThinkingArgs>,
        compact: method(CompactArgs) as Call<typeof CompactArgs>,
      },
    },
  },
});

export interface ConnectOptions {
  /** A credential sent as a bearer header, kept out of the address and so out of any proxy's logs; not in browsers. */
  token?: string;
  /** Finds the service again before each redial: where it is and the credential it takes, either may have changed. */
  find?: () => Promise<{ url: string | URL; token?: string }>;
}

/**
 * A client host connected to the agent service at `url`, which carries the client's credential. A link that drops
 * is dialled again, waiting longer each time, until the host is closed; references come back live once the service
 * answers. Only a link that held for a while resets the wait, so a refused one is not dialled ever faster.
 */
export function connect(url: string | URL, options: ConnectOptions = {}): Host {
  const host = createHost({ name: `client:${randomId()}`, self: { kind: "host" }, kind: "client" });
  let open = true;
  const waits = backoff(250, 10_000);
  let redial: ReturnType<typeof setTimeout> | undefined;
  const again = () => {
    if (!open) return;
    redial = setTimeout(() => {
      (options.find?.() ?? Promise.resolve({ url, token: options.token })).then(dial).catch(again);
    }, waits.next());
  };
  const dial = ({ url: at, token }: { url: string | URL; token?: string | undefined }) => {
    if (!open) return;
    // Node's WebSocket takes headers; a browser has its cookie instead.
    const socket = token === undefined ? new WebSocket(at) : new WebSocket(at, { headers: { authorization: `Bearer ${token}` } });
    let opened: number | undefined;
    socket.addEventListener("open", () => void (opened = Date.now()));
    const link = webSocketLink(socket);
    link.onClose(() => {
      if (opened !== undefined && Date.now() - opened >= HELD_MS) waits.reset();
      again();
    });
    host.connect(link, { principal: { kind: "host" } });
  };
  dial({ url, token: options.token });
  const close = host.close.bind(host);
  host.close = async () => {
    open = false;
    clearTimeout(redial);
    await close();
  };
  return host;
}

/** How long a link must hold to count as a working one, which dials again without waiting long. */
const HELD_MS = 5_000;

/** How long a call waits for the service, through any reconnect, before it fails. */
export const CALL_TIMEOUT_MS = 30_000;

/** A call that waited longer than its bound for the service. */
export class CallTimeout extends Error {
  constructor(options?: ErrorOptions) {
    super("the agent service did not answer in time", options);
  }
}

export interface CallOptions {
  /** `CALL_TIMEOUT_MS` by default; `Infinity` waits for as long as the work takes. */
  timeoutMs?: number;
  /** Gives up the call. */
  signal?: AbortSignal;
}

/** Runs `work` against the service, failing with `CallTimeout` once it has waited too long for an answer. */
export function call<T>(host: Host, work: (ctx: Ctx) => Promise<T>, options: CallOptions = {}): Promise<T> {
  return within(options, (signal) => host.root(work, { signal }));
}

export type ConversationRef = Ref<typeof Conversation>;

/** One conversation of the service, held until released, waited for as long as a call. */
export function openConversation(host: Host, conversation: number, options: CallOptions = {}): Promise<ConversationRef> {
  return within(options, (signal) => host.get(Conversation, { conversation }, { signal }));
}

/**
 * The owner's list of conversations as one client holds it: opened when first needed and again once it ended, one
 * open at a time and each bounded as a call; once released, a list still being opened is let go as it arrives.
 */
export interface HeldList {
  /** The list, waited for no longer than `signal` allows; an open under way goes on for whoever asks next. */
  get(signal?: AbortSignal): Promise<Ref<typeof Conversations>>;
  release(): void;
}

export function heldList(host: Host, options: CallOptions = {}): HeldList {
  let held: Ref<typeof Conversations> | undefined;
  let opening: Promise<Ref<typeof Conversations>> | undefined;
  let released = false;
  return {
    get: (signal) => {
      if (released) return Promise.reject(new Error("the list was released"));
      if (held !== undefined && (held.status === "live" || held.status === "loading")) return Promise.resolve(held);
      held?.release();
      held = undefined;
      opening ??= openConversations(host, options).then(
        (list) => {
          opening = undefined;
          if (released) {
            list.release();
            throw new Error("the list was released");
          }
          held = list;
          return list;
        },
        (error: unknown) => {
          opening = undefined;
          throw error;
        },
      );
      return signal === undefined ? opening : abandonable(opening, signal);
    },
    release: () => {
      released = true;
      held?.release();
      held = undefined;
    },
  };
}

/** What `promise` settles to, unless `signal` aborts first. */
function abandonable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Starts a new conversation in the owner's list and opens it, waiting no longer than any one call. */
export async function startConversation(
  host: Host,
  list: (signal: AbortSignal) => Promise<Ref<typeof Conversations>>,
  options: CallOptions = {},
): Promise<{ id: number; conversation: ConversationRef }> {
  // Two calls, so a link lost after the conversation was made opens it rather than making another; together they
  // wait no longer than one.
  const started = Date.now();
  const id = await within(options, async (signal) => {
    const conversations = await list(signal);
    return host.root((ctx) => conversations.create(ctx), { signal });
  });
  const left = Math.max(0, (options.timeoutMs ?? CALL_TIMEOUT_MS) - (Date.now() - started));
  return { id, conversation: await openConversation(host, id, { ...options, timeoutMs: left }) };
}

/** The owner's list of conversations, held until released, waited for as long as a call. */
export function openConversations(host: Host, options: CallOptions = {}): Promise<Ref<typeof Conversations>> {
  return within(options, (signal) => host.get(Conversations, {}, { signal }));
}

/** An error's text as every client shows it. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

/**
 * An error's text followed by what lies beneath it, for a log or a command's last word: an aggregate's failures,
 * then its cause, each told once however many ways lead to it.
 */
export function errorChain(error: unknown): string {
  const seen = new Set<unknown>([error]);
  const told = (current: unknown, below: readonly string[]) => (below.length === 0 ? errorText(current) : `${errorText(current)}: ${below.join("; ")}`);
  const beneath = (current: unknown): string[] => {
    const own = errorText(current);
    const cause = current instanceof Error && current.cause != null ? current.cause : undefined;
    // A cause the error already quotes at its end, as a wrapping error words it, adds only what lies beneath it.
    const quoted = cause !== undefined && (own === errorText(cause) || own.endsWith(`: ${errorText(cause)}`));
    const members = current instanceof AggregateError ? (current.errors as unknown[]) : [];
    return [...members, ...(cause === undefined ? [] : [cause])].flatMap((next) => {
      if (seen.has(next)) return [];
      seen.add(next);
      return next === cause && quoted ? beneath(next) : [told(next, beneath(next))];
    });
  };
  return told(error, beneath(error));
}

/** Why a reference ended: its error, or else its status. */
export function endText(ref: { readonly status: string; readonly error?: unknown }): string {
  return errorText(ref.error ?? ref.status);
}

/** A random id; a page served over plain HTTP has no `crypto.randomUUID`, but every page has random values. */
export function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Sends messages so that sending the same text straight after a failure is a resend under the same request, which
 * the service admits once, whether or not the failed try reached it; any other message is a new one.
 */
export function resender(): (text: string, submit: (request: string) => Promise<unknown>) => Promise<unknown> {
  let failed: { text: string; request: string } | undefined;
  return (text, submit) => {
    const request = failed?.text === text ? failed.request : randomId();
    failed = undefined;
    return submit(request).catch((error: unknown) => {
      failed = { text, request };
      throw error;
    });
  };
}

/** Runs `work` with a signal that aborts once `options` say to stop waiting, failing then with `CallTimeout`. */
export async function within<T>(options: CallOptions, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const bound = options.timeoutMs ?? CALL_TIMEOUT_MS;
  const timeout = Number.isFinite(bound) ? AbortSignal.timeout(bound) : undefined;
  const signal = AbortSignal.any([timeout, options.signal].filter((each) => each !== undefined));
  try {
    for (;;) {
      try {
        return await work(signal);
      } catch (error) {
        // Between dials there is no link, so nothing was sent: the work waits for the next one rather than failing.
        if (!(isChordError(error) && error.code === "unavailable" && error.message.includes("no route to"))) throw error;
        await pause(UNROUTED_RETRY_MS, signal);
      }
    }
  } catch (error) {
    throw timeout?.aborted === true ? new CallTimeout({ cause: error }) : error;
  }
}

const UNROUTED_RETRY_MS = 100;

/** Resolves after `ms`, or rejects once `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", done);
      resolve();
    }, ms);
    if (signal.aborted) return done();
    signal.addEventListener("abort", done, { once: true });
  });
}
