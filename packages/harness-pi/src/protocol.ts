import { arr, bool, evolve, hostKind, int, lit, map, method, nul, num, obj, opt, remote, str, union, unknown, type Contract, type Ctx, type RefState, type NullSchema, type NumberSchema, type Reference, type Schema, type Static } from "@earendil-works/chord";
import { CALL_TIMEOUT_MS, within, type CallOptions, type Client } from "./client.js";
export { CALL_TIMEOUT_MS, CallTimeout, connect, subscribe, within } from "./client.js";
export type { CallOptions, Client, ConnectOptions } from "./client.js";
import { serviceKey, type DataKey } from "./keys.js";
import { ArtifactContentPageSchema, EngineCommandSchema, EngineReceiptSchema, GoalPageSchema, GoalSnapshotSchema, PublishedArtifactSchema } from "./goals/contracts.js";
export * from "./goals/contracts.js";

/**
 * The client protocol: remote objects over a WebSocket. A client sees each object's state as a snapshot followed by
 * deltas, and after a reconnect it gets the current state again instead of a replay. This module has no Node
 * dependency, so browsers and terminals share it.
 */

/** Who a request acts as: an owner named by the authenticator, or the service's own code. */
export type Principal = { kind: "owner"; owner: string } | { kind: "host" };

export const HOST = "chopin";
export const AgentHost = hostKind(HOST, {});

const GoalRequestArgs = obj({ requestId: str({ min: 1 }) });
const GoalPageArgs = obj({ limit: int({ min: 1, max: Number.MAX_SAFE_INTEGER }), cursor: opt(map(unknown())) });
const GoalConversationArgs = obj({ conversation: int({ min: 1, max: Number.MAX_SAFE_INTEGER }) });
const GoalReceiptResult = union([EngineReceiptSchema, nul()]);
const GoalLookupResult = union([GoalSnapshotSchema, nul()]);
const GoalArtifactsResult = arr(PublishedArtifactSchema);
const ArtifactContentArgs = obj({
  artifactId: str({ min: 1 }), offset: int({ min: 0, max: Number.MAX_SAFE_INTEGER }),
});
const ArtifactPageResult = union([ArtifactContentPageSchema, nul()]);
export const WakeSchema = obj({ active: bool(), at: opt(int({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER })) });
const GoalsSpec = {
  version: 2, params: {}, hostAddress: () => AgentHost({}), variants: { owner: { state: {}, methods: {
    execute: method(EngineCommandSchema, EngineReceiptSchema) as Query<typeof EngineCommandSchema, typeof EngineReceiptSchema>,
    request: method(GoalRequestArgs, GoalReceiptResult) as Query<typeof GoalRequestArgs, typeof GoalReceiptResult>,
    page: method(GoalPageArgs, GoalPageSchema) as Query<typeof GoalPageArgs, typeof GoalPageSchema>,
    forConversation: method(GoalConversationArgs, GoalLookupResult) as Query<typeof GoalConversationArgs, typeof GoalLookupResult>,
    wake: method(undefined, WakeSchema) as Query<undefined, typeof WakeSchema>,
    resume: method() as Query<undefined, NullSchema>,
  } } },
} as const;
/** Durable command admission and source-owned goal queries. */
export const Goals = remote("chopin.goals", GoalsSpec);
const GoalSpec = {
  version: 3, params: { goal: str({ min: 1 }) }, hostAddress: () => AgentHost({}),
  variants: { owner: { state: { snapshot: GoalSnapshotSchema }, methods: {
    artifacts: method(undefined, GoalArtifactsResult) as Query<undefined, typeof GoalArtifactsResult>,
    artifactContent: method(ArtifactContentArgs, ArtifactPageResult) as Query<typeof ArtifactContentArgs, typeof ArtifactPageResult>,
  } } },
} as const;
/** One goal's persisted authoritative state, independent of the observing connection. */
export const Goal = remote("chopin.goal", GoalSpec);

/** What a conversation may do: `read` admits only tools that change nothing; `full` admits every tool. */
export const MODES = ["read", "full"] as const;
export const ModeSchema = union([lit("read"), lit("full")]);
export type Mode = Static<typeof ModeSchema>;

/** How a submission made through this object ended, or that it has not yet. */
export const SubmissionSchema = union([
  obj({ status: lit("pending") }),
  obj({ status: lit("done") }),
  obj({ status: lit("unanswered"), reason: str(), detail: opt(str()) }),
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
type Call<A extends Schema> = ReturnType<typeof method<A, NullSchema>> & {};
type Query<A extends Schema | undefined, R extends Schema> = ReturnType<typeof method<A extends Schema ? A : NullSchema, R>> & {};
const ForkArgs = obj({ conversation: num(), at: num() });
/** The largest image a message may carry, before it is encoded. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** An image a message carries, in a format models take, as base64. */
export const ImageSchema = obj({
  data: str({ min: 1, max: 4 * Math.ceil(IMAGE_MAX_BYTES / 3) }),
  mimeType: union([lit("image/png"), lit("image/jpeg"), lit("image/gif"), lit("image/webp")]),
});
export type Image = Static<typeof ImageSchema>;
/** The most images one message may carry. */
export const IMAGES_MAX = 20;
const Images = arr(ImageSchema, { max: IMAGES_MAX });
/**
 * A message says something, shows something, or both. `request`, chosen by the client, makes sending the same message
 * again harmless: it is admitted once.
 */
const SubmitArgs = obj({
  text: str(),
  images: opt(Images),
  steer: opt(bool()),
  request: opt(str({ min: 1 })),
});
const ModeArgs = obj({ mode: ModeSchema });
/** A model as the model library names it: its provider and its id there. */
const ModelArgs = obj({ provider: str({ min: 1 }), modelId: str({ min: 1 }) });
const NoArgs = obj({});
const NameArgs = obj({ name: str({ max: 200 }) });
const PinnedArgs = obj({ pinned: bool() });
const ArchivedArgs = obj({ archived: bool() });
const ContextArgs = obj({ text: str({ max: 4_000 }) });
const ResubmitArgs = obj({ text: opt(str()), images: opt(Images) });
const ResetArgs = obj({ handoff: opt(str({ min: 1 })) });
/** The kind of entry `retry` writes, which leaves the entries it names out of what the model sees; they stay in the transcript. */
export const REWIND_KIND = "chopin.rewind";
const QueueArgs = obj({
  queue: arr(obj({ id: num(), text: opt(str({ min: 1 })), steer: opt(bool()) })),
});
/** A thinking level as the model library names them; the service takes only those the conversation's model has. */
const ThinkingArgs = obj({ level: str({ min: 1 }) });
const CompactArgs = obj({ instructions: opt(str()) });
/** A command of the user's, run in the workspace; an excluded one the model never sees. */
const ShellArgs = obj({ command: str({ min: 1 }), excluded: opt(bool()) });
const Texts = arr(str());
/** Source-owned history pagination; cursors are passed back unchanged. */
const EntriesArgs = obj({ limit: int({ min: 1, max: Number.MAX_SAFE_INTEGER }), cursor: opt(map(unknown())), atOrBefore: opt(int({ min: 0, max: Number.MAX_SAFE_INTEGER })) });
export const EntriesPageSchema = obj({ entries: arr(unknown()), cursor: opt(map(unknown())) });

/** The command the user is running in a conversation and its output so far; null while none runs. */
export const RunningSchema = union([
  nul(),
  obj({ command: str(), output: str(), excluded: bool() }),
]);
export type Running = Static<typeof RunningSchema>;

/**
 * What an owner's agent loads besides its tools: whether the layer has instructions, the paths of the project's
 * instruction files in the workspace, the skills, the MCP servers.
 */
export const LoadedSchema = obj({
  instructions: bool(),
  projectInstructions: arr(str()),
  skills: arr(str()),
  mcpServers: arr(str()),
});
export type Loaded = Static<typeof LoadedSchema>;

/**
 * A line about one conversation, for picking one to resume: times in milliseconds since the epoch. `running` while its
 * agent answers, `failed` when its latest answer stopped on an error, `seen` when its owner last saw it (0 for never),
 * so one modified since is unread.
 */
export const SummarySchema = obj({
  id: num(),
  name: str(),
  first: str(),
  messages: num(),
  created: num(),
  modified: num(),
  running: bool(),
  failed: bool(),
  pinned: bool(),
  archived: bool(),
  seen: num(),
});
export type Summary = Static<typeof SummarySchema>;
const Summaries = arr(SummarySchema);

/** A model the owner's agent can use now, with what a client shows to pick it. */
export const ModelChoiceSchema = obj({
  provider: str(),
  modelId: str(),
  name: str(),
  contextWindow: num(),
  images: bool(),
  thinkingLevels: arr(str()),
});
/** The models the owner can use now, those whose providers have credentials, and the one a new conversation takes. */
export const ModelChoicesSchema = obj({ models: arr(ModelChoiceSchema), current: union([ModelArgs, nul()]) });
export type ModelChoices = Static<typeof ModelChoicesSchema>;

/** An owner's conversations. */
const ConversationsSpec = {
  version: 2,
  params: {},
  hostAddress: () => AgentHost({}),
  variants: {
    owner: {
      state: { ids: arr(num()) },
      methods: {
        create: method(undefined, num()) as Query<undefined, NumberSchema>,
        /** Asks the workspace, so it is not part of the list's state, which would start a workspace just to list. */
        loaded: method(undefined, LoadedSchema) as Query<undefined, typeof LoadedSchema>,
        fork: method(ForkArgs, num()) as Query<typeof ForkArgs, NumberSchema>,
        summaries: method(undefined, Summaries) as Query<undefined, typeof Summaries>,
        /** Asked anew each time, so a credential set a moment ago shows its provider's models. */
        models: method(undefined, ModelChoicesSchema) as Query<undefined, typeof ModelChoicesSchema>,
      },
    },
  },
} as const;
export const Conversations = remote("chopin.conversations", ConversationsSpec);

/**
 * One conversation: its durable view (transcript, live generation, inbox, usage), what it may do, and how the
 * submissions made through it ended, keyed by the id `submit` returned.
 */
const ConversationSpec = {
  version: 2,
  params: { conversation: int() },
  hostAddress: () => AgentHost({}),
  variants: {
    owner: {
      state: {
        view: unknown(),
        mode: ModeSchema,
        name: str(),
        submissions: map(SubmissionSchema),
        running: RunningSchema,
      },
      methods: {
        submit: method(SubmitArgs, num()) as Query<typeof SubmitArgs, NumberSchema>,
        /** Runs to the command's end, which may take long; `stopCommand` ends it sooner. */
        shell: method(ShellArgs) as Call<typeof ShellArgs>,
        stopCommand: method(NoArgs) as Call<typeof NoArgs>,
        /** The whole conversation as transcript lines, what compaction took from the view included. */
        transcript: method(NoArgs, arr(unknown())) as Query<typeof NoArgs, Schema<unknown[]>>,
        /** Raw durable history, including ancestors and entries outside the live window. */
        entries: method(EntriesArgs, EntriesPageSchema) as Query<typeof EntriesArgs, typeof EntriesPageSchema>,
        /** Takes back every message still queued, answering with their texts in the order they were sent. */
        withdraw: method(NoArgs, Texts) as Query<typeof NoArgs, typeof Texts>,
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
        resubmit: method(ResubmitArgs, num()) as Query<typeof ResubmitArgs, NumberSchema>,
        /** Starts the model on a fresh context, with a note to carry over if given; the transcript keeps everything. */
        reset: method(ResetArgs) as Call<typeof ResetArgs>,
        abort: method(NoArgs) as Call<typeof NoArgs>,
        setMode: method(ModeArgs) as Call<typeof ModeArgs>,
        setModel: method(ModelArgs) as Call<typeof ModelArgs>,
        setName: method(NameArgs) as Call<typeof NameArgs>,
        setPinned: method(PinnedArgs) as Call<typeof PinnedArgs>,
        setArchived: method(ArchivedArgs) as Call<typeof ArchivedArgs>,
        /** Marks the conversation seen as it stands now. */
        markSeen: method(NoArgs) as Call<typeof NoArgs>,
        /** What the client shows its user now, such as the page they are on; the model reads it before each request. */
        setContext: method(ContextArgs) as Call<typeof ContextArgs>,
        setThinking: method(ThinkingArgs) as Call<typeof ThinkingArgs>,
        compact: method(CompactArgs) as Call<typeof CompactArgs>,
      },
    },
  },
} as const;
export const Conversation = remote("chopin.conversation", ConversationSpec);

const AuthTypeSchema = union([lit("api_key"), lit("oauth")]);
/** A provider the owner holds a credential for, and its kind; never the secret. */
export const CredentialSchema = obj({ provider: str(), type: AuthTypeSchema });
export type CredentialInfo = Static<typeof CredentialSchema>;
const CredentialList = arr(CredentialSchema);
const KeyArgs = obj({ provider: str({ min: 1 }), key: str({ min: 1 }) });
const ProviderArgs = obj({ provider: str({ min: 1 }) });

/** A way to sign in to a provider: its own sign-in, which a subscription may back, or an API key entered once. */
export const LoginWaySchema = obj({ type: AuthTypeSchema, name: str(), subscription: bool() });
/**
 * A provider the owner's models know, each way a client can sign in to it, and the hosts its models are reached at,
 * so an integrator that limits where the service connects can admit them.
 */
export const ProviderEntrySchema = obj({ id: str(), name: str(), ways: arr(LoginWaySchema), hosts: arr(str()) });
export type ProviderEntry = Static<typeof ProviderEntrySchema>;
const ProviderList = arr(ProviderEntrySchema);

/** A point-in-time view of this owner's model connections and usable configured models. */
export const ModelSettingsSchema = obj({
  providers: ProviderList,
  credentials: CredentialList,
  models: arr(ModelChoiceSchema),
  execution: union([ModelArgs, nul()]),
  review: union([ModelArgs, nul()]),
});
export type ModelSettings = Static<typeof ModelSettingsSchema>;

/** News from a login as the provider gives it: a page to open, a code to enter on any device, a note, or progress. */
export const LoginEventSchema = union([
  obj({ type: lit("auth_url"), url: str(), instructions: opt(str()) }),
  obj({ type: lit("device_code"), userCode: str(), verificationUri: str(), expiresInSeconds: opt(num()) }),
  obj({ type: lit("info"), message: str(), links: opt(arr(obj({ url: str(), label: opt(str()) }))) }),
  obj({ type: lit("progress"), message: str() }),
]);
export type LoginEvent = Static<typeof LoginEventSchema>;
/** What a login asks the owner now, answered by its `id`: a `select` with an option's id, the others with text. */
export const LoginPromptSchema = obj({
  id: num(),
  type: union([lit("text"), lit("secret"), lit("select"), lit("manual_code")]),
  message: str(),
  placeholder: opt(str()),
  options: opt(arr(obj({ id: str(), label: str(), description: opt(str()) }))),
});
export type LoginPrompt = Static<typeof LoginPromptSchema>;
/** The owner's latest login: running, with what it said and what it asks now, or how it ended. */
export const LoginSchema = obj({
  id: num(),
  provider: str(),
  type: AuthTypeSchema,
  status: union([lit("running"), lit("done"), lit("failed"), lit("cancelled")]),
  events: arr(LoginEventSchema),
  prompt: opt(LoginPromptSchema),
  error: opt(str()),
});
export type LoginState = Static<typeof LoginSchema>;
const LoginArgs = obj({ provider: str({ min: 1 }), type: AuthTypeSchema });
const LoginAnswerArgs = obj({ prompt: num(), value: str() });
const LoginIdArgs = obj({ login: num() });

/**
 * The credentials an owner's agent reaches models with, where clients may set them, by a key or by a provider's own
 * login, which the service runs and every client of the owner follows. Secrets only ever travel to the service, which
 * keeps each where it keeps that owner's credentials.
 */
const CredentialsV2Spec = {
  version: 2,
  params: {},
  hostAddress: () => AgentHost({}),
  variants: {
    owner: {
      state: { providers: CredentialList, login: union([LoginSchema, nul()]) },
      methods: {
        setKey: method(KeyArgs) as Call<typeof KeyArgs>,
        remove: method(ProviderArgs) as Call<typeof ProviderArgs>,
        /** Every provider the owner's models know, and how a client signs in to each. */
        catalog: method(undefined, ProviderList) as Query<undefined, typeof ProviderList>,
        /** Starts signing in to `provider` the `type` way, ending a login still running; resolves the new login's id. */
        startLogin: method(LoginArgs, num()) as Query<typeof LoginArgs, NumberSchema>,
        /** Answers what the running login asks, by the prompt's id. */
        answer: method(LoginAnswerArgs) as Call<typeof LoginAnswerArgs>,
        /** Ends the login `login` while it runs, keeping nothing it got. */
        cancelLogin: method(LoginIdArgs) as Call<typeof LoginIdArgs>,
      },
    },
  },
} as const;
const snapshotMethod: Query<undefined, typeof ModelSettingsSchema> = method(undefined, ModelSettingsSchema);
const PersonalCredentialChangeArgs = obj({ operationId: str({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }) });
const applyPersonalCredentialChange: Call<typeof PersonalCredentialChangeArgs> = method(PersonalCredentialChangeArgs);
type CredentialsVariants = {
  readonly owner: {
    readonly state: typeof CredentialsV2Spec.variants.owner.state;
    readonly methods: typeof CredentialsV2Spec.variants.owner.methods & {
      readonly snapshot: Query<undefined, typeof ModelSettingsSchema>;
      readonly applyPersonalCredentialChange: Call<typeof PersonalCredentialChangeArgs>;
    };
  };
};
type CredentialsDeclaration = Omit<typeof CredentialsV2Spec, "version" | "variants"> & {
  readonly version: 3;
  readonly variants: CredentialsVariants;
};
const CredentialsSpec: CredentialsDeclaration = {
  ...CredentialsV2Spec,
  version: 3,
  variants: {
    owner: {
      ...CredentialsV2Spec.variants.owner,
      methods: { ...CredentialsV2Spec.variants.owner.methods, snapshot: snapshotMethod, applyPersonalCredentialChange },
    },
  },
};
type CredentialsContract = Contract<{
  kind: "remote";
  name: "chopin.credentials";
  params: typeof CredentialsSpec.params;
  history: [
    { version: "2"; variants: typeof CredentialsV2Spec.variants; changes: never },
    { version: "3"; variants: CredentialsVariants; changes: readonly ["owner", "snapshot" | "applyPersonalCredentialChange", "args" | "result"] },
  ];
}>;
export const Credentials: CredentialsContract = evolve(remote("chopin.credentials", CredentialsV2Spec),
  (edit) => edit.addMethod("owner", "snapshot", snapshotMethod.args, snapshotMethod.result)
    .addMethod("owner", "applyPersonalCredentialChange", applyPersonalCredentialChange.args, applyPersonalCredentialChange.result));

const SubscriptionProvider = union([lit("qwen"), lit("openai-codex")]);
const SubscriptionMode = union([lit("connect"), lit("switch_account")]);
const SubscriptionAttemptStatus = union([lit("waiting"), lit("authorized"), lit("cancelled"), lit("expired"), lit("failed")]);
const SubscriptionAccountStatus = union([lit("signed_in"), lit("signed_out"), lit("unknown")]);
const SubscriptionEntitlement = union([lit("eligible"), lit("ineligible"), lit("unknown")]);
const SubscriptionAttempt = obj({
  id: str(), provider: SubscriptionProvider, mode: SubscriptionMode, status: SubscriptionAttemptStatus, challengeAvailable: bool(),
});
const SubscriptionAccount = obj({
  provider: SubscriptionProvider, status: SubscriptionAccountStatus, accountLabel: opt(str()), plan: opt(str()),
  entitlement: opt(SubscriptionEntitlement),
});
const SubscriptionSnapshot = obj({
  providers: arr(obj({ id: SubscriptionProvider, name: str() })),
  attempts: arr(SubscriptionAttempt), accounts: arr(SubscriptionAccount),
});
export type SubscriptionProviderId = Static<typeof SubscriptionProvider>;
export type SubscriptionSignInMode = Static<typeof SubscriptionMode>;
export type SubscriptionSignInAttempt = Static<typeof SubscriptionAttempt>;
export type SubscriptionSignInAccount = Static<typeof SubscriptionAccount>;
export type SubscriptionSignInSnapshot = Static<typeof SubscriptionSnapshot>;

const SubscriptionStart = obj({ provider: SubscriptionProvider, mode: SubscriptionMode });
const SubscriptionAttemptId = obj({ attemptId: str({ min: 1 }) });
const SubscriptionDisconnect = obj({ provider: SubscriptionProvider });
const SubscriptionChallenge = obj({ attemptId: str({ min: 1 }), operationId: str({ min: 1 }) });
const SubscriptionsSpec = {
  version: 1, params: {}, hostAddress: () => AgentHost({}),
  variants: { owner: { state: {}, methods: {
    subscriptionSnapshot: method(undefined, SubscriptionSnapshot) as Query<undefined, typeof SubscriptionSnapshot>,
    startSubscriptionSignIn: method(SubscriptionStart, SubscriptionAttemptId) as Query<typeof SubscriptionStart, typeof SubscriptionAttemptId>,
    cancelSubscriptionSignIn: method(SubscriptionAttemptId) as Call<typeof SubscriptionAttemptId>,
    disconnectSubscription: method(SubscriptionDisconnect) as Call<typeof SubscriptionDisconnect>,
    deliverSubscriptionChallenge: method(SubscriptionChallenge) as Call<typeof SubscriptionChallenge>,
  } } },
} as const;
/** Public account status and operation IDs. The device challenge is delivered privately to the host. */
export const Subscriptions = remote("chopin.subscriptions", SubscriptionsSpec);

/** An MCP server a client set, and how many tools it offers, or why it offers none yet; never its headers. */
export const McpServerSchema = obj({ name: str(), url: str(), tools: num(), error: opt(str()) });
export type McpServerState = Static<typeof McpServerSchema>;
const McpServerName = str({ pattern: "^[A-Za-z0-9_-]{1,32}$" });
const McpArgs = obj({ name: McpServerName, url: str({ min: 1 }), headers: opt(map(str())) });
const McpNameArgs = obj({ name: McpServerName });

/**
 * The MCP servers an owner's clients set, on top of the layer's: kept in memory alone, headers and all, so a client
 * sets them again once the service restarts, except that a sealed service keeps them, encrypted at rest. Setting one
 * by a name already set replaces it, its headers included.
 */
const McpSpec = {
  version: 2,
  params: {},
  hostAddress: () => AgentHost({}),
  variants: {
    owner: {
      state: { servers: arr(McpServerSchema) },
      methods: {
        set: method(McpArgs) as Call<typeof McpArgs>,
        remove: method(McpNameArgs) as Call<typeof McpNameArgs>,
      },
    },
  },
} as const;
export const Mcp = remote("chopin.mcp", McpSpec);

const VariableName = str({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" });
const VariableArgs = obj({ name: VariableName, value: str() });
const VariableNameArgs = obj({ name: VariableName });

/**
 * Variables every command the owner's agent runs gets, such as a credential for a host its tools reach, which so reaches
 * the commands without passing through a conversation: kept in memory alone, so a client sets them again once the
 * service restarts. Setting one by a name already set replaces it; the state names them, never their values.
 */
const EnvironmentSpec = {
  version: 2,
  params: {},
  hostAddress: () => AgentHost({}),
  variants: {
    owner: {
      state: { names: arr(str()) },
      methods: {
        set: method(VariableArgs) as Call<typeof VariableArgs>,
        remove: method(VariableNameArgs) as Call<typeof VariableNameArgs>,
      },
    },
  },
} as const;
export const Environment = remote("chopin.environment", EnvironmentSpec);

/** The key a sealed service opens with, as `serviceKey` derives it from the owner's data key: 32 bytes in base64url. */
const UnlockArgs = obj({ key: str({ pattern: "^[A-Za-z0-9_-]{43}$" }) });

/**
 * Whether the service waits for its key. A sealed service keeps everything of its owner's encrypted at rest and opens
 * none of it before a client unlocks it, serving nothing else until then; any other service is never locked.
 */
const VaultSpec = {
  version: 2,
  params: {},
  hostAddress: () => AgentHost({}),
  variants: {
    owner: {
      state: { locked: bool() },
      methods: {
        /** Refused with `wrong_key` for any key but the one the service was first unlocked with; harmless once open. */
        unlock: method(UnlockArgs) as Call<typeof UnlockArgs>,
      },
    },
  },
} as const;
export const Vault = remote("chopin.vault", VaultSpec);

/** Opens a sealed service with the owner's data key unless it is open already, waiting no longer than one call. */
export function unlock(host: Client, key: DataKey, options: CallOptions = {}): Promise<void> {
  return within(options, async (signal) => {
    const vault = await host.get(Vault, {}, { signal, timeoutMs: Infinity });
    try {
      if (!vault.locked.value) return;
      const derived = await serviceKey(key);
      await host.root((ctx) => vault.unlock({ key: derived }, ctx), { signal, timeoutMs: Infinity });
    } finally {
      vault.release();
    }
  });
}

/** Where the RSI loop stands: the layer version in use, the failures it knows, what waits for the owner, what it spent. */
export const LoopStandingSchema = obj({
  version: num(),
  inUse: num(),
  archived: num(),
  kinds: num(),
  recurring: num(),
  shelved: num(),
  corrections: num(),
  held: num(),
  spentUsd: num(),
  weeklyBudgetUsd: union([num(), nul()]),
});
/** A change the loop kept, archived or in use. */
export const LoopChangeSchema = obj({ id: str(), added: str(), kind: str(), archived: bool(), text: str() });
/** A kind of correction the owner made in enough sessions to be asked whether the loop learns from it. */
export const CorrectionKindSchema = obj({ key: str(), sessions: num(), examples: arr(str()) });
/** A change the audit held for the owner to approve, which is still tested before it is kept, or refuse. */
export const HeldChangeSchema = obj({
  id: str(),
  failure: str(),
  kind: str(),
  skill: opt(str()),
  text: str(),
  prediction: str(),
  reasons: arr(str()),
});
/** How the loop runs: none runs without a weekly budget; models as `provider/model`. */
export const LoopSettingsSchema = obj({
  weeklyBudgetUsd: union([num({ min: 0 }), nul()]),
  regularModel: union([str({ min: 1 }), nul()]),
  strongModel: union([str({ min: 1 }), nul()]),
  holdForReview: bool(),
});
export type LoopStanding = Static<typeof LoopStandingSchema>;
export type LoopChange = Static<typeof LoopChangeSchema>;
export type CorrectionKind = Static<typeof CorrectionKindSchema>;
export type HeldChange = Static<typeof HeldChangeSchema>;
export type LoopSettings = Static<typeof LoopSettingsSchema>;
const LoopChanges = arr(LoopChangeSchema);
const CorrectionKinds = arr(CorrectionKindSchema);
const HeldChanges = arr(HeldChangeSchema);
const SettingsChange = obj({
  weeklyBudgetUsd: opt(union([num({ min: 0 }), nul()])),
  regularModel: opt(union([str({ min: 1 }), nul()])),
  strongModel: opt(union([str({ min: 1 }), nul()])),
  holdForReview: opt(bool()),
});
const UndoArgs = obj({ id: str({ min: 1 }) });
const AnswerArgs = obj({ key: str({ min: 1 }), learn: bool() });
const DecideArgs = obj({ id: str({ min: 1 }), approve: bool() });

/**
 * The owner's RSI loop: what it learned and spent, and the decisions it waits on. Only clients reach it; the agent
 * has no tool for it, so it never approves its own changes.
 */
const LoopSpec = {
  version: 2,
  params: {},
  hostAddress: () => AgentHost({}),
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
} as const;
export const Loop = remote("chopin.loop", LoopSpec);

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

/** Runs `work` against the service, failing with `CallTimeout` once it has waited too long for an answer. */
export function call<T>(host: Client, work: (ctx: Ctx) => Promise<T>, options: CallOptions = {}): Promise<T> {
  return host.root(work, options);
}

export type ConversationRef = Reference<typeof Conversation>;

/** One conversation of the service, held until released, waited for as long as a call. */
export function openConversation(host: Client, conversation: number, options: CallOptions = {}): Promise<ConversationRef> {
  return host.get(Conversation, { conversation }, options);
}

/**
 * The owner's list of conversations as one client holds it: opened when first needed and again once it ended, one
 * open at a time and each bounded as a call; once released, a list still being opened is let go as it arrives.
 */
export interface HeldList {
  /** The list, waited for no longer than `signal` allows; an open under way goes on for whoever asks next. */
  get(signal?: AbortSignal): Promise<Reference<typeof Conversations>>;
  release(): void;
}

export function heldList(host: Client, options: CallOptions = {}): HeldList {
  let held: Reference<typeof Conversations> | undefined;
  let opening: Promise<Reference<typeof Conversations>> | undefined;
  let released = false;
  return {
    get: (signal) => {
      if (released) return Promise.reject(new Error("the list was released"));
      if (held !== undefined && held.state.value.kind !== "ended") return Promise.resolve(held);
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
  host: Client,
  list: (signal: AbortSignal) => Promise<Reference<typeof Conversations>>,
  options: CallOptions = {},
): Promise<{ id: number; conversation: ConversationRef }> {
  // Two calls, so a link lost after the conversation was made opens it rather than making another; together they
  // wait no longer than one.
  const started = Date.now();
  const id = await within(options, async (signal) => {
    const conversations = await list(signal);
    return host.root((ctx) => conversations.create(ctx), { signal, timeoutMs: Infinity });
  });
  const left = Math.max(0, (options.timeoutMs ?? CALL_TIMEOUT_MS) - (Date.now() - started));
  return { id, conversation: await openConversation(host, id, { ...options, timeoutMs: left }) };
}

/** The owner's list of conversations, held until released, waited for as long as a call. */
export function openConversations(host: Client, options: CallOptions = {}): Promise<Reference<typeof Conversations>> {
  return host.get(Conversations, {}, options);
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
export function endText(ref: { readonly state: { readonly value: RefState } }): string {
  const state = ref.state.value;
  return state.kind === "ended" ? errorText(state.error) : state.kind === "failed" ? errorText(state.cause.error) : state.kind;
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

type ContractExport = {
  readonly type: Contract;
  readonly spec: typeof GoalsSpec | typeof GoalSpec | typeof ConversationsSpec | typeof ConversationSpec |
    typeof CredentialsSpec | typeof SubscriptionsSpec | typeof McpSpec | typeof EnvironmentSpec | typeof VaultSpec | typeof LoopSpec;
};

/** Application-owned declarations used by native clients and compatibility checks. */
export const contracts: readonly ContractExport[] = [
  { type: Goals, spec: GoalsSpec },
  { type: Goal, spec: GoalSpec },
  { type: Conversations, spec: ConversationsSpec },
  { type: Conversation, spec: ConversationSpec },
  { type: Credentials, spec: CredentialsSpec },
  { type: Subscriptions, spec: SubscriptionsSpec },
  { type: Mcp, spec: McpSpec },
  { type: Environment, spec: EnvironmentSpec },
  { type: Vault, spec: VaultSpec },
  { type: Loop, spec: LoopSpec },
] as const;
