import { createHost, hostNamed, isChordError, method, remote, webSocketLink, type Ctx, type Host, type Ref } from "@earendil-works/chord";
import { Type, type Static, type TArray, type TNumber, type TObject, type TSchema, type TUnknown } from "typebox";
import { backoff } from "./backoff.js";
import { serviceKey, type DataKey } from "./keys.js";

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

/** Why a submission got no answer, with the harness's detail, such as the provider's own message, when it gave one. */
export function unansweredText(settled: { reason: string; detail?: unknown }): string {
  const detail = detailText(settled.detail);
  return detail === undefined ? settled.reason : `${settled.reason}: ${detail}`;
}

/** The detail the harness gave with an unanswered submission, as text. */
export function detailText(detail: unknown): string | undefined {
  return detail === undefined ? undefined : typeof detail === "string" ? detail : JSON.stringify(detail);
}

// Method specs named through the exported `method`, so declaration files can refer to them.
type Call<A extends TSchema> = ReturnType<typeof method<A>> & {};
type Query<A extends TSchema | undefined, R extends TSchema> = ReturnType<typeof method<A, R>> & {};
const ForkArgs = Type.Object({ conversation: Type.Number(), at: Type.Number() });
/** The largest image a message may carry, before it is encoded. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** An image a message carries, in a format models take, as base64. */
export const ImageSchema = Type.Object({
  data: Type.String({ minLength: 1, maxLength: 4 * Math.ceil(IMAGE_MAX_BYTES / 3) }),
  mimeType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg"), Type.Literal("image/gif"), Type.Literal("image/webp")]),
});
export type Image = Static<typeof ImageSchema>;
/** The most images one message may carry. */
export const IMAGES_MAX = 20;
const Images = Type.Array(ImageSchema, { maxItems: IMAGES_MAX });
/**
 * A message says something, shows something, or both. `request`, chosen by the client, makes sending the same message
 * again harmless: it is admitted once.
 */
const SubmitArgs = Type.Object({
  text: Type.String(),
  images: Type.Optional(Images),
  steer: Type.Optional(Type.Boolean()),
  request: Type.Optional(Type.String({ minLength: 1 })),
});
const ModeArgs = Type.Object({ mode: ModeSchema });
/** A model as the model library names it: its provider and its id there. */
const ModelArgs = Type.Object({ provider: Type.String({ minLength: 1 }), modelId: Type.String({ minLength: 1 }) });
const NoArgs = Type.Object({});
const NameArgs = Type.Object({ name: Type.String({ maxLength: 200 }) });
const ContextArgs = Type.Object({ text: Type.String({ maxLength: 4_000 }) });
const RetryArgs = Type.Object({ text: Type.Optional(Type.String()), images: Type.Optional(Images) });
const ResetArgs = Type.Object({ handoff: Type.Optional(Type.String({ minLength: 1 })) });
/** The kind of entry `retry` writes, which leaves the entries it names out of what the model sees; they stay in the transcript. */
export const REWIND_KIND = "chopin.rewind";
const QueueArgs = Type.Object({
  queue: Type.Array(Type.Object({ id: Type.Number(), text: Type.Optional(Type.String({ minLength: 1 })), steer: Type.Optional(Type.Boolean()) })),
});
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

/**
 * What an owner's agent loads besides its tools: whether the layer has instructions, the paths of the project's
 * instruction files in the workspace, the skills, the MCP servers.
 */
export const LoadedSchema = Type.Object({
  instructions: Type.Boolean(),
  projectInstructions: Type.Array(Type.String()),
  skills: Type.Array(Type.String()),
  mcpServers: Type.Array(Type.String()),
});
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

/** A model the owner's agent can use now, with what a client shows to pick it. */
export const ModelChoiceSchema = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
  name: Type.String(),
  contextWindow: Type.Number(),
  images: Type.Boolean(),
  thinkingLevels: Type.Array(Type.String()),
});
/** The models the owner can use now, those whose providers have credentials, and the one a new conversation takes. */
export const ModelChoicesSchema = Type.Object({ models: Type.Array(ModelChoiceSchema), current: Type.Union([ModelArgs, Type.Null()]) });
export type ModelChoices = Static<typeof ModelChoicesSchema>;

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
        /** Asks the workspace, so it is not part of the list's state, which would start a workspace just to list. */
        loaded: method(undefined, LoadedSchema) as Query<undefined, typeof LoadedSchema>,
        fork: method(ForkArgs, Type.Number()) as Query<typeof ForkArgs, TNumber>,
        summaries: method(undefined, Summaries) as Query<undefined, typeof Summaries>,
        /** Asked anew each time, so a credential set a moment ago shows its provider's models. */
        models: method(undefined, ModelChoicesSchema) as Query<undefined, typeof ModelChoicesSchema>,
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
        /**
         * Arranges the messages still queued as listed, by their submission ids: in that order, each as it was, with new
         * text, or to steer the turn under way; one left out is taken back. One the agent took up meanwhile stays sent,
         * listed or not. A message put again is a new submission under a new id, as the queue in the view shows.
         */
        requeue: method(QueueArgs) as Call<typeof QueueArgs>,
        /**
         * Asks the latest message again, once the agent has stopped: as it was, or as what is given, which replaces it
         * whole, its images included. The model no longer sees that message or anything after it.
         */
        retry: method(RetryArgs, Type.Number()) as Query<typeof RetryArgs, TNumber>,
        /** Starts the model on a fresh context, with a note to carry over if given; the transcript keeps everything. */
        reset: method(ResetArgs) as Call<typeof ResetArgs>,
        abort: method(NoArgs) as Call<TObject<{}>>,
        setMode: method(ModeArgs) as Call<typeof ModeArgs>,
        setModel: method(ModelArgs) as Call<typeof ModelArgs>,
        setName: method(NameArgs) as Call<typeof NameArgs>,
        /** What the client shows its user now, such as the page they are on; the model reads it before each request. */
        setContext: method(ContextArgs) as Call<typeof ContextArgs>,
        setThinking: method(ThinkingArgs) as Call<typeof ThinkingArgs>,
        compact: method(CompactArgs) as Call<typeof CompactArgs>,
      },
    },
  },
});

const AuthTypeSchema = Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]);
/** A provider the owner holds a credential for, and its kind; never the secret. */
export const CredentialSchema = Type.Object({ provider: Type.String(), type: AuthTypeSchema });
export type CredentialInfo = Static<typeof CredentialSchema>;
const CredentialList = Type.Array(CredentialSchema);
const KeyArgs = Type.Object({ provider: Type.String({ minLength: 1 }), key: Type.String({ minLength: 1 }) });
const ProviderArgs = Type.Object({ provider: Type.String({ minLength: 1 }) });

/** A way to sign in to a provider: its own sign-in, which a subscription may back, or an API key entered once. */
export const LoginWaySchema = Type.Object({ type: AuthTypeSchema, name: Type.String(), subscription: Type.Boolean() });
/**
 * A provider the owner's models know, each way a client can sign in to it, and the hosts its models are reached at,
 * so an integrator that limits where the service connects can admit them.
 */
export const ProviderEntrySchema = Type.Object({ id: Type.String(), name: Type.String(), ways: Type.Array(LoginWaySchema), hosts: Type.Array(Type.String()) });
export type ProviderEntry = Static<typeof ProviderEntrySchema>;
const ProviderList = Type.Array(ProviderEntrySchema);

/** News from a login as the provider gives it: a page to open, a code to enter on any device, a note, or progress. */
export const LoginEventSchema = Type.Union([
  Type.Object({ type: Type.Literal("auth_url"), url: Type.String(), instructions: Type.Optional(Type.String()) }),
  Type.Object({ type: Type.Literal("device_code"), userCode: Type.String(), verificationUri: Type.String(), expiresInSeconds: Type.Optional(Type.Number()) }),
  Type.Object({ type: Type.Literal("info"), message: Type.String(), links: Type.Optional(Type.Array(Type.Object({ url: Type.String(), label: Type.Optional(Type.String()) }))) }),
  Type.Object({ type: Type.Literal("progress"), message: Type.String() }),
]);
export type LoginEvent = Static<typeof LoginEventSchema>;
/** What a login asks the owner now, answered by its `id`: a `select` with an option's id, the others with text. */
export const LoginPromptSchema = Type.Object({
  id: Type.Number(),
  type: Type.Union([Type.Literal("text"), Type.Literal("secret"), Type.Literal("select"), Type.Literal("manual_code")]),
  message: Type.String(),
  placeholder: Type.Optional(Type.String()),
  options: Type.Optional(Type.Array(Type.Object({ id: Type.String(), label: Type.String(), description: Type.Optional(Type.String()) }))),
});
export type LoginPrompt = Static<typeof LoginPromptSchema>;
/** The owner's latest login: running, with what it said and what it asks now, or how it ended. */
export const LoginSchema = Type.Object({
  id: Type.Number(),
  provider: Type.String(),
  type: AuthTypeSchema,
  status: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("failed"), Type.Literal("cancelled")]),
  events: Type.Array(LoginEventSchema),
  prompt: Type.Optional(LoginPromptSchema),
  error: Type.Optional(Type.String()),
});
export type LoginState = Static<typeof LoginSchema>;
const LoginArgs = Type.Object({ provider: Type.String({ minLength: 1 }), type: AuthTypeSchema });
const LoginAnswerArgs = Type.Object({ prompt: Type.Number(), value: Type.String() });
const LoginIdArgs = Type.Object({ login: Type.Number() });

/**
 * The credentials an owner's agent reaches models with, where clients may set them, by a key or by a provider's own
 * login, which the service runs and every client of the owner follows. Secrets only ever travel to the service, which
 * keeps each where it keeps that owner's credentials.
 */
export const Credentials = remote("chopin.credentials", {
  version: 1,
  input: Type.Object({}),
  host: hostNamed(HOST),
  variants: {
    owner: {
      state: { providers: CredentialList, login: Type.Union([LoginSchema, Type.Null()]) },
      methods: {
        setKey: method(KeyArgs) as Call<typeof KeyArgs>,
        remove: method(ProviderArgs) as Call<typeof ProviderArgs>,
        /** Every provider the owner's models know, and how a client signs in to each. */
        catalog: method(undefined, ProviderList) as Query<undefined, typeof ProviderList>,
        /** Starts signing in to `provider` the `type` way, ending a login still running; resolves the new login's id. */
        startLogin: method(LoginArgs, Type.Number()) as Query<typeof LoginArgs, TNumber>,
        /** Answers what the running login asks, by the prompt's id. */
        answer: method(LoginAnswerArgs) as Call<typeof LoginAnswerArgs>,
        /** Ends the login `login` while it runs, keeping nothing it got. */
        cancelLogin: method(LoginIdArgs) as Call<typeof LoginIdArgs>,
      },
    },
  },
});

/** An MCP server a client set, and how many tools it offers, or why it offers none yet; never its headers. */
export const McpServerSchema = Type.Object({ name: Type.String(), url: Type.String(), tools: Type.Number(), error: Type.Optional(Type.String()) });
export type McpServerState = Static<typeof McpServerSchema>;
const McpServerName = Type.String({ pattern: "^[A-Za-z0-9_-]{1,32}$" });
const McpArgs = Type.Object({ name: McpServerName, url: Type.String({ minLength: 1 }), headers: Type.Optional(Type.Record(Type.String(), Type.String())) });
const McpNameArgs = Type.Object({ name: McpServerName });

/**
 * The MCP servers an owner's clients set, on top of the layer's: kept in memory alone, headers and all, so a client
 * sets them again once the service restarts, except that a sealed service keeps them, encrypted at rest. Setting one
 * by a name already set replaces it, its headers included.
 */
export const Mcp = remote("chopin.mcp", {
  version: 1,
  input: Type.Object({}),
  host: hostNamed(HOST),
  variants: {
    owner: {
      state: { servers: Type.Array(McpServerSchema) },
      methods: {
        set: method(McpArgs) as Call<typeof McpArgs>,
        remove: method(McpNameArgs) as Call<typeof McpNameArgs>,
      },
    },
  },
});

const VariableName = Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" });
const VariableArgs = Type.Object({ name: VariableName, value: Type.String() });
const VariableNameArgs = Type.Object({ name: VariableName });

/**
 * Variables every command the owner's agent runs gets, such as a credential for a host its tools reach, which so reaches
 * the commands without passing through a conversation: kept in memory alone, so a client sets them again once the
 * service restarts. Setting one by a name already set replaces it; the state names them, never their values.
 */
export const Environment = remote("chopin.environment", {
  version: 1,
  input: Type.Object({}),
  host: hostNamed(HOST),
  variants: {
    owner: {
      state: { names: Type.Array(Type.String()) },
      methods: {
        set: method(VariableArgs) as Call<typeof VariableArgs>,
        remove: method(VariableNameArgs) as Call<typeof VariableNameArgs>,
      },
    },
  },
});

/** The key a sealed service opens with, as `serviceKey` derives it from the owner's data key: 32 bytes in base64url. */
const UnlockArgs = Type.Object({ key: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }) });

/**
 * Whether the service waits for its key. A sealed service keeps everything of its owner's encrypted at rest and opens
 * none of it before a client unlocks it, serving nothing else until then; any other service is never locked.
 */
export const Vault = remote("chopin.vault", {
  version: 1,
  input: Type.Object({}),
  host: hostNamed(HOST),
  variants: {
    owner: {
      state: { locked: Type.Boolean() },
      methods: {
        /** Refused with `wrong_key` for any key but the one the service was first unlocked with; harmless once open. */
        unlock: method(UnlockArgs) as Call<typeof UnlockArgs>,
      },
    },
  },
});

/** Opens a sealed service with the owner's data key unless it is open already, waiting no longer than one call. */
export function unlock(host: Host, key: DataKey, options: CallOptions = {}): Promise<void> {
  return within(options, async (signal) => {
    const vault = await host.get(Vault, {}, { signal });
    try {
      if (!vault.locked.value) return;
      const derived = await serviceKey(key);
      await host.root((ctx) => vault.unlock({ key: derived }, ctx), { signal });
    } finally {
      vault.release();
    }
  });
}

/** Where the RSI loop stands: the layer version in use, the failures it knows, what waits for the owner, what it spent. */
export const LoopStandingSchema = Type.Object({
  version: Type.Number(),
  inUse: Type.Number(),
  archived: Type.Number(),
  kinds: Type.Number(),
  recurring: Type.Number(),
  shelved: Type.Number(),
  corrections: Type.Number(),
  held: Type.Number(),
  spentUsd: Type.Number(),
  weeklyBudgetUsd: Type.Union([Type.Number(), Type.Null()]),
});
/** A change the loop kept, archived or in use. */
export const LoopChangeSchema = Type.Object({ id: Type.String(), added: Type.String(), kind: Type.String(), archived: Type.Boolean(), text: Type.String() });
/** A kind of correction the owner made in enough sessions to be asked whether the loop learns from it. */
export const CorrectionKindSchema = Type.Object({ key: Type.String(), sessions: Type.Number(), examples: Type.Array(Type.String()) });
/** A change the audit held for the owner to approve, which is still tested before it is kept, or refuse. */
export const HeldChangeSchema = Type.Object({
  id: Type.String(),
  failure: Type.String(),
  kind: Type.String(),
  skill: Type.Optional(Type.String()),
  text: Type.String(),
  prediction: Type.String(),
  reasons: Type.Array(Type.String()),
});
/** How the loop runs: none runs without a weekly budget; models as `provider/model`. */
export const LoopSettingsSchema = Type.Object({
  weeklyBudgetUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  regularModel: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  strongModel: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  holdForReview: Type.Boolean(),
});
export type LoopStanding = Static<typeof LoopStandingSchema>;
export type LoopChange = Static<typeof LoopChangeSchema>;
export type CorrectionKind = Static<typeof CorrectionKindSchema>;
export type HeldChange = Static<typeof HeldChangeSchema>;
export type LoopSettings = Static<typeof LoopSettingsSchema>;
const LoopChanges = Type.Array(LoopChangeSchema);
const CorrectionKinds = Type.Array(CorrectionKindSchema);
const HeldChanges = Type.Array(HeldChangeSchema);
const SettingsChange = Type.Partial(LoopSettingsSchema);
const UndoArgs = Type.Object({ id: Type.String({ minLength: 1 }) });
const AnswerArgs = Type.Object({ key: Type.String({ minLength: 1 }), learn: Type.Boolean() });
const DecideArgs = Type.Object({ id: Type.String({ minLength: 1 }), approve: Type.Boolean() });

/**
 * The owner's RSI loop: what it learned and spent, and the decisions it waits on. Only clients reach it; the agent
 * has no tool for it, so it never approves its own changes.
 */
export const Loop = remote("chopin.loop", {
  version: 1,
  input: Type.Object({}),
  host: hostNamed(HOST),
  variants: {
    owner: {
      state: {},
      methods: {
        standing: method(undefined, LoopStandingSchema) as Query<undefined, typeof LoopStandingSchema>,
        changes: method(undefined, LoopChanges) as Query<undefined, typeof LoopChanges>,
        /** Archives a change in use, named by its id or a prefix of it, so new conversations run without it. */
        undo: method(UndoArgs) as Call<typeof UndoArgs>,
        corrections: method(undefined, CorrectionKinds) as Query<undefined, typeof CorrectionKinds>,
        /** Learns from every correction of a kind, or dismisses them all. */
        answer: method(AnswerArgs) as Call<typeof AnswerArgs>,
        held: method(undefined, HeldChanges) as Query<undefined, typeof HeldChanges>,
        decide: method(DecideArgs) as Call<typeof DecideArgs>,
        settings: method(undefined, LoopSettingsSchema) as Query<undefined, typeof LoopSettingsSchema>,
        /** Changes the settings given, a null clearing one; answers with all of them. */
        setSettings: method(SettingsChange, LoopSettingsSchema) as Query<typeof SettingsChange, typeof LoopSettingsSchema>,
      },
    },
  },
});

/** The loop a service's owner is answered from; an action refused says why, and nothing else of it fails that way. */
export interface LoopControl {
  standing(): Promise<LoopStanding>;
  changes(): Promise<LoopChange[]>;
  undo(id: string): Promise<string | undefined>;
  corrections(): Promise<CorrectionKind[]>;
  answer(key: string, learn: boolean): Promise<string | undefined>;
  held(): Promise<HeldChange[]>;
  decide(id: string, approve: boolean): Promise<string | undefined>;
  settings(): Promise<LoopSettings>;
  setSettings(change: Partial<LoopSettings>): Promise<LoopSettings>;
}

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
