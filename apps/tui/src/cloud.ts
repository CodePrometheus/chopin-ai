import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT as context, type Context } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { AgentService, CommandJobs, CommandPolicySchema, JobIdSchema, launchToken, listen, openEncryptedStore, verifyPublishedArtifact, type GoalOptions, type Listening } from "@chopin-ai/harness-pi";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ControlConfigurationSchema, ControlHost } from "./control.js";
import { hostedModels, hostedProviderAllowed } from "./hosted-models.js";
import { InitializationConfigurationSchema } from "./initialize-command.js";
import { JobClient, JobsConfigurationSchema } from "./jobs.js";
import { PersonalCredentials } from "./personal-credentials.js";
import { personalModels } from "./personal-models.js";
import { SubscriptionSignInRuntime } from "./subscription-sign-in.js";
import { Vault } from "./vault.js";

const text = Type.String({ minLength: 1 });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const model = Type.Object({ provider: text, modelId: text }, { additionalProperties: false });
export const CloudConfigurationSchema = Type.Object({
  version: Type.Literal(1), purpose: Type.Literal("execution"), keySource: Type.Union([Type.Literal("provided"), Type.Literal("custody")]), volume: text, home: text,
  control: ControlConfigurationSchema,
  jobs: Type.Optional(Type.Object({ transport: JobsConfigurationSchema, domain: JobIdSchema, cwd: text, policyRevision: text, inheritEnv: Type.Boolean(), policy: CommandPolicySchema }, { additionalProperties: false })),
  storage: InitializationConfigurationSchema.properties.storage,
  server: Type.Object({ port: Type.Integer({ minimum: 0, maximum: 65535 }), hostname: Type.Optional(text) }, { additionalProperties: false }),
  model: Type.Optional(model), reviewModel: Type.Optional(model), personalModels: Type.Optional(Type.Boolean()), subscriptionSignIn: Type.Optional(Type.Boolean()),
  subscriptionProviders: Type.Optional(Type.Array(Type.Literal("qwen"), { maxItems: 1 })), goalRetryAfterMs: positive,
  vaultSyncMs: Type.Integer({ minimum: 1, maximum: 0x7fff_ffff }),
}, { additionalProperties: false });
export type CloudConfiguration = Static<typeof CloudConfigurationSchema>;
export interface CloudSecrets { controlToken: string; jobToken?: string; launchToken: string; serviceKey?: Uint8Array; }
export interface CloudDependencies {
  /** Called only after the existing encrypted store and trusted freshness have been verified. */
  models(home: string, catalogOnly: boolean): Promise<Models>;
  /** Trusted embedding hosts may provide an independent verifier; the CLI uses the configured model. */
  review?: GoalOptions["review"];
  report(error: unknown): void;
}
export interface CloudRuntime { service: AgentService; server: Listening; close(): Promise<void>; }

/** Runs one already admitted cloud execution instance; initialization and resource supply belong to its host. */
export async function openCloudRuntime(configuration: CloudConfiguration, secrets: CloudSecrets, dependencies: CloudDependencies): Promise<CloudRuntime> {
  const config = structuredClone(configuration);
  if (!Value.Check(CloudConfigurationSchema, config)) throw new Error("the cloud runtime configuration does not satisfy its versioned contract");
  if (config.personalModels === true && URL.parse(config.control.url)?.protocol !== "https:") {
    throw new Error("personal model credential claims require a trusted HTTPS endpoint");
  }
  if (config.subscriptionSignIn === true && config.personalModels !== true) {
    throw new Error("hosted subscription sign-in requires the personal model runtime");
  }
  if ((config.subscriptionProviders?.length ?? 0) !== 0 && config.subscriptionSignIn !== true) {
    throw new Error("an enabled subscription provider requires hosted subscription sign-in");
  }
  const selection = config.model === undefined || config.reviewModel === undefined ? undefined
    : { execution: config.model, review: config.reviewModel };
  if ((config.model === undefined) !== (config.reviewModel === undefined) || selection === undefined && config.personalModels === true) {
    throw new Error("cloud execution and review models must be configured together");
  }
  const selected = selection === undefined ? [] : [selection.execution, selection.review];
  if (selected.some(({ provider }) => !hostedProviderAllowed(provider))) {
    throw new Error("the configured model provider is not available for hosted execution or review");
  }
  const jobs = config.jobs;
  if ((selection === undefined) !== (jobs === undefined)) throw new Error("command jobs are required only with background models");
  if (jobs !== undefined && (jobs.transport.scopeId !== config.control.agentId || !secrets.jobToken)) {
    throw new Error("the command and control bindings must name the same agent and authorize its jobs");
  }
  for (const path of [config.volume, config.home]) if (!isAbsolute(path)) throw new Error("cloud runtime locations must be absolute");
  separate(resolve(config.volume), resolve(config.home));
  if (secrets.launchToken === "" || (config.keySource === "provided" ? secrets.serviceKey?.length !== 32 : secrets.serviceKey !== undefined)) throw new Error("the runtime requires its configured key source and a launch credential");
  let key: Buffer | undefined = secrets.serviceKey === undefined ? undefined : Buffer.from(secrets.serviceKey); secrets.serviceKey?.fill(0);
  let control: ControlHost | undefined; let broker: JobClient | undefined; let vault: Vault | undefined;
  let credentials: PersonalCredentials | undefined;
  let subscriptions: SubscriptionSignInRuntime | undefined;
  let storage: Awaited<ReturnType<typeof openEncryptedStore>> | undefined;
  let service: AgentService | undefined; let server: Listening | undefined;
  let admitted = false; let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const failures: unknown[] = [];
    for (const action of [() => server?.close(), () => service?.close(context), () => subscriptions?.close(), () => credentials?.close(), () => storage?.close(context), () => admitted ? vault?.close() : undefined, () => broker?.close(), () => control?.close()]) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    key?.fill(0);
    if (failures.length > 0) throw new AggregateError(failures, "the cloud runtime could not close every resource");
  })();
  try {
    control = await ControlHost.connect(config.control, secrets.controlToken);
    const anchor = control.anchors();
    if (await anchor.read() === undefined) throw new Error("cloud execution requires an already initialized freshness record");
    if (config.keySource === "custody") key = (await control.executionKey()).key;
    if (key === undefined) throw new Error("the runtime key source did not release a key");
    await mkdir(config.home, { recursive: true, mode: 0o700 });
    separate(await realpath(config.volume), await realpath(config.home));
    vault = await Vault.openExisting(config.volume, config.home, key);
    const protectedStore = vault.store;
    try { storage = await openEncryptedStore({ ...config.storage, ...protectedStore, anchor }); }
    finally { protectedStore.key.fill(0); }
    const owner = config.control.owner;
    const authorizeOwner = async (ctx?: Context) => (await control!.authorize({ action: "owner" }, ctx?.abortSignal)).allowed;
    if (config.subscriptionSignIn === true) {
      subscriptions = new SubscriptionSignInRuntime(
        join(config.home, "subscription-profiles"), config.volume, key,
        JSON.stringify([config.control.agentId, owner]), config.subscriptionProviders ?? [],
        () => vault!.sync(), authorizeOwner, dependencies.report,
      );
    }
    const signIn = subscriptions;
    const catalog = selection === undefined ? createModels({ authContext: { env: async () => undefined, fileExists: async () => false } })
      : hostedModels(await dependencies.models(config.home, config.personalModels === true));
    if (config.personalModels === true) {
      credentials = new PersonalCredentials(join(config.volume, "personal-credentials"), key, config.control.agentId, owner);
    } else {
      for (const model of selected) if (catalog.getModel(model.provider, model.modelId) === undefined) throw new Error("a configured execution or review model is not available");
    }
    const personal = credentials;
    const models = personal === undefined ? catalog : personalModels(catalog, signIn === undefined ? selected : [], personal);
    if (jobs !== undefined) broker = await JobClient.connect(jobs.transport, secrets.jobToken!);
    const requireOwner = (given: string) => { if (given !== owner) throw new Error("this cloud runtime belongs to another execution owner"); };
    let commands: CommandJobs | undefined;
    service = new AgentService({
      dataDir: join(config.home, "execution"), startPaused: true, allowClientMcp: false,
      store: async (given) => { requireOwner(given); return storage!; },
      models: (given) => { requireOwner(given); return models; },
      ...(personal !== undefined && selection !== undefined && {
        credentials: (given: string) => { requireOwner(given); return personal; },
        personalModelSettings: (given: string) => {
          requireOwner(given);
          return {
            execution: selection.execution,
            review: selection.review,
            authorize: authorizeOwner,
            claim: (operationId: string, ctx: Context) => control!.claimPersonalCredentialChange(operationId, ctx.abortSignal),
          };
        },
      }),
      ...(signIn !== undefined && {
        subscriptionSignIn: (given: string) => {
          requireOwner(given);
          return {
            authorize: authorizeOwner,
            snapshot: () => signIn.snapshot(),
            start: signIn.start.bind(signIn),
            cancel: signIn.cancel.bind(signIn),
            disconnect: signIn.disconnect.bind(signIn),
            deliver: (attemptId: string, operationId: string, ctx: Context) =>
              signIn.deliver(attemptId, (challenge) => control!.deliverSubscriptionChallenge(attemptId, operationId, challenge, ctx.abortSignal)),
          };
        },
      }),
      extensions: (given) => {
        requireOwner(given);
        if (jobs === undefined) return [];
        commands = new CommandJobs({ broker: broker!, policy: jobs.policy, report: dependencies.report, prepare: async (api, ctx) => ({
          goal: await (await service!.goals(owner)).forExecution(api.conversationId, ctx),
          domain: jobs.domain, cwd: jobs.cwd, policyRevision: jobs.policyRevision, inheritEnv: jobs.inheritEnv,
        }) });
        return [commands.extension];
      },
      agent: async (given) => {
        requireOwner(given);
        return { model: selection?.execution ?? null, ...(jobs !== undefined && { cwd: jobs.cwd }), extensions: commands === undefined ? [] : [commands.extension] };
      },
      goals: (given) => {
        requireOwner(given);
        return {
          authorize: async (request, ctx) => selection === undefined && request.action !== "owner"
            ? { allowed: false, reason: "this workspace has no configured execution and review models" }
            : control!.authorize(request, ctx.abortSignal),
          review: selection === undefined ? {} : (personal === undefined ? dependencies.review : undefined) ?? { model: selection.review },
          settled: async (goal, ctx) => {
            if (commands === undefined) throw new Error("this workspace has no configured command reconciliation");
            return commands.settled((await service!.goals(owner)).store, goal, ctx);
          },
          artifact: async (goal, artifact, sourceTaskId, ctx) => verifyPublishedArtifact((await service!.goals(owner)).store, goal.goalId, artifact, sourceTaskId, ctx),
          retryAfterMs: config.goalRetryAfterMs, report: dependencies.report,
        };
      },
      onWake: (given, wake) => { requireOwner(given); return control!.publishWake(wake); },
      persist: () => vault!.sync(), report: dependencies.report,
    });
    await service.goals(owner);
    server = await listen(service, { ...config.server, authenticate: launchToken(secrets.launchToken, owner) });
    admitted = true;
    vault.keepSynced(config.vaultSyncMs, dependencies.report);
    return { service, server, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "cloud startup failed and cleanup is uncertain"); }
    throw error;
  }
}

function separate(volume: string, home: string): void {
  if (volume === home || volume.startsWith(`${home}${sep}`) || home.startsWith(`${volume}${sep}`)) throw new Error("the sealed volume and restored home must be separate locations");
}
